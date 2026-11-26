/**
 * 数据库层：schema + 打开 + 轻量辅助。
 *
 * 依赖 Node 内置的 `node:sqlite`（Node ≥ 22.5，DSH 自带 v24），因此整个插件
 * **零 npm 运行时依赖**，也不需要 node-gyp 编译。
 *
 * 三个数据库文件互相独立：
 *   dsh.db   DSH 会话记忆（本插件主力）
 *   qq.db    QQ 聊天记忆（由 spool 投递入，可选）
 * 分开是刻意的：任一库损坏 / 清空都不影响另一个。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DSH_DB = 'dsh.db';
export const QQ_DB = 'qq.db';

const SCHEMA = `
-- ── 元数据 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 会话清单 + 双维度策略（写入 / 读取）─────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  workspace        TEXT,
  workspace_label  TEXT,
  title            TEXT,
  created_at       INTEGER,
  last_seen_at     INTEGER,
  event_count      INTEGER NOT NULL DEFAULT 0,
  store_mode       TEXT NOT NULL DEFAULT 'inherit',   -- inherit | store | skip
  store_changed_at INTEGER,
  read_mode        TEXT NOT NULL DEFAULT 'inherit',   -- inherit | off | own | all
  read_changed_at  INTEGER,
  note             TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_ws ON sessions(workspace);

CREATE TABLE IF NOT EXISTS workspace_policy (
  workspace     TEXT PRIMARY KEY,
  store_default TEXT NOT NULL DEFAULT 'skip',         -- store | skip（默认不存）
  read_default  TEXT NOT NULL DEFAULT 'off'            -- off | own | all（默认不读）
);

CREATE TABLE IF NOT EXISTS global_policy (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 物化后的生效策略：运行时与 UI 都读这张，避免每次三级解析
CREATE TABLE IF NOT EXISTS session_policy_effective (
  session_id    TEXT PRIMARY KEY,
  store         INTEGER NOT NULL,                     -- 0 | 1
  read_scope    TEXT NOT NULL,                        -- off | own | all | tags
  resolved_from TEXT NOT NULL,                        -- session | workspace | global
  read_tags     TEXT NOT NULL DEFAULT '[]'            -- read_scope=tags 时命中哪些标签（JSON 数组）
);

-- 会话标签：一个会话可以有多个标签，读策略里可以引用标签。
-- 用标签而不是"组"：一个会话常常同时属于多个主题，用标签不用二选一。
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

-- 置顶：把会话里的一段内容固定成「常驻记忆」，不靠检索碰运气。
-- 三种来源共用一张表：summary（整条摘要）、range（消息区间）、event（单条消息）。
CREATE TABLE IF NOT EXISTS pins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  source      TEXT NOT NULL,                          -- summary | range | event
  summary_id  INTEGER,                                -- source=summary
  seq_from    INTEGER,                                -- source=range | event
  seq_to      INTEGER,
  title       TEXT NOT NULL,                          -- 用户起的名字
  note        TEXT,                                   -- 为什么要钉它
  body        TEXT,                                   -- 落库时快照的正文（原会话被清理也能用）
  mode        TEXT NOT NULL DEFAULT 'onMatch',        -- always | onMatch | manual
  order_no    INTEGER NOT NULL DEFAULT 0,
  follow_read INTEGER NOT NULL DEFAULT 1,             -- 1=跟随该会话的「读」策略
  terms       TEXT,                                   -- 挖出来的词（JSON 数组），用于 onMatch 判定
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pins_session ON pins(session_id);
CREATE INDEX IF NOT EXISTS idx_pins_mode ON pins(mode);

-- ── 文件增量水位 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_files (
  path            TEXT PRIMARY KEY,
  session_id      TEXT,
  bytes_done      INTEGER NOT NULL DEFAULT 0,
  frames_done     INTEGER NOT NULL DEFAULT 0,
  records_seen    INTEGER NOT NULL DEFAULT 0,
  records_stored  INTEGER NOT NULL DEFAULT 0,
  records_dropped INTEGER NOT NULL DEFAULT 0,         -- 遥测事件数（可审计）
  skipped_by_policy INTEGER NOT NULL DEFAULT 0,       -- 因 store=skip 丢弃的文本记录数
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_src_session ON source_files(session_id);

-- ── 第三层：原文（只增不删，无遗忘）──────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  workspace  TEXT,
  seq        INTEGER,
  kind       TEXT NOT NULL,     -- user | assistant | reasoning | tool-call | tool-result | system | developer | compaction-summary | title
  role       TEXT,
  turn       INTEGER,
  ts         INTEGER,
  text       TEXT NOT NULL,
  meta       TEXT,
  ukey       TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

-- 内容无关（contentless）FTS：只存索引，不再重复存一份 bigram 串，省一半体积。
-- 我们不删除事件，所以不需要 contentless_delete。
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(seg, tokenize='unicode61', content='');

-- ── 第二层：摘要（粗召回，带原文区间锚点）───────────────────────────────
CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  workspace   TEXT,
  kind        TEXT NOT NULL,     -- compaction | meta
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  period_from INTEGER,
  period_to   INTEGER,
  seq_from    INTEGER,
  seq_to      INTEGER,
  hash        TEXT NOT NULL UNIQUE,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
CREATE INDEX IF NOT EXISTS idx_summaries_period ON summaries(period_from, period_to);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(seg, tokenize='unicode61', content='');

-- ── 第一层：关键词库（自动挖掘，可 pin / mute）──────────────────────────
CREATE TABLE IF NOT EXISTS terms (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  term   TEXT NOT NULL UNIQUE,
  df     INTEGER NOT NULL DEFAULT 0,   -- 出现在多少条摘要里
  pinned REAL                          -- 手动加权；非空时覆盖 idf 计算
  ,
  muted  INTEGER NOT NULL DEFAULT 0,   -- 1 = 不参与联想
  -- 'gram' = 2 字滑动窗口碎片；'word' = 词发现判出来的真词（3/4 字为主）。
  -- 两者都进倒排，检索时真词权重更高、bigram 兜底。
  kind   TEXT NOT NULL DEFAULT 'gram'
);

-- 词发现的结果。这张表是「词表」的唯一真相，索引重建必须基于它，
-- 否则每次重建切出来的词不一样、索引就错位了。
CREATE TABLE IF NOT EXISTS mined_words (
  word       TEXT PRIMARY KEY,
  freq       INTEGER NOT NULL,   -- 在语料里出现多少次
  pmi        REAL NOT NULL,      -- 内部结合紧密度
  entropy    REAL NOT NULL,      -- 左右熵，越小越像碎片
  run_id     INTEGER NOT NULL,   -- 哪一次发现跑出来的
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mwords_run ON mined_words(run_id);

-- ── 词向量（PPMI + SVD 训练出来的）────────────────────────────────────
-- vec 存 Float32Array 的裸 buffer：11742 词 × 128 维 × 4 字节 ≈ 6 MB。
-- 存 JSON 会膨胀约 8 倍，而且每次读都要解析。
CREATE TABLE IF NOT EXISTS term_vectors (
  term       INTEGER PRIMARY KEY,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terms_inv (
  term    INTEGER NOT NULL,
  summary INTEGER NOT NULL,
  w       REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (term, summary)
);
CREATE INDEX IF NOT EXISTS idx_inv_summary ON terms_inv(summary);

CREATE TABLE IF NOT EXISTS term_edges (
  a       INTEGER NOT NULL,
  b       INTEGER NOT NULL,
  hits    INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_edges_b ON term_edges(b);

-- ── 读取审计 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recall_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts         INTEGER,
  trigger    TEXT,     -- auto | tool
  query      TEXT,
  hits       TEXT,     -- JSON
  injected   INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recall_ts ON recall_log(ts);

-- ── surfcore 记忆卡镜像（只读数据源的落库副本）────────────────────────────
-- 只存"从 surfcore 文件读到的内容"，从不写回 surfcore。
-- in_card = 1 表示这条还在 surfcore 的主卡里（日常加载的那份）；
-- in_card = 0 表示主卡里已经被衰减/遗忘，但全量档案里还留着。
CREATE TABLE IF NOT EXISTS sc_records (
  id                 TEXT PRIMARY KEY,
  in_card            INTEGER NOT NULL DEFAULT 1,
  source             TEXT,
  platform           TEXT,
  scope              TEXT,
  kind               TEXT,
  title              TEXT,
  text               TEXT,
  detail             TEXT,
  tags               TEXT,     -- JSON 数组
  importance         INTEGER NOT NULL DEFAULT 0,
  importance_reasons TEXT,     -- JSON 数组
  emotional          INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  anchor             INTEGER NOT NULL DEFAULT 0,
  sensitive          INTEGER NOT NULL DEFAULT 0,
  private            INTEGER NOT NULL DEFAULT 0,
  is_self            INTEGER NOT NULL DEFAULT 0,
  clarity            TEXT,
  decay_steps        INTEGER NOT NULL DEFAULT 0,
  recall_count       INTEGER NOT NULL DEFAULT 0,
  speaker            TEXT,
  created_at         TEXT,
  last_seen_at       TEXT,
  synced_at          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sc_card ON sc_records(in_card);
CREATE INDEX IF NOT EXISTS idx_sc_kind ON sc_records(kind);
CREATE INDEX IF NOT EXISTS idx_sc_imp ON sc_records(importance);
CREATE INDEX IF NOT EXISTS idx_sc_created ON sc_records(created_at);
-- 不建 FTS：记录只有几百到几千条，LIKE/instr 全表扫在 20ms 内，
-- 而且中文子串搜索天然支持（FTS 还得做 bigram 预处理）。
`;

/**
 * 打开（并在需要时初始化）一个记忆库。
 *
 * @param {string} file 数据库文件绝对路径
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // page_size / auto_vacuum 必须在建表前设置；顺序很重要 —— page_size 要先设，
  // 否则一旦有其它 pragma 写过库头，page_size 就会被静默忽略。
  try {
    db.exec('PRAGMA page_size = 8192');
  } catch {
    // 已有库改不了，忽略
  }
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  } catch {
    // 同上
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumns(db);
  return db;
}

/**
 * 给已经存在的库补列。
 *
 * `CREATE TABLE IF NOT EXISTS` 对老库不生效 —— 表已经在了，新加的列不会出现。
 * 所以新增列必须在这里显式 ALTER，并且可重复执行（先查 PRAGMA）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureColumns(db) {
  /** @type {Array<{ table: string, column: string, ddl: string }>} */
  const wanted = [
    {
      table: 'session_policy_effective',
      column: 'read_tags',
      ddl: "ALTER TABLE session_policy_effective ADD COLUMN read_tags TEXT NOT NULL DEFAULT '[]'",
    },
    {
      // 区分「滑动窗口碎片」和「词发现出来的真词」。
      // 老库全是 bigram，默认 'gram' 正好对得上。
      table: 'terms',
      column: 'kind',
      ddl: "ALTER TABLE terms ADD COLUMN kind TEXT NOT NULL DEFAULT 'gram'",
    },
    {
      // 内容指纹（只看正文，**不含 sessionId**）。
      //
      // 为什么需要：摘要的 hash 含 sessionId，所以同一段内容（人格卡、同一份提示词）
      // 出现在 N 个会话里会入库 N 份。实测 511 条摘要里有 258 条（50.5%）正文完全相同。
      // 这导致 terms.df 虚高 1.24~1.59 倍，idf 被系统性低估。
      table: 'summaries',
      column: 'body_hash',
      ddl: 'ALTER TABLE summaries ADD COLUMN body_hash TEXT',
    },
    {
      // 按「不同内容」统计的 df —— idf 用这个，不再用虚高的 terms.df。
      // 倒排本身保持原样（每条摘要都有），否则会破坏 read_scope=own 的会话隔离。
      table: 'terms',
      column: 'df_content',
      ddl: 'ALTER TABLE terms ADD COLUMN df_content INTEGER',
    },
    {
      // 每次联想的「为什么」：种子词及权重、被挡掉的词、每条命中的分数分解。
      // 只给界面回看用，不参与检索。老记录为 NULL，界面显示「早期记录无诊断」。
      table: 'recall_log',
      column: 'diag',
      ddl: 'ALTER TABLE recall_log ADD COLUMN diag TEXT',
    },
  ];
  for (const w of wanted) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${w.table})`).all().map((r) => r.name);
      if (!cols.includes(w.column)) db.exec(w.ddl);
    } catch {
      // 补列失败不要影响主流程，后续读不到就当空
    }
  }
}

/** 读取 meta 键。 */
export function metaGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

/** 写入 meta 键。 */
export function metaSet(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/**
 * 在单个事务里执行一段逻辑。
 * 注意：node:sqlite 是同步 API，这里不用 async。
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败也不能掩盖原始错误
    }
    throw error;
  }
}

/**
 * 解析数据目录下的两个库路径。
 * @param {string} dataDir
 * @returns {{ dsh: string, qq: string }}
 */
export function dbPaths(dataDir) {
  return {
    dsh: join(dataDir, DSH_DB),
    qq: join(dataDir, QQ_DB),
  };
}
