/**
 * 核心门面：把「打开库 / 导入 / 检索 / 统计 / 策略 / 迁移」收成一个类。
 *
 * 这个文件**不 import 任何 @deepseek-ai/* 包**，所以可以脱离 DSH 单独跑
 * （scripts/smoke.js 和 test/ 就是这么用的）。插件入口 src/index.js 只是在它
 * 外面套了一层 DSH 的壳。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, dbPaths, DSH_DB, metaGet, metaSet } from './db.js';
import { importAllSessions, consumeSpool, discoverSessions, findSessionFiles, importSessionFile } from './ingest.js';
import { gate, openSummary, searchEvents, renderHint, BOUNDARY_NOTICE, invalidateRecallCache } from './recall.js';
import { effectivePolicy, materializeAll, setSessionPolicy, setWorkspacePolicy, setGlobalPolicy } from './policy.js';
import {
  addSessionTag, removeSessionTag, listSessionTags, listTags, sessionIdsByTags,
} from './policy.js';
import {
  createPin, updatePin, deletePin, listPins, getPin, pinsForTurn,
} from './pins.js';
import { listTerms, patchTerm, termStats, pruneTerms, rebuildIndex, invalidateWordIndex } from './indexer.js';
import { discoverWordsAsync, DEFAULT_MIN_SAMPLES } from './worddiscover.js';
import { trainTermVectors, saveTermVectors, DEFAULT_DIM } from './semantic.js';
import {
  migrateDataDir, dirSize, locationPointerPath, readLocationPointer, writeLocationPointer,
} from './migrate.js';
import { normalizeConfig } from './config.js';
import { loadWorkspaceTitles, workspaceTitleOf } from './workspaces.js';
import {
  discover, readCard, readFull, forgottenOf, overview as surfcoreOverview,
} from './surfcore.js';
import {
  MIRROR_MODE_KEY, MIRROR_MODES, DEFAULT_MIRROR_MODE,
  mirrorSync, mirrorInfo, mirrorList, mirrorKinds, mirrorForgotten, mirrorClear, liveForgotten,
} from './surfcore-store.js';

/**
 * 关键词挖掘算法的版本号。
 *
 * **挖词规则一改就必须 +1。** 关键词库是物化的：规则改了，老库里仍是旧规则
 * 挖出来的词，用户看到的还是噪声。启动时比对 meta 里的版本，落后就自动重建。
 *
 * v2：剥角色标签（`[助手]` / `[tool-result]`）、丢路径与代码字段名
 *     （`d:\...`、`content`、`categoryinfo` …）、去掉 token 尾部标点；
 *     列表排序改为「有用度」= log(1+连接度) × (1 - df/摘要总数)。
 */
const MINING_VERSION = 5;
const MINING_VERSION_KEY = 'miningVersion';

/** 词发现的最少样本数：少于这么多条摘要就不跑（统计量不可靠）。 */
const MIN_WORD_SAMPLES = DEFAULT_MIN_SAMPLES;

/** 训练词向量的最少内容数：低于这个数 SVD 学不到有意义的语义。 */
const MIN_VECTOR_DOCS = 100;

/**
 * 运行期开关的已知清单。
 *
 * 开关存在数据库的 `meta` 表里（键 `flag:<name>`），因此**改完立即生效、且重启后保留**。
 * 优先级：数据库里的显式设置 > 插件配置里的值 > 这里的默认值。
 *
 * 「主动联想」就是 `autoHint` —— 关掉之后不会再有每轮的记忆提示，
 * 但 memory_* 工具仍然可以手动查（想手动查就查，只是不打扰）。
 */
export const SWITCHES = Object.freeze({
  autoHint: { label: '主动联想（每轮自动检测并注入记忆提示）', default: true },
});

export class SessionVault {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir 数据目录
   * @param {string} opts.sessionsRoot DSH 会话目录
   * @param {object} [opts.config] 已归一化的配置（可选）
   * @param {(msg: string, level?: string) => void} [opts.log]
   */
  constructor({ dataDir, sessionsRoot, config, log, dshHome }) {
    this.dataDir = dataDir;
    this.sessionsRoot = sessionsRoot;
    this.config = config ?? normalizeConfig({}, { dshHome: dataDir });
    this.log = log ?? (() => {});
    // 记下 DSH_HOME：迁移成功后要在根目录留一个位置指针，
    // 否则下次启动会回到旧目录（配置改不动，等于"位置改不了"）。
    this.dshHome = dshHome ?? null;
    this.db = null;
    this.lastScan = null;
  }

  /** 打开库（幂等）。 */
  open() {
    if (this.db) return this.db;
    const started = Date.now();
    mkdirSync(this.dataDir, { recursive: true });
    const paths = dbPaths(this.dataDir);
    this.db = openDb(paths.dsh);
    // qq.db 按需创建：即使只有 DSH 会话，也先建好空库，方便迁移与统计
    openDb(paths.qq).close();
    materializeAll(this.db);
    // 注意：**不要**在这里同步重建关键词索引。
    // 重建要遍历几千条摘要，会把宿主启动卡住好几秒 ——
    // 由 index.js 在启动完成之后延迟调用 maybeReindex()。
    this.openMs = Date.now() - started;
    if (this.openMs > 300) {
      this.log(`打开记忆库耗时 ${this.openMs}ms（${this.dataDir}）`, 'warn');
    }
    return this.db;
  }

  /** 关闭库。迁移前必须调用。 */
  close() {
    if (!this.db) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 忽略
    }
    try {
      this.db.close();
    } catch {
      // 忽略
    }
    this.db = null;
  }

  /**
   * 全量增量扫描：发现会话 → 导入 → 消费 spool。
   * @returns {object} 统计
   */
  scan() {
    const db = this.open();
    const cfg = this.config;
    const started = Date.now();

    const disc = discoverSessions(db, this.sessionsRoot);
    const imp = importAllSessions(db, this.sessionsRoot, cfg, this.log);

    let spool = { stored: 0, duplicates: 0, bad: 0, files: 0, lines: 0 };
    if (cfg.spoolEnabled !== false) {
      spool = consumeSpool(db, join(this.dataDir, 'inbox'));
    }

    // 剪掉 df 过低的词：中文 bigram 会产生大量只出现一次的候选词，
    // 不剪会让词库与边表膨胀十倍以上，且对联想毫无贡献。
    let prune = { removed: 0, kept: 0 };
    try {
      prune = pruneTerms(db, {
        minDf: Number(cfg.termMinDf ?? 2),
        maxCount: Number(cfg.termMaxCount ?? 0),
        minEdgeHits: Number(cfg.minEdgeHits ?? 2),
      });
      if (prune.removed > 0) {
        try {
          db.exec('PRAGMA incremental_vacuum');
        } catch {
          // 老库可能没开 auto_vacuum，忽略
        }
      }
    } catch (error) {
      this.log(`关键词剪枝失败（已忽略）：${String(error)}`);
    }

    // 入库后让检索缓存失效，保证新增记忆立即可见
    invalidateRecallCache();

    const result = {
      ...imp,
      discovered: disc.discovered,
      sessionsCreated: disc.created,
      spoolStored: spool.stored,
      spoolDuplicates: spool.duplicates,
      termsPruned: prune.removed,
      termsKept: prune.kept,
      ms: Date.now() - started,
    };

    // 收尾把 WAL 折回主库：否则 -wal 会一直涨，看起来像库变大了
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 忽略
    }
    this.lastScan = result;
    this.scanProgress = { running: false, phase: 'done', done: imp.files, total: imp.files, ...result };
    return result;
  }

  /**
   * 异步扫描：每导入一个会话文件就让出一次事件循环。
   *
   * 为什么必须有这个：`scan()` 是同步的，首次全量导入实测 17~19 秒、单个最大文件
   * 1.86 秒。Node 单线程下这就是**整段卡死 DSH**（UI 不刷新、模型流中断）。
   * 改成逐文件让出后，最长的一次同步块降到约 1.9 秒，界面全程可用。
   *
   * 同一时刻只允许一个扫描；重复调用返回同一个 Promise。
   *
   * @param {object} [opts]
   * @param {(p: object) => void} [opts.onProgress] 每个文件后回调一次
   * @param {() => boolean} [opts.shouldStop] 返回 true 时提前停止（文件级）
   * @param {boolean} [opts.yieldBetween=true]
   * @returns {Promise<object>} 与 scan() 相同结构
   */
  async scanAsync(opts = {}) {
    if (this._scanPromise) return this._scanPromise;

    const { onProgress, shouldStop, yieldBetween = true } = opts;
    const run = (async () => {
      const db = this.open();
      const cfg = this.config;
      const started = Date.now();

      const progress = {
        running: true, phase: 'discover', done: 0, total: 0,
        newEvents: 0, newSummaries: 0, skippedByPolicy: 0, startedAt: started,
      };
      this.scanProgress = progress;

      const disc = discoverSessions(db, this.sessionsRoot);

      // 小文件优先：先出进度，最重的那几个放后面
      const files = findSessionFiles(this.sessionsRoot).sort((a, b) => a.size - b.size);
      progress.total = files.length;
      progress.phase = 'import';

      let newEvents = 0;
      let newSummaries = 0;
      let skippedByPolicy = 0;
      const sessions = new Set();

      for (const f of files) {
        if (shouldStop?.()) break;
        const s = importSessionFile(db, f.file, cfg);
        newEvents += s.newEvents;
        newSummaries += s.newSummaries;
        skippedByPolicy += s.skippedByPolicy;
        if (s.sessionId) sessions.add(s.sessionId);

        progress.done += 1;
        progress.newEvents = newEvents;
        progress.newSummaries = newSummaries;
        progress.skippedByPolicy = skippedByPolicy;
        try {
          onProgress?.(progress);
        } catch {
          // 进度回调坏了不能影响导入
        }

        // 让出事件循环（setImmediate 比 setTimeout(0) 更快，且不排到宏任务队尾）
        if (yieldBetween) await new Promise((r) => setImmediate(r));
      }

      progress.phase = 'index';

      let spool = { stored: 0, duplicates: 0, bad: 0, files: 0, lines: 0 };
      if (cfg.spoolEnabled !== false) {
        spool = consumeSpool(db, join(this.dataDir, 'inbox'));
      }

      let prune = { removed: 0, kept: 0 };
      try {
        prune = pruneTerms(db, {
          minDf: Number(cfg.termMinDf ?? 2),
          maxCount: Number(cfg.termMaxCount ?? 0),
          minEdgeHits: Number(cfg.minEdgeHits ?? 2),
        });
        if (prune.removed > 0) {
          try {
            db.exec('PRAGMA incremental_vacuum');
          } catch {
            // 老库没开 auto_vacuum，忽略
          }
        }
      } catch (error) {
        this.log(`关键词剪枝失败（已忽略）：${String(error)}`);
      }

      invalidateRecallCache();

      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // 忽略
      }

      const result = {
        files: files.length,
        sessions: sessions.size,
        newEvents,
        newSummaries,
        skippedByPolicy,
        discovered: disc.discovered,
        sessionsCreated: disc.created,
        spoolStored: spool.stored,
        spoolDuplicates: spool.duplicates,
        termsPruned: prune.removed,
        termsKept: prune.kept,
        ms: Date.now() - started,
      };
      this.lastScan = result;
      this.scanProgress = { running: false, phase: 'done', done: files.length, total: files.length, ...result };
      return result;
    })();

    this._scanPromise = run;
    try {
      return await run;
    } finally {
      this._scanPromise = null;
    }
  }

  /** 扫描是否在进行中。 */
  get scanning() {
    return Boolean(this._scanPromise);
  }

  /**
   * 放一条「一次性提示」：下一轮对话会被塞进上下文，然后自动清空。
   * 用于首次导入完成这类需要告知用户、但只该说一次的事。
   * @param {string} text
   */
  setNotice(text) {
    const t = String(text ?? '').trim();
    if (t) this._notice = t;
  }

  /** 取走一次性提示（取过就没了）。 */
  takeNotice() {
    const n = this._notice ?? '';
    this._notice = null;
    return n;
  }

  /** 只看不取。 */
  peekNotice() {
    return this._notice ?? '';
  }

  /**
   * 检索。
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string|null} [opts.sessionId] 当前会话；用于 read_scope=own 过滤
   * @param {'off'|'own'|'all'} [opts.readScope]
   * @param {number} [opts.limit]
   * @param {number} [opts.threshold]
   * @param {boolean} [opts.log] 是否写 recall_log
   */
  recall(query, opts = {}) {
    const db = this.open();
    const cfg = this.config;
    const scope = opts.readScope ?? 'off'; // 默认不读，与 policy.js 的 DEFAULT_READ 一致
    if (scope === 'off') {
      return { hits: [], seedTerms: [], stats: { blocked: true }, text: '' };
    }

    const started = Date.now();

    // 按标签读：把标签展开成一组会话 id 作为白名单。
    //
    // 以前这里只处理了 off 和 own，`scope === 'tags'` 直接落进"不限会话"分支，
    // 等于读全库 —— 界面上能选中标签、库里也存对了，但检索根本没用上它。
    // 这就是「多选标签没实现」的实质。
    let tagSessionIds = null;
    if (scope === 'tags') {
      const tags = Array.isArray(opts.readTags) ? opts.readTags : [];
      tagSessionIds = sessionIdsByTags(db, tags);
      // 选中了标签但没有任何会话带这些标签：直接返回空，别退回读全库
      if (tagSessionIds.length === 0) {
        const empty = { hits: [], seedTerms: [], stats: { blocked: true, reason: 'tags-empty' }, text: '' };
        return empty;
      }
    }

    const result = gate(db, query, {
      limit: opts.limit ?? cfg.hintMaxItems ?? 3,
      threshold: opts.threshold ?? cfg.hintThreshold ?? 0.35,
      depth: cfg.spreadDepth ?? 2,
      jump: cfg.spreadJump ?? 0.4,
      spreadThreshold: cfg.spreadThreshold ?? 0.15,
      maxNeighbors: cfg.maxNeighbors ?? 30,
      maxFrontier: cfg.maxFrontier ?? 100,
      maxSpreadTerms: cfg.maxSpreadTerms ?? 400,
      sessionId: scope === 'own' ? opts.sessionId ?? null : null,
      sessionIds: tagSessionIds,
    });

    // 兜底：关键词层没命中时走一次原文全文检索
    if (result.hits.length === 0) {
      const events = searchEvents(db, query, {
        limit: opts.limit ?? 3,
        sessionId: scope === 'own' ? opts.sessionId ?? null : null,
        sessionIds: tagSessionIds,
      });
      if (events.length) {
        result.fallbackEvents = events;
      }
    }

    result.text = renderHint(result.hits);
    result.stats.ms = Date.now() - started;

    if (opts.log !== false) {
      try {
        db.prepare(
          'INSERT INTO recall_log(session_id, ts, trigger, query, hits, injected, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          opts.sessionId ?? null,
          Date.now(),
          opts.trigger ?? 'tool',
          String(query).slice(0, 500),
          JSON.stringify(
            (result.hits ?? []).map((h) => ({ id: h.id, score: h.score }))
              .concat((result.fallbackEvents ?? []).map((e) => ({ eventId: e.id }))),
          ),
          result.hits.length > 0 ? 1 : 0,
          result.stats.ms,
        );
      } catch {
        // 审计写失败不影响检索
      }
    }

    return result;
  }

  /** 展开一条摘要对应的原文（注意与「打开数据库」的 open() 区分）。 */
  expand(summaryId, opts = {}) {
    return openSummary(this.open(), summaryId, opts);
  }

  /** 原文全文检索（绕过关键词层）。 */
  search(query, opts = {}) {
    return searchEvents(this.open(), query, opts);
  }

  /** 库状态。 */
  stats() {
    const db = this.open();
    const one = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
    const ts = termStats(db);
    return {
      dataDir: this.dataDir,
      dbFile: join(this.dataDir, DSH_DB),
      sizeBytes: dirSize(this.dataDir),
      sessions: one('SELECT COUNT(*) AS n FROM sessions'),
      events: one('SELECT COUNT(*) AS n FROM events'),
      summaries: one('SELECT COUNT(*) AS n FROM summaries'),
      compactionSummaries: one("SELECT COUNT(*) AS n FROM summaries WHERE kind = 'compaction'"),
      terms: ts.total,
      activeTerms: ts.active,
      edges: ts.edges,
      recalls: one('SELECT COUNT(*) AS n FROM recall_log'),
      byKind: db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all(),
      latest: db.prepare('SELECT MAX(ts) AS t FROM events').get()?.t ?? 0,
    };
  }

  /**
   * 联想记录（recall_log 的可读版本）。
   *
   * 这是"我发消息到底有没有联想到东西"的硬证据：每条用户消息都会留一行，
   * 记录当时的分词查询、命中几条、最终注入几条、耗时多少。
   *
   * @param {{ sessionId?: string, limit?: number, onlyInjected?: boolean }} [opts]
   */
  recalls({ sessionId = '', limit = 100, onlyInjected = false } = {}) {
    const db = this.open();
    const conds = [];
    const args = [];
    if (sessionId) {
      conds.push('r.session_id = ?');
      args.push(sessionId);
    }
    if (onlyInjected) conds.push('r.injected > 0');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
    return db
      .prepare(
        `SELECT r.id, r.session_id, r.ts, r.trigger, r.query, r.hits, r.injected, r.elapsed_ms,
                s.title AS session_title
         FROM recall_log r
         LEFT JOIN sessions s ON s.id = r.session_id
         ${where}
         ORDER BY r.id DESC
         LIMIT ?`,
      )
      .all(...args, lim);
  }

  /** 会话清单（含生效策略）。 */
  sessions(limit = 200) {
    return this.open()
      .prepare(
        `SELECT s.id, s.workspace, s.title, s.event_count, s.store_mode, s.read_mode,
                e.store AS eff_store, e.read_scope AS eff_read, e.resolved_from
         FROM sessions s
         LEFT JOIN session_policy_effective e ON e.session_id = s.id
         ORDER BY s.last_seen_at DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * 设置页用的完整会话树（不分页、带工作区默认值）。
   * @param {number} [limit=2000]
   */
  sessionTree(limit = 2000) {
    const db = this.open();
    // 工作区显示名来自 DSH 自己的 workspace.json（「工作区」「微信会话」…），
    // 不是路径。没这个文件时退回路径末段。
    const titles = loadWorkspaceTitles(this.dshHome);
    const rows = db
      .prepare(
          // summary_titles：该会话前几条摘要标题，用 \x1f 拼起来交给上层挑。
          // 只取第一条不够 —— 第一条常是"第 0 轮 · 工具记录"这种垃圾，
          // 后面几条里往往就有真正的用户话题。GROUP_CONCAT 一次带走，避免 N+1。
          // stored_events：真正入库的事件数（和 sessions.event_count 不同，
          // 后者是扫描时看到的事件数，即使按策略丢弃也会计数）。
          `SELECT s.id, s.workspace, s.workspace_label, s.title, s.event_count, s.last_seen_at,
                  s.store_mode, s.read_mode,
                  e.store AS eff_store, e.read_scope AS eff_read, e.resolved_from,
                  e.read_tags AS eff_read_tags,
                  (SELECT title FROM summaries WHERE session_id = s.id ORDER BY id LIMIT 1)
                    AS first_summary_title,
                  (SELECT GROUP_CONCAT(t.title, char(31)) FROM (
                     SELECT title FROM summaries
                     WHERE session_id = s.id AND title IS NOT NULL AND title <> ''
                     ORDER BY id LIMIT 6
                  ) t) AS summary_titles,
                  (SELECT COUNT(*) FROM events WHERE session_id = s.id) AS stored_events,
                  -- 该会话的标签（\x1f 拼接，交给上层拆）
                  (SELECT GROUP_CONCAT(tag, char(31)) FROM session_tags WHERE session_id = s.id) AS tags,
                  -- 会话前几条用户消息（用 \x1e 拼接），交给上层挑「第一句」当标题。
                  -- 为什么不是只取第一条：DSH 每轮都会注入人设卡 / runtime context，
                  -- 那才是"第一条用户消息"，几十个会话长得一模一样，没法核对。
                  -- 所以多取几条，跳过像注入提示词的，取用户真正说的第一句。
                  (SELECT GROUP_CONCAT(t.t, char(30)) FROM (
                     SELECT SUBSTR(text, 1, 200) AS t FROM events
                     WHERE session_id = s.id AND kind = 'user'
                     ORDER BY seq LIMIT 8
                  ) t) AS user_texts,
                  (SELECT SUBSTR(text, 1, 200) FROM events
                     WHERE session_id = s.id AND kind = 'user'
                     ORDER BY seq LIMIT 1) AS first_user_text
           FROM sessions s
           LEFT JOIN session_policy_effective e ON e.session_id = s.id
           ORDER BY s.last_seen_at DESC
           LIMIT ?`,
        )
        .all(limit);

    return {
      rows: rows.map((r) => ({
        ...r,
        workspace_title: workspaceTitleOf(r.workspace, titles),
        tags: r.tags ? String(r.tags).split('\x1f') : [],
      })),
      workspaceRows: db
        .prepare('SELECT workspace, store_default, read_default FROM workspace_policy')
        .all(),
      allTags: listTags(db),
    };
  }

  /** 设置会话策略。 */
  setSession( args) {
    return setSessionPolicy(this.open(), args);
  }

  /** 设置工作区默认策略。 */
  setWorkspace(args) {
    return setWorkspacePolicy(this.open(), args);
  }

  /** 设置全局默认策略。 */
  setGlobal(args) {
    return setGlobalPolicy(this.open(), args);
  }

  /**
   * 按当前「内容范围」重建记忆库。
   *
   * 什么时候用：改了 storeXxx 开关（比如"摘要里只要对话、不要工具输出"）之后，
   * 老库里的摘要仍然按老规则生成，必须清空重导才会按新规则来。
   *
   * 会清掉：events / summaries / 关键词库 / 倒排 / 边表，以及每个文件的水位
   * **不会清**：会话列表、策略、标签、置顶（置顶的正文是快照，不依赖 events）
   *
   * 原始会话日志在 `~/.dsh/sessions`，是 DSH 自己的文件，插件只读不删，
   * 所以这个操作是**可逆的**：改回开关再重建一次就回来了。
   *
   * @returns {{ events: number, summaries: number }}
   */
  purgeContent() {
    const db = this.open();
    const before = {
      events: db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0,
      summaries: db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0,
    };
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM terms_inv');
      db.exec('DELETE FROM term_edges');
      db.exec('DELETE FROM terms');
      db.exec('DELETE FROM summaries');
      db.exec('DELETE FROM events');
      // contentless FTS 不能按行删，只能整表重建
      db.exec('DROP TABLE IF EXISTS events_fts');
      db.exec('DROP TABLE IF EXISTS summaries_fts');
      db.exec("CREATE VIRTUAL TABLE events_fts USING fts5(seg, tokenize='unicode61', content='')");
      db.exec("CREATE VIRTUAL TABLE summaries_fts USING fts5(seg, tokenize='unicode61', content='')");
      // 水位清零 → 下次扫描从头读
      db.prepare(
        `UPDATE source_files SET bytes_done = 0, frames_done = 0, records_seen = 0,
           records_stored = 0, records_dropped = 0, skipped_by_policy = 0, updated_at = ?`,
      ).run(Date.now());
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw error;
    }
    invalidateRecallCache();
    // 重建后的词库已经是当前规则挖的，记下版本，避免下次启动又白跑一次
    try { metaSet(db, MINING_VERSION_KEY, MINING_VERSION); } catch { /* 忽略 */ }
    return before;
  }

  /**
   * 一键恢复成「全都不存 / 全都不读」。
   *
   * 用途：历史遗留的显式设置（会话级、工作区级）会压过新默认值，
   * 用户想要"重新从零开始、我自己一个个打开"的时候，需要一次清干净。
   *
   * 只改策略，**不删任何数据**：已入库的事件和摘要原样保留，
   * 关掉之后只是不再写入、不再检索。
   *
   * @param {{ keepMuted?: boolean }} [opts]
   * @returns {{ sessions: number, workspaces: number }}
   */
  resetPolicies() {
    const db = this.open();
    db.prepare('DELETE FROM workspace_policy').run();
    const s = db.prepare(
      "UPDATE sessions SET store_mode = 'inherit', read_mode = 'inherit', store_changed_at = NULL, read_changed_at = NULL",
    ).run();
    materializeAll(db);
    invalidateRecallCache();
    return { sessions: Number(s.changes) || 0, workspaces: 0 };
  }

  /** 读生效策略。 */
  policyOf(sessionId) {
    return effectivePolicy(this.open(), sessionId);
  }

  /** 关键词库。 */
  terms(limit = 50) {
    return listTerms(this.open(), { limit });
  }

  // ── 标签 ────────────────────────────────────────────────────────────────

  /** 某个会话的标签。 */
  tagsOf(sessionId) {
    return listSessionTags(this.open(), sessionId);
  }

  /** 全库标签 + 每个标签下的会话数。 */
  allTags() {
    return listTags(this.open());
  }

  /** 打标签（幂等），返回该会话的全部标签。 */
  addTag(sessionId, tag) {
    return addSessionTag(this.open(), sessionId, tag);
  }

  /** 去掉一个标签。 */
  removeTag(sessionId, tag) {
    return removeSessionTag(this.open(), sessionId, tag);
  }

  /** 标签 → 会话 id 集合。 */
  sessionsByTags(tags) {
    return sessionIdsByTags(this.open(), tags);
  }

  // ── 置顶 ────────────────────────────────────────────────────────────────

  /** 列出置顶。 */
  pins({ sessionId = '', mode = '' } = {}) {
    return listPins(this.open(), { sessionId, mode });
  }

  /** 新增置顶，返回 id。 */
  addPin(input) {
    return createPin(this.open(), input);
  }

  /** 修改置顶。 */
  patchPin(id, patch) {
    return updatePin(this.open(), id, patch);
  }

  /** 删除置顶。 */
  removePin(id) {
    return deletePin(this.open(), id);
  }

  /** 取一条置顶（工具按需读）。 */
  pin(id) {
    return getPin(this.open(), id);
  }

  /**
   * 本轮要注入的置顶文本。
   *
   * 先按该会话的「读」策略算可见范围，再做模式筛选与预算截断。
   * 读=关时直接返回空字符串 —— 用户按了全关就该真的静默。
   *
   * @param {{ sessionId?: string, query?: string, budget?: number, hitThreshold?: number }} opts
   */
  pinTextForTurn({
    sessionId = '', query = '', budget, hitThreshold,
  } = {}) {
    const policy = sessionId ? effectivePolicy(this.open(), sessionId) : null;
    return pinsForTurn(this.open(), {
      sessionId,
      readScope: policy?.readScope ?? 'off',
      readTags: policy?.readTags ?? [],
      query,
      ...(budget ? { budget } : {}),
      ...(hitThreshold ? { hitThreshold } : {}),
    });
  }

  /** 设置页关键词列表（支持搜索、语言筛选、按会话看、包含已屏蔽）。 */
  termsPage({
    q = '', limit = 100, includeMuted = true, script = 'all', sessionId = '', kind = 'word', wordLen = 0,
  } = {}) {
    return listTerms(this.open(), {
      q, limit, includeMuted, script, sessionId, kind, wordLen,
    });
  }

  /**
   * 重建关键词索引（不动原文与摘要）。
   * @param {{ minDf?: number, maxCount?: number, minEdgeHits?: number }} [opts]
   */
  rebuildIndex(opts = {}) {
    const r = rebuildIndex(this.open(), opts);
    invalidateRecallCache();
    metaSet(this.db, MINING_VERSION_KEY, MINING_VERSION);
    return r;
  }

  /**
   * 跑一次词发现，把结果写进 `mined_words`。
   *
   * 这是「真词」的唯一真相来源：索引层双写时读的就是这张表。
   * 之所以异步且分批：PMI + 左右熵要对每个候选全库扫一遍，
   * 不分批会连续占用主线程半秒（实测 527ms / 489 条摘要）。
   *
   * 样本太少时**直接放弃**（返回 skipped）—— 几十条摘要算出来的
   * PMI 和熵非常随机，宁可让检索退回纯 bigram，也不能拿噪声当词表。
   *
   * @param {{ minFreq?: number, minPMI?: number, minEntropy?: number, onProgress?: Function, shouldStop?: Function }} [opts]
   */
  async discoverWordsAsync(opts = {}) {
    const db = this.open();
    const total = db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;
    if (total < MIN_WORD_SAMPLES) {
      return {
        skipped: true,
        reason: `摘要只有 ${total} 条，少于 ${MIN_WORD_SAMPLES} 条时统计量不可靠，保持 bigram 行为`,
        samples: total,
      };
    }

    const rows = db.prepare('SELECT body FROM summaries ORDER BY id').all();
    const texts = rows.map((r) => String(r.body ?? ''));
    const found = await discoverWordsAsync(texts, opts);

    const runId = Date.now();
    const now = Date.now();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM mined_words');
      const ins = db.prepare(
        `INSERT OR REPLACE INTO mined_words(word, freq, pmi, entropy, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const w of found.words) ins.run(w.word, w.freq, w.pmi, w.entropy, runId, now);
      // epoch 一变，indexer 的词表缓存和检索缓存都会失效
      metaSet(db, 'words_epoch', String(runId));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw error;
    }

    invalidateWordIndex(db);
    invalidateRecallCache();
    return { ...found.stats, runId, samples: total };
  }

  /** 当前词表概况（给界面用）。 */
  wordStats() {
    const db = this.open();
    const total = db.prepare('SELECT COUNT(*) AS n FROM mined_words').get()?.n ?? 0;
    const byLen = db
      .prepare('SELECT LENGTH(word) AS len, COUNT(*) AS n FROM mined_words GROUP BY LENGTH(word)')
      .all();
    const epoch = metaGet(db, 'words_epoch', null);
    return {
      total,
      byLen: Object.fromEntries(byLen.map((r) => [r.len, r.n])),
      epoch: epoch ? Number(epoch) : null,
    };
  }

  /**
   * 训练词向量（PPMI + SVD），结果写进 `term_vectors`。
   *
   * **这套向量目前不参与检索** —— A/B 实测没有提升（top1 相关率 86% vs 86%），
   * 详见 CHANGELOG 0.5.2。这里做的是「把训练自动化」，让语料涨起来之后能随时
   * 重跑一次看看有没有用，而不是每次手动写脚本。
   *
   * 训练成本实测：383 条不同内容 / 7521 个词 → 704ms。
   * 主要成本是 QR 分解 O(词数 × k²)，内容变多对耗时影响很小。
   *
   * @param {{ dim?: number, minDf?: number, onProgress?: Function }} [opts]
   */
  async trainVectorsAsync(opts = {}) {
    const db = this.open();
    const docs =
      db.prepare('SELECT COUNT(DISTINCT body_hash) AS n FROM summaries WHERE body_hash IS NOT NULL').get()?.n ?? 0;
    // 语料太少时 SVD 学不出东西。低于这个数直接跳过。
    if (docs < MIN_VECTOR_DOCS) {
      return {
        skipped: true,
        reason: `不同内容只有 ${docs} 条，少于 ${MIN_VECTOR_DOCS} 条时 SVD 学不到有意义的语义`,
        docs,
      };
    }

    const started = Date.now();
    const dim = Number(opts.dim) || DEFAULT_DIM;
    const trained = await trainTermVectors(db, { dim, onProgress: opts.onProgress });
    if (!trained.termIds.length) {
      return { skipped: true, reason: '没有可训练的词', docs };
    }
    const saved = saveTermVectors(db, trained);
    const stats = {
      ...trained.stats,
      saved,
      docs,
      at: Date.now(),
      totalMs: Date.now() - started,
    };
    metaSet(db, 'vectors_stats', JSON.stringify(stats));
    return stats;
  }

  /** 词向量现状（给界面用）。 */
  vectorStats() {
    const db = this.open();
    const rows = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at, MAX(dim) AS dim FROM term_vectors').get();
    let last = null;
    try {
      last = JSON.parse(metaGet(db, 'vectors_stats', 'null') ?? 'null');
    } catch {
      last = null;
    }
    return {
      total: rows?.n ?? 0,
      dim: rows?.dim ?? null,
      updatedAt: rows?.at ?? null,
      last,
      // 明确告诉界面：这些向量目前只落库，不参与检索
      usedInRecall: false,
    };
  }

  /**
   * 预演：按**当前策略**重建一次，大概会剩多少。
   *
   * 为什么需要：`purgeContent` 会清空重导，而重导严格按策略过滤。
   * 实测把某个工作区（`D:\work\某项目`）设成 skip 之后重建，那 6100 条事件直接消失
   * ——数据还在源日志里，但策略不让入库。用户点之前必须知道会掉多少。
   */
  previewPurge() {
    const db = this.open();
    const cur = {
      events: db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0,
      summaries: db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0,
      sessions: db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM events').get()?.n ?? 0,
    };
    // 当前策略下「会入库」的会话：store=1，取其扫描时看到的事件数
    const keep = db
      .prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.event_count), 0) AS events
         FROM session_policy_effective e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.store = 1`,
      )
      .get() ?? { sessions: 0, events: 0 };
    const drop = db
      .prepare(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(s.event_count), 0) AS events
         FROM session_policy_effective e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.store = 0`,
      )
      .get() ?? { sessions: 0, events: 0 };

    return {
      current: cur,
      expected: { sessions: keep.sessions, events: keep.events },
      dropped: { sessions: drop.sessions, events: drop.events },
      // 预演是估算：源日志可能已经轮转、内容范围规则也可能再筛掉一部分
      approximate: true,
    };
  }

  /**
   * 备份当前库。
   *
   * 用 SQLite 的 `VACUUM INTO`：产出一个干净、无 WAL 依赖的单文件，
   * 比复制 dsh.db + -wal + -shm 可靠。
   *
   * @returns {{ path: string, bytes: number }}
   */
  backupDb() {
    const db = this.open();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = join(this.dataDir, `backup-${stamp}.db`);
    db.exec(`VACUUM INTO '${dest.replace(/\\/g, '/')}'`);
    let bytes = 0;
    try { bytes = statSync(dest).size; } catch { /* 忽略 */ }
    this.log(`已备份记忆库 → ${dest}（${Math.round(bytes / 1048576)} MB）`);
    return { path: dest, bytes };
  }

  /**
   * 挖词规则升级后自动重建关键词索引。
   *
   * 为什么需要：关键词库是**物化**的。改进了挖词规则（比如开始过滤路径、
   * `[tool-result]` 这类角色标签、JSON 字段名）之后，老库里仍然是旧规则挖出来的
   * 噪声词，用户看到的还是那堆 `d:\...`、`content`、`tool-result`。
   * 靠用户自己去点「重建」不现实，所以启动时比对版本号，落后就自动重挖一次。
   *
   * 只重建 terms / terms_inv / term_edges，**绝不动 events 和 summaries**。
   *
   * @returns {{ reindexed: boolean, summaries?: number, error?: string }}
   */
  maybeReindex() {
    const db = this.db;
    if (!db) return { reindexed: false };
    const stored = metaGet(db, MINING_VERSION_KEY, null);
    if (String(stored ?? '') === String(MINING_VERSION)) return { reindexed: false };

    const summaries = db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;
    if (summaries === 0) {
      // 空库：直接记版本，不需要重建
      metaSet(db, MINING_VERSION_KEY, MINING_VERSION);
      return { reindexed: false, summaries: 0 };
    }

    try {
      const r = rebuildIndex(db, {});
      invalidateRecallCache();
      metaSet(db, MINING_VERSION_KEY, MINING_VERSION);
      this.log(`关键词索引已按新规则重建：${summaries} 条摘要 → ${r.terms} 个词（miningVersion ${stored ?? '1'} → ${MINING_VERSION}）`);
      return { reindexed: true, summaries };
    } catch (error) {
      this.log(`关键词索引重建失败（保留旧词库）：${String(error?.message ?? error)}`);
      return { reindexed: false, summaries, error: String(error?.message ?? error) };
    }
  }

  /**
   * 导出成 JSONL（三个 section：sessions / summaries / events）。
   * 文件写到数据目录下，返回路径与行数。
   *
   * @param {{ maxEvents?: number }} [opts]
   */
  exportData(opts = {}) {
    const { maxEvents = 200000 } = opts;
    const db = this.open();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(this.dataDir, `export-${stamp}.jsonl`);

    const counts = { sessions: 0, summaries: 0, events: 0 };
    const lines = [];

    for (const r of db.prepare('SELECT * FROM sessions').all()) {
      lines.push(JSON.stringify({ section: 'sessions', ...r }));
      counts.sessions += 1;
    }
    for (const r of db.prepare('SELECT * FROM summaries').all()) {
      lines.push(JSON.stringify({ section: 'summaries', ...r }));
      counts.summaries += 1;
    }
    for (const r of db.prepare('SELECT * FROM events ORDER BY id LIMIT ?').all(maxEvents)) {
      lines.push(JSON.stringify({ section: 'events', ...r }));
      counts.events += 1;
    }

    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    return { file, bytes: Buffer.byteLength(lines.join('\n')), ...counts };
  }
  /** 调整关键词。 */
  patchTerm(term, patch) {
    return patchTerm(this.open(), term, patch);
  }

  /**
   * 改数据目录：先关库 → 迁移 → 校验 → 写位置指针。
   *
   * 指针写在 DSH_HOME 根目录，所以**下次启动会自动用新目录**，
   * 不需要用户再去设置页改 dataDir（那个值插件写不进去）。
   *
   * @param {string} to
   * @param {{ deleteOld?: boolean }} [opts]
   */
  migrate(to, opts = {}) {
    this.close();
    const report = migrateDataDir({ from: this.dataDir, to, deleteOld: opts.deleteOld === true });
    if (report.ok) {
      this.dataDir = to;
      this.open();
      // 迁移成功才写指针；失败保持指针不动，继续用旧库
      report.pointerWritten = writeLocationPointer(this.dshHome, to);
      report.pointerPath = this.dshHome ? locationPointerPath(this.dshHome) : null;
    } else {
      this.open(); // 迁移失败：回到原库，保持可用
    }
    return report;
  }

  /** 常驻的记忆边界声明。 */
  boundaryNotice() {
    return BOUNDARY_NOTICE;
  }

  // ── 运行期开关 ──────────────────────────────────────────────────────────

  /**
   * 读开关当前状态。
   * 优先级：数据库显式设置 > 配置里的同名项 > SWITCHES 里的默认值。
   *
   * @param {string} name
   * @param {boolean} [fallback] 配置里的值
   * @returns {{ name: string, on: boolean, source: 'db'|'config'|'default' }}
   */
  switchState(name, fallback) {
    const spec = SWITCHES[name];
    if (!spec) throw new Error(`session-vault: 未知开关 "${name}"。可用：${Object.keys(SWITCHES).join(', ')}`);
    const stored = metaGet(this.open(), `flag:${name}`, null);
    if (stored === '0' || stored === '1') {
      return { name, on: stored === '1', source: 'db' };
    }
    if (typeof fallback === 'boolean') return { name, on: fallback, source: 'config' };
    return { name, on: spec.default, source: 'default' };
  }

  /**
   * 设置开关（立即生效，写进数据库，重启后保留）。
   * @param {string} name
   * @param {boolean} on
   * @returns {{ name: string, on: boolean, source: 'db' }}
   */
  setSwitch(name, on) {
    const spec = SWITCHES[name];
    if (!spec) throw new Error(`session-vault: 未知开关 "${name}"。可用：${Object.keys(SWITCHES).join(', ')}`);
    metaSet(this.open(), `flag:${name}`, on ? '1' : '0');
    return { name, on: Boolean(on), source: 'db' };
  }

  /** 清掉显式设置，回到配置 / 默认值。 */
  clearSwitch(name) {
    const spec = SWITCHES[name];
    if (!spec) throw new Error(`session-vault: 未知开关 "${name}"`);
    this.open().prepare('DELETE FROM meta WHERE key = ?').run(`flag:${name}`);
    return this.switchState(name);
  }

  /** 列出全部开关的当前状态。 */
  allSwitches(configValues = {}) {
    return Object.keys(SWITCHES).map((name) => {
      const st = this.switchState(name, configValues[name]);
      return { ...st, label: SWITCHES[name].label };
    });
  }

  // ── surfcore 记忆卡（只读）──────────────────────────────────────────────
  //
  // 这里的所有方法都只读 surfcore 的文件，只写自己的库（sc_records）。
  // 从不写 surfcore 任何东西 —— 那边有它自己的衰减/合并逻辑，我们只旁观。

  /** 当前入库方式：'live'（现读文件）| 'mirror'（落库）。 */
  surfcoreMode() {
    const stored = metaGet(this.open(), MIRROR_MODE_KEY, null);
    if (stored === 'live' || stored === 'mirror') return stored;
    return DEFAULT_MIRROR_MODE;
  }

  /** 切换入库方式。切到 mirror 会顺手同步一次。 */
  setSurfcoreMode(mode) {
    const m = String(mode ?? '');
    if (!MIRROR_MODES.includes(m)) {
      throw new Error(`session-vault: surfcore 模式只能是 ${MIRROR_MODES.join(' / ')}`);
    }
    metaSet(this.open(), MIRROR_MODE_KEY, m);
    if (m === 'mirror') {
      const r = this.surfcoreSync();
      return { mode: m, sync: r };
    }
    return { mode: m };
  }

  /** 概览：角色、路径、主卡统计、当前模式、镜像状态。 */
  surfcoreOverview() {
    const mode = this.surfcoreMode();
    const ov = surfcoreOverview(this.dshHome ?? '');
    const db = this.open();
    const mirror = mirrorInfo(db);
    return {
      ...ov,
      mode,
      mirror,
      kinds: mode === 'mirror' && !mirror.empty ? mirrorKinds(db) : null,
    };
  }

  /** 记录列表。live 现读文件，mirror 查表。 */
  surfcoreRecords({ q = '', kind = '', inCard = '', limit = 60, offset = 0 } = {}) {
    if (this.surfcoreMode() === 'mirror') {
      return { mode: 'mirror', ...mirrorList(this.open(), { q, kind, inCard, limit, offset }) };
    }
    const paths = discover(this.dshHome ?? '');
    if (!paths.ok) return { mode: 'live', ok: false, reason: paths.reason, total: 0, rows: [] };
    const wanted = inCard === '0';
    let rows;
    if (wanted) {
      const card = readCard(paths);
      const full = readFull(paths);
      rows = forgottenOf(card.records, full.ok ? full.records : []);
    } else {
      rows = readCard(paths).records;
    }
    const query = String(q ?? '').trim();
    if (query) {
      const hit = (r) => [r.title, r.text, r.detail, ...(r.tags ?? [])]
        .some((s) => String(s ?? '').includes(query));
      rows = rows.filter(hit);
    }
    if (kind) rows = rows.filter((r) => r.kind === kind);
    const total = rows.length;
    const lim = Math.max(1, Math.min(500, Number(limit) || 60));
    const off = Math.max(0, Number(offset) || 0);
    return { mode: 'live', ok: true, total, limit: lim, offset: off, rows: rows.slice(off, off + lim) };
  }

  /** 「被 surfcore 忘了的」—— 全量档案里有、主卡里已经没有。 */
  surfcoreForgotten({ limit = 60, offset = 0 } = {}) {
    if (this.surfcoreMode() === 'mirror') {
      return { mode: 'mirror', ...mirrorForgotten(this.open(), { limit, offset }) };
    }
    const r = liveForgotten(this.dshHome ?? '', { limit: Number(limit) + Number(offset) || 60 });
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Math.min(500, Number(limit) || 60));
    return { mode: 'live', ok: r.ok, reason: r.reason, total: r.total, rows: (r.rows ?? []).slice(off, off + lim) };
  }

  /** 同步一次（只在 mirror 模式有意义）。 */
  surfcoreSync() {
    return mirrorSync(this.open(), this.dshHome ?? '');
  }

  /** 清空镜像表（不动 surfcore 文件）。 */
  surfcoreClear() {
    return mirrorClear(this.open());
  }
}

export { BOUNDARY_NOTICE, renderHint };
export * from './policy.js';
export * from './recall.js';
export * from './indexer.js';
export * from './ngram.js';
export * from './decode.js';
export * from './extract.js';
export * from './hooks.js';
export { dbPaths, DSH_DB, QQ_DB } from './db.js';
