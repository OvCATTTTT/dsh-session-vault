/**
 * 索引层：关键词库（terms）+ 倒排（terms_inv）+ 共现边（term_edges）。
 *
 * 关键设计：
 *   1. **增量就地累计，不重建索引。** 新摘要入库时只写它带来的 term / 倒排 / 边，
 *      查询时直接读最新的表 —— 因此「新增记忆后联想链立即生效」，不需要 reindex。
 *      对比：文件式方案必须跑一次 reindex 才能把新词并进索引。
 *   2. **幂等。** 摘要以 `hash` 唯一；重复导入直接跳过，绝不让边权重被重复累加。
 *   3. **权重饱和。** 边权重用 `1 - e^(-hits/5)` 而不是线性，避免高频词
 *      （"插件""可以"）积累几百次共现后吞噬所有联想结果。
 */

import { createHash } from 'node:crypto';
import { terms as tokenize } from './ngram.js';
import { findWordsIn, buildWordIndex } from './worddiscover.js';
import { isProceduralFragment } from './extract.js';

/** 边权重的饱和常数：hits 达到 5 时权重约 0.63。 */
export const SATURATION = 5;

/** 单条摘要参与建边的 term 上限，控制 O(k²) 的规模。 */
export const MAX_EDGE_TERMS = 24;

/**
 * 真词在倒排里的权重。
 *
 * bigram 记 1，真词记 1.8：同样命中一次，`关键词` 比 `键词` 更可信。
 * 这个系数会直接进打分分子（见 recall.js 的 scoreWith），所以不能乱调。
 */
export const WORD_TERM_WEIGHT = 1.8;

/**
 * 词表缓存：db 实例 → { epoch, index }。
 *
 * 每条摘要都去查 `mined_words` 太浪费（一次扫描要处理几百条摘要）。
 * 用 `words_epoch` 做失效标记：词表一变，epoch 变，缓存自动重建。
 */
const wordIndexCache = new WeakMap();

/**
 * 取当前词表（按首字分桶）。没有词表时返回 null，调用方退回纯 bigram。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string[]> | null}
 */
export function loadWordIndex(db) {
  let epoch = '0';
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'words_epoch'").get();
    epoch = row?.value ?? '0';
  } catch {
    return null;
  }
  const cached = wordIndexCache.get(db);
  if (cached && cached.epoch === epoch) return cached.index;

  let words = [];
  try {
    words = db.prepare('SELECT word FROM mined_words').all().map((r) => r.word);
  } catch {
    return null;
  }
  if (words.length === 0) {
    wordIndexCache.set(db, { epoch, index: null });
    return null;
  }
  const index = buildWordIndex(words);
  wordIndexCache.set(db, { epoch, index });
  return index;
}

/** 词表变了之后要调一次，让缓存失效。 */
export function invalidateWordIndex(db) {
  if (db) wordIndexCache.delete(db);
  else wordIndexCache.delete?.();
}

/**
 * 边权重：饱和函数，收敛到 1。
 * @param {number} hits
 * @returns {number}
 */
export function edgeWeight(hits) {
  const h = Math.max(0, Number(hits) || 0);
  return 1 - Math.exp(-h / SATURATION);
}

/**
 * 内容哈希，用于摘要幂等。
 * @param {...string} parts
 * @returns {string}
 */
export function contentHash(...parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p ?? ''), 'utf8');
  return h.digest('hex').slice(0, 32);
}

/**
 * 从候选 term 里挑出适合建边的一批：优先 ASCII（信息密度高），再按长度。
 * @param {string[]} list
 * @param {number} [limit]
 * @returns {string[]}
 */
export function pickEdgeTerms(list, limit = MAX_EDGE_TERMS) {
  const scored = list.map((t, i) => ({
    t,
    ascii: /^[a-z0-9]/.test(t) ? 1 : 0,
    len: t.length,
    i,
  }));
  scored.sort((a, b) => b.ascii - a.ascii || b.len - a.len || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.t);
}

/**
 * 写入一条摘要。hash 已存在则返回 null（幂等）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} s
 * @param {string} s.sessionId
 * @param {string} [s.workspace]
 * @param {string} s.kind
 * @param {string} s.title
 * @param {string} s.body
 * @param {number|null} [s.periodFrom]
 * @param {number|null} [s.periodTo]
 * @param {number|null} [s.seqFrom]
 * @param {number|null} [s.seqTo]
 * @param {string} s.hash
 * @returns {number|null} 新摘要 id；重复则 null
 */
export function insertSummary(db, s) {
  const dup = db.prepare('SELECT id FROM summaries WHERE hash = ?').get(s.hash);
  if (dup) return null;

  // 内容指纹：只看正文，不含 sessionId。
  // 同一段话在多个会话里各存一份时，hash 不同但 body_hash 相同 ——
  // df_content 靠它去重统计，否则 idf 会虚高。
  const bodyHash = hashText(String(s.body ?? ''));

  const info = db
    .prepare(
      `INSERT INTO summaries(session_id, workspace, kind, title, body,
         period_from, period_to, seq_from, seq_to, hash, created_at, body_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.sessionId ?? null,
      s.workspace ?? null,
      s.kind,
      s.title,
      s.body,
      s.periodFrom ?? null,
      s.periodTo ?? null,
      s.seqFrom ?? null,
      s.seqTo ?? null,
      s.hash,
      s.createdAt ?? Date.now(),
      bodyHash,
    );

  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO summaries_fts(rowid, seg) VALUES (?, ?)').run(id, tokenize(s.body).join(' '));
  return id;
}

/**
 * 给一段文本算内容指纹（sha1）。用于按「不同内容」统计 df。
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex');
}

/**
 * 重算 terms.df_content —— 按「不同正文」而不是「摘要行数」统计。
 *
 * 为什么不能直接用 terms.df：摘要的 hash 含 sessionId，同一段内容在 N 个会话里
 * 会有 N 行摘要。实测这种重复占 50.5%，于是 df 虚高 1.24~1.59 倍，
 * idf = log(total/df) 被系统性压低，噪声词过滤（df > total*0.6）也更容易误杀。
 *
 * 倒排 `terms_inv` 保持不动 —— 每条摘要都要能被自己的会话检索到，
 * 只在统计口径上按内容去重。
 *
 * @returns {{ updated: number, filled: number }}
 */
export function recomputeContentDf(db) {
  // ① 补上老数据的 body_hash
  const missing = db.prepare('SELECT id, body FROM summaries WHERE body_hash IS NULL').all();
  if (missing.length > 0) {
    const upd = db.prepare('UPDATE summaries SET body_hash = ? WHERE id = ?');
    for (const r of missing) upd.run(hashText(r.body), r.id);
  }

  // ② 一次性聚合：每个词出现在多少个不同内容里
  db.exec('BEGIN');
  try {
    db.exec('UPDATE terms SET df_content = NULL');
    const rows = db
      .prepare(
        `SELECT ti.term AS id, COUNT(DISTINCT s.body_hash) AS n
         FROM terms_inv ti JOIN summaries s ON s.id = ti.summary
         GROUP BY ti.term`,
      )
      .all();
    const upd = db.prepare('UPDATE terms SET df_content = ? WHERE id = ?');
    for (const r of rows) upd.run(r.n, r.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }

  const updated = db.prepare('SELECT COUNT(*) AS n FROM terms WHERE df_content IS NOT NULL').get()?.n ?? 0;
  return { updated, filled: missing.length };
}

/**
 * 为一条摘要建立 term / 倒排 / 边。必须与 insertSummary 在同一个事务里。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} summaryId
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxEdgeTerms]
 * @returns {{ terms: number, edges: number }}
 */
export function indexSummaryTerms(db, summaryId, text, opts = {}) {
  const { maxEdgeTerms = MAX_EDGE_TERMS, useWords = true } = opts;
  // mining 模式：剥掉 `[助手]` / `[tool-result]` 这类角色标签，丢掉路径与代码字段名。
  // 关键词库只放有区分度的词；原始正文仍然完整留在 summaries.body 里。
  const list = tokenize(text, { mining: true });
  if (list.length === 0) return { terms: 0, edges: 0 };

  // ── 双写：bigram（兜底召回）+ 词发现出来的真词（精确召回）──
  //
  // 为什么两者都留：真词更准，但查询里出现词表外的说法时只有 bigram 能命中。
  // 只写真词会让召回率断崖式下跌（用户说「插件」而词表里恰好没有，就搜不到）。
  /** @type {Map<string, number>} term → 倒排权重 */
  const weighted = new Map();
  for (const t of list) weighted.set(t, 1);

  let words = 0;
  if (useWords) {
    const wordIndex = loadWordIndex(db);
    if (wordIndex) {
      // 2 字真词会同时出现在 list 和 mined 里，用加权覆盖成真词的权重
      for (const w of findWordsIn(text, wordIndex)) {
        weighted.set(w, WORD_TERM_WEIGHT);
        words += 1;
      }
    }
  }

  const getTerm = db.prepare('SELECT id FROM terms WHERE term = ?');
  const insTerm = db.prepare('INSERT INTO terms(term, df, kind) VALUES (?, 1, ?)');
  const bumpDf = db.prepare('UPDATE terms SET df = df + 1 WHERE id = ?');
  const insInv = db.prepare(
    'INSERT INTO terms_inv(term, summary, w) VALUES (?, ?, ?) ON CONFLICT(term, summary) DO UPDATE SET w = excluded.w',
  );

  /** @type {Map<string, number>} */
  const ids = new Map();
  for (const [t, w] of weighted) {
    const kind = w > 1 ? 'word' : 'gram';
    const row = getTerm.get(t);
    let id;
    if (row) {
      id = row.id;
      bumpDf.run(id);
      // 之前按 bigram 存的词后来被判定为真词：升级标记，让界面按词展示
      if (kind === 'word') db.prepare("UPDATE terms SET kind = 'word' WHERE id = ?").run(id);
    } else {
      id = Number(insTerm.run(t, kind).lastInsertRowid);
    }
    ids.set(t, id);
    insInv.run(id, summaryId, w);
  }

  // 共现边：只取信息密度最高的一批，两两 UPSERT
  const picked = pickEdgeTerms(list, maxEdgeTerms).map((t) => ids.get(t));
  const now = Date.now();
  const upsertEdge = db.prepare(
    `INSERT INTO term_edges(a, b, hits, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(a, b) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`,
  );

  let edges = 0;
  for (let i = 0; i < picked.length; i += 1) {
    for (let j = i + 1; j < picked.length; j += 1) {
      const x = Math.min(picked[i], picked[j]);
      const y = Math.max(picked[i], picked[j]);
      if (x === y) continue;
      upsertEdge.run(x, y, now);
      edges += 1;
    }
  }

  return { terms: ids.size, edges };
}

/**
 * 取 term 的 id（不存在返回 undefined）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} term
 */
export function termId(db, term) {
  return db.prepare('SELECT id FROM terms WHERE term = ?').get(term)?.id;
}

/**
 * 剪枝关键词库：删掉 df 过低的 term 及其倒排/边，并可限制总量。
 *
 * 为什么必须剪：中文 bigram 会把每段文本切出上百个候选词，绝大多数只出现过
 * 一次（df=1）。不剪的话词库会膨胀到几万个、边表几十万，既占体积又拖慢检索，
 * 而这些词对联想没有贡献。剪掉不等于查不到 —— 关键词层漏掉的由 events FTS 兜底。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ minDf?: number, maxCount?: number }} [opts]
 * @returns {{ removed: number, kept: number }}
 */
export function pruneTerms(db, opts = {}) {
  const { minDf = 2, maxCount = 0, minEdgeHits = 2 } = opts;
  let removed = 0;

  // 小语料上 df 阈值没有统计意义：只有几条摘要时，几乎每个词都 df=1，
  // 照 minDf=2 剪会把词库清空（实测：2 条摘要 → 0 个关键词）。
  // 所以摘要数太少时退化成 minDf=1，只靠 maxCount 控量。
  const totalSummaries = db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;
  const effectiveMinDf = totalSummaries < 20 ? 1 : minDf;

  // ⓪ 剪弱边：只共现过一次的边是噪声，而且占边表的绝大多数。
  //    真实验证：13.5k 条事件建出 308k 条边，其中大部分 hits=1，既拖慢扩散
  //    又没有任何区分度。这是检索慢的首要原因之一。
  if (minEdgeHits > 1) {
    db.prepare('DELETE FROM term_edges WHERE hits < ?').run(minEdgeHits);
  }

  const low = 'SELECT id FROM terms WHERE df < ?';
  db.prepare(`DELETE FROM term_edges WHERE a IN (${low}) OR b IN (${low})`).run(effectiveMinDf, effectiveMinDf);
  db.prepare(`DELETE FROM terms_inv WHERE term IN (${low})`).run(effectiveMinDf);
  const del = db.prepare('DELETE FROM terms WHERE df < ?').run(effectiveMinDf);
  removed += Number(del.changes) || 0;

  if (maxCount > 0) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM terms').get()?.n ?? 0;
    if (total > maxCount) {
      const cutoff = db
        .prepare('SELECT df FROM terms ORDER BY df DESC, id ASC LIMIT 1 OFFSET ?')
        .get(maxCount - 1);
      if (cutoff) {
        const low2 = 'SELECT id FROM terms WHERE df < ?';
        db.prepare(`DELETE FROM term_edges WHERE a IN (${low2}) OR b IN (${low2})`).run(cutoff.df);
        db.prepare(`DELETE FROM terms_inv WHERE term IN (${low2})`).run(cutoff.df);
        const d2 = db.prepare('DELETE FROM terms WHERE df < ?').run(cutoff.df);
        removed += Number(d2.changes) || 0;
      }
    }
  }

  const kept = db.prepare('SELECT COUNT(*) AS n FROM terms').get()?.n ?? 0;
  return { removed, kept };
}

/**
 * 关键词库统计。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function termStats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM terms').get()?.n ?? 0;
  const active = db.prepare('SELECT COUNT(*) AS n FROM terms WHERE muted = 0').get()?.n ?? 0;
  const edges = db.prepare('SELECT COUNT(*) AS n FROM term_edges').get()?.n ?? 0;
  return { total, active, edges };
}

/**
 * 关键词库列表。
 *
 * 排序用「有用度」而不是裸连接度：
 *
 *   有用度 = log(1 + degree) × (1 - df / 摘要总数)
 *
 * 后一项是关键。一个出现在 88% 摘要里的词（`tool-result`、`content`）
 * 几乎没有区分度，不该排第一；而连接度本身会奖励这种"跟谁都共现"的词，
 * 只按 degree 排出来的榜全是废话。乘上 df 惩罚之后，
 * 真正的主题词（专有名词、项目名、故障名）才会浮上来。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ limit?: number, includeMuted?: boolean, q?: string, sort?: 'useful'|'degree'|'df'|'az' }} [opts]
 */
export function listTerms(db, opts = {}) {
  const {
    includeMuted = false, q = '', sort = 'useful', script = 'all', sessionId = '', kind = 'word', wordLen = 0,
  } = opts;
  // limit 必须是正整数：传进对象或 undefined 会让 SQLite 绑参报 datatype mismatch
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 50));
  const scriptFilter = ['cjk', 'ascii'].includes(script) ? script : 'all';

  // 默认只列「真词」。没有词表时（新装 / 语料太少 / 还没跑词发现）
  // 自动退回列全部 bigram —— 否则关键词页会一片空白。
  let kindFilter = null;
  if (kind === 'word' || kind === 'gram') {
    const mined = db.prepare('SELECT COUNT(*) AS n FROM mined_words').get()?.n ?? 0;
    if (mined > 0) kindFilter = kind;
  }

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
  /** @param {{term: string}} r */
  const matchScript = (r) => {
    if (scriptFilter === 'all') return true;
    const isCjk = CJK_RE.test(r.term);
    return scriptFilter === 'cjk' ? isCjk : !isCjk;
  };

  // ── 按会话看关键词 ────────────────────────────────────────────────────
  //
  // 全库榜对"某个会话在聊什么"没有意义：一个会话里反复出现的专有名词
  // （比如 obsidian），放到全库 4000+ 条摘要里只占 0.4%，永远排不上去。
  // 所以支持只统计某个会话内的词频。
  if (sessionId) {
    const conds = ['s.session_id = ?'];
    const args = [sessionId];
    if (!includeMuted) conds.push('t.muted = 0');
    if (kindFilter) { conds.push('t.kind = ?'); args.push(kindFilter); }
    if (wordLen > 0) { conds.push('LENGTH(t.term) = ?'); args.push(wordLen); }
    if (q) {
      conds.push('t.term LIKE ?');
      args.push(`%${q}%`);
    }
    const sessTotal = db
      .prepare('SELECT COUNT(*) AS n FROM summaries WHERE session_id = ?')
      .get(sessionId)?.n ?? 0;
    const rows = db
      .prepare(
        `SELECT t.id, t.term, t.df, t.pinned, t.muted,
                COUNT(DISTINCT ti.summary) AS session_df,
                (SELECT COUNT(*) FROM term_edges e WHERE e.a = t.id OR e.b = t.id) AS degree
         FROM terms_inv ti
         JOIN summaries s ON s.id = ti.summary
         -- 注意：terms_inv.term 存的是 terms.id（整数），不是词本身。
         -- 写成 t.term = ti.term 会永远查不到任何行。
         JOIN terms t ON t.id = ti.term
         WHERE ${conds.join(' AND ')}
         GROUP BY t.id
         ORDER BY session_df DESC, t.df DESC
         LIMIT ?`,
      )
      .all(...args, scriptFilter === 'all' ? Math.max(limit * 4, 2000) : Math.max(limit * 20, 8000));

    const spread = Math.max(sessTotal, 1);
    const scored = rows
      .filter(matchScript)
      .map((r) => {
        // 会话内：占该会话摘要的比例就是它的分量
        const share = Math.min(r.session_df, spread) / spread;
        const score = Math.log1p(r.session_df) * (0.15 + 0.85 * share);
        return {
          ...r, df: r.session_df, sessionDf: r.session_df, score: Math.round(score * 1000) / 1000,
        };
      });
    scored.sort((a, b) => b.score - a.score || b.session_df - a.session_df || a.term.localeCompare(b.term));
    return scored.slice(0, limit);
  }

  const conds = [];
  const args = [];
  if (!includeMuted) conds.push('t.muted = 0');
  if (kindFilter) { conds.push('t.kind = ?'); args.push(kindFilter); }
  if (wordLen > 0) { conds.push('LENGTH(t.term) = ?'); args.push(wordLen); }
  if (q) {
    conds.push('t.term LIKE ?');
    args.push(`%${q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const total = db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;

  if (sort === 'degree' || sort === 'df' || sort === 'az') {
    const order = sort === 'degree'
      ? 'degree DESC, df DESC, term ASC'
      : sort === 'df'
        ? 'df DESC, degree DESC, term ASC'
        : 'term ASC';
    const rows = db
      .prepare(
        `SELECT t.id, t.term, t.df, t.pinned, t.muted,
                (SELECT COUNT(*) FROM term_edges e WHERE e.a = t.id OR e.b = t.id) AS degree
         FROM terms t
         ${where}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...args, scriptFilter === 'all' ? limit : Math.max(limit * 20, 1200));
    return scriptFilter === 'all' ? rows : rows.filter(matchScript).slice(0, limit);
  }

  // 有用度排序：**必须全表取**，不能按连接度截候选。
  // 早期实现是 `ORDER BY degree DESC LIMIT 候选数`，结果像 obsidian 这种
  // 「低频但极有区分度」的专有名词连接度天然就低，连候选都进不去 ——
  // 无论把 limit 调到多大都拿不到它。词库两万多行，全取回来算分是毫秒级。
  const candidates = db
    .prepare(
      `SELECT t.id, t.term, t.df, t.pinned, t.muted,
              (SELECT COUNT(*) FROM term_edges e WHERE e.a = t.id OR e.b = t.id) AS degree
       FROM terms t
       ${where}`,
    )
    .all(...args);

  const spread = Math.max(total, 1);
  const scored = candidates
    .filter(matchScript)
    .map((r) => {
      const rarity = 1 - Math.min(r.df, spread) / spread;
      // 主体是「稀有度 × 频次的量级」，连接度只做很小的加权 ——
      // 连接度会奖励"跟谁都共现"的高频废话词，不该当主角。
      const score = Math.log1p(r.df) * rarity * (1 + 0.02 * Math.log1p(r.degree ?? 0));
      return { ...r, score: Math.round(score * 1000) / 1000 };
    });
  scored.sort((a, b) => b.score - a.score || b.df - a.df || a.term.localeCompare(b.term));
  return scored.slice(0, limit);
}

/**
 * 重建关键词索引：清掉 terms / terms_inv / term_edges，再从 summaries 重新抽取。
 *
 * **不动 events 和 summaries** —— 原文和摘要永远不因为重建索引而丢。
 * 用途：改了 termMinDf 之后让词库按新阈值重算，或者修掉被污染的边表。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ minDf?: number, maxCount?: number, minEdgeHits?: number }} [opts]
 * @returns {{ summaries: number, terms: number, edges: number, pruned: number, ms: number }}
 */
export function rebuildIndex(db, opts = {}) {
  const started = Date.now();
  const { minDf = 2, maxCount = 0, minEdgeHits = 2 } = opts;

  // 整个重建必须在一个事务里。
  //
  // 不加事务时每条 INSERT 都自动提交，几百条摘要 × 上千个词就是上万次隐式事务：
  // 实测 492 条摘要要 **16.8 秒**。包进事务后同样的工作量降到亚秒级。
  // 这也是为什么它以前"看起来很快"——老代码路径里 maybeReindex 有版本号挡着，
  // 基本不真跑，所以没人发现。
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM terms_inv');
    db.exec('DELETE FROM term_edges');
    db.exec('DELETE FROM terms');

    const rows = db.prepare('SELECT id, body FROM summaries ORDER BY id').all();
    let skipped = 0;
    for (const r of rows) {
      // 和摄入时同一套规则：过程性碎片不建索引。这样重建一次就能把
      // 历史上已经污染的碎片索引清出去，不需要手动删数据。
      if (isProceduralFragment(String(r.body ?? ''))) { skipped += 1; continue; }
      indexSummaryTerms(db, r.id, String(r.body ?? ''));
    }

    const pruned = pruneTerms(db, { minDf, maxCount, minEdgeHits });
    db.exec('COMMIT');

    // 索引建完后重算「按内容去重」的 df —— 必须放在 prune 之后，
    // 否则算好的 df_content 会随被剪掉的词一起丢弃。
    let contentDf = 0;
    try {
      contentDf = recomputeContentDf(db).updated;
    } catch {
      // 算不准就退回 terms.df，检索侧有兜底
    }

    const edges = db.prepare('SELECT COUNT(*) AS n FROM term_edges').get()?.n ?? 0;
    return {
      summaries: rows.length,
      terms: pruned.kept,
      edges,
      pruned: pruned.removed,
      contentDf,
      fragmentsSkipped: skipped,
      ms: Date.now() - started,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw error;
  }
}

/**
 * 手动加权 / 屏蔽。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} term
 * @param {{ pinned?: number|null, muted?: boolean }} patch
 * @returns {boolean} 是否命中已有 term
 */
export function patchTerm(db, term, patch) {
  const row = db.prepare('SELECT id FROM terms WHERE term = ?').get(term);
  if (!row) return false;
  if (patch.pinned !== undefined) {
    db.prepare('UPDATE terms SET pinned = ? WHERE id = ?').run(patch.pinned, row.id);
  }
  if (patch.muted !== undefined) {
    db.prepare('UPDATE terms SET muted = ? WHERE id = ?').run(patch.muted ? 1 : 0, row.id);
  }
  return true;
}
