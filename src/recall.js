/**
 * 检索层：门控 → 共现扩散 → 摘要打分 → 提示渲染。
 *
 * 性能设计（实测驱动，三个数字都来自真实语料）：
 *
 *   最初：整条 gate 227~326 ms，扩散阶段占 80% —— 扇出失控，两跳扩散出近 1 万个词。
 *   一改：每个节点只取 hits 最高的 30 条边 + 每层最多扩 100 节点 + 总量上限 400
 *         → 扩散 96~203 ms 降到 8~32 ms，扩散词数 9,735 → 414。
 *   二改：hub 词（tool-result/助手/content，df 占摘要总数绝大部分）不进打分池
 *         → 倒排返回行数 15,200 → 数百行。
 *   三改：**惰性扩散** —— 先用查询词本身打分，命中已够就不扩散。
 *         绝大多数查询走这条路，整条 gate 落到 10 ms 量级。
 *
 * 扩散必须限深限阈，否则几跳之后会从 "ACL" 联想到 "火锅"。
 */

import { terms as tokenize } from './ngram.js';
import { findWordsIn } from './worddiscover.js';
import { loadWordIndex } from './indexer.js';
import { edgeWeight } from './indexer.js';
import { HOOK, emit, collectBoosts } from './hooks.js';

/** 只用于打分的 term 数上限。 */
const MAX_SCORE_TERMS = 40;

/**
 * hub 摘要降权的参数。
 *
 * 问题：打分的分子是「命中的词权重之和」，**长摘要天然能匹配更多查询词**，
 * 所以它会反复霸榜。真实数据：某条 1400 字的摘要（"我想要给你搭建一个向量
 * 记忆库…"）在 31 次联想里命中 9 次、占 14% 的命中，而其中大半与当时的对话无关
 * （例如用户说「新开一个tab」也命中它）。
 *
 * 做法：按正文长度做对数衰减 —— 越长的摘要乘一个越小的系数。
 *   300 字以内不罚（短摘要本来就该精准）；
 *   600 字 ≈ ×0.80；1200 字 ≈ ×0.67；3000 字 ≈ ×0.55。
 *
 * boost（排序器显式加成、置顶等）**不**参与衰减 —— 那是人主动给的权重。
 */
const HUB_BASE_CHARS = 300;
const HUB_PENALTY = 0.35;

/** 正文长度 → 降权系数。越长的摘要越容易"什么都沾一点"，压一压。 */
export function hubFactor(len) {
  const n = Number(len) || 0;
  if (n <= HUB_BASE_CHARS) return 1;
  return 1 / (1 + HUB_PENALTY * Math.log1p((n - HUB_BASE_CHARS) / HUB_BASE_CHARS));
}

/**
 * 结果缓存：同一次对话里 auto 与 tool 常常用同一句话各查一遍。
 * 用「代号」失效 —— 每次扫描入库后代号 +1，旧缓存自然作废。
 */
let cacheEpoch = 0;
const cache = new Map();
const CACHE_MAX = 200;

/** 让缓存失效（每次 scan 入库后调用）。 */
export function invalidateRecallCache() {
  cacheEpoch += 1;
  cache.clear();
}

/**
 * 沿共现边做加权 BFS。
 *
 * 三个限制缺一不可，否则 hub 词会把扩散词数推到上万、耗时上百毫秒：
 *   · maxNeighbors —— 每节点只取 hits 最高的 K 条边
 *   · maxFrontier  —— 每层只扩展权重最高的 N 个节点
 *   · maxSpreadTerms —— 总量硬上限
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ id: number, w: number }>} seeds
 * @param {{ depth?: number, jump?: number, threshold?: number,
 *           maxNeighbors?: number, maxFrontier?: number, maxSpreadTerms?: number }} [opts]
 * @returns {Map<number, number>} termId → 权重
 */
export function spread(db, seeds, opts = {}) {
  const {
    depth = 2,
    jump = 0.4,
    threshold = 0.15,
    maxNeighbors = 30,
    maxFrontier = 100,
    maxSpreadTerms = 400,
  } = opts;

  /** @type {Map<number, number>} */
  const best = new Map();
  for (const s of seeds) best.set(s.id, Math.max(best.get(s.id) ?? 0, s.w));

  const neighbors = db.prepare(
    `SELECT id, hits FROM (
       SELECT b AS id, hits FROM term_edges WHERE a = ? ORDER BY hits DESC LIMIT ?
     )
     UNION ALL
     SELECT id, hits FROM (
       SELECT a AS id, hits FROM term_edges WHERE b = ? ORDER BY hits DESC LIMIT ?
     )`,
  );

  let frontier = seeds.map((s) => ({ id: s.id, w: s.w }));
  for (let level = 1; level <= depth; level += 1) {
    if (best.size >= maxSpreadTerms) break;

    /** @type {Array<{id:number,w:number}>} */
    const next = [];
    for (const cur of frontier) {
      for (const row of neighbors.all(cur.id, maxNeighbors, cur.id, maxNeighbors)) {
        const w = cur.w * jump * edgeWeight(row.hits);
        if (w < threshold) continue;
        const prev = best.get(row.id) ?? 0;
        if (w > prev + 1e-6) {
          best.set(row.id, w);
          next.push({ id: row.id, w });
        }
      }
      if (best.size >= maxSpreadTerms) break;
    }

    if (next.length === 0) break;
    frontier = next.sort((a, b) => b.w - a.w).slice(0, maxFrontier);
  }

  return best;
}

/**
 * 计算 idf 权重。df 越小越有区分度。pinned 优先。
 * @param {number} df
 * @param {number} total
 * @param {number|null} pinned
 * @returns {number}
 */
export function termWeight(df, total, pinned) {
  if (pinned !== null && pinned !== undefined && Number.isFinite(pinned)) return Number(pinned);
  return Math.log((total + 1) / (Number(df) + 1)) + 1;
}

/**
 * 门控：查询 → 候选摘要。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=3]
 * @param {number} [opts.threshold=0.35]
 * @param {number} [opts.depth=2]
 * @param {number} [opts.jump=0.4]
 * @param {number} [opts.spreadThreshold=0.15]
 * @param {string|null} [opts.sessionId=null] read_scope=own 时限定会话
 * @param {number} [opts.maxDfRatio=0.6]
 * @param {number} [opts.minSeedHits=1]
 * @param {boolean} [opts.lazySpread=true] 先用查询词打分，命中够就不扩散
 * @returns {{ hits: Array<object>, seedTerms: string[], stats: object }}
 */
export function gate(db, query, opts = {}) {
  const {
    limit = 3,
    threshold = 0.35,
    depth = 2,
    jump = 0.4,
    spreadThreshold = 0.15,
    sessionId = null,
    // read_scope=tags 时传进来的一组会话白名单；null 表示不按标签限
    sessionIds = null,
    maxDfRatio = 0.6,
    minSeedHits = 1,
    maxNeighbors = 30,
    maxFrontier = 100,
    maxSpreadTerms = 400,
    lazySpread = true,
  } = opts;

  // 钩子：允许扩展改写查询（同义扩展、纠错、脱敏等）
  let effectiveQuery = query;
  {
    const p = emit(HOOK.RECALL_BEFORE_QUERY, { query: String(query ?? '') });
    if (typeof p?.query === 'string') effectiveQuery = p.query;
  }

  // 缓存键必须带上标签白名单：不同标签组合会命中不同会话集合，
  // 不区分的话第二次查询会直接拿到第一次的结果。
  //
  // 注意要区分 `null`（不限）和 `[]`（白名单为空 = 一条都不给）：
  // 两者都拼成空串的话，先查一次全库、再查一次空白名单会命中同一个缓存键，
  // 结果就是"应该什么都没有却返回了全部"。
  const tagKey = sessionIds == null ? '' : `#${sessionIds.slice().sort().join(',')}`;
  const cacheKey = `${cacheEpoch}\u0000${sessionId ?? ''}\u0000${tagKey}\u0000${limit}\u0000${threshold}\u0000${depth}\u0000${effectiveQuery}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const started = Date.now();
  const remember = (result) => {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, result);
    return result;
  };

  // 语料规模必须和 df 用同一口径：
  //   · df_content 已经算过 → 分子分母都按「不同内容」去重
  //   · 还没算过（老库 / 刚增量入库）→ 都退回按摘要行数
  // 混着用会出荒谬结果：df（行数）可能大于 total（内容数），
  // 噪声过滤（df > total*0.6）就会把正常词全部误杀。
  const contentDfReady =
    (db.prepare('SELECT COUNT(*) AS n FROM terms WHERE df_content IS NOT NULL').get()?.n ?? 0) > 0;
  let total;
  if (contentDfReady) {
    total = db.prepare('SELECT COUNT(DISTINCT body_hash) AS n FROM summaries').get()?.n ?? 0;
  }
  if (!total) {
    total = db.prepare('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;
  }
  if (total === 0) return { hits: [], seedTerms: [], stats: { total: 0, ms: Date.now() - started } };

  const tokens = tokenize(effectiveQuery);
  if (tokens.length === 0) return { hits: [], seedTerms: [], stats: { total, ms: Date.now() - started } };

  // 查询侧也要认出真词：`关键词索引` 要同时产出 bigram（关键/键词/词索/索引）
  // 和真词（关键词/词索引）。真词在倒排里权重更高（见 WORD_TERM_WEIGHT），
  // 所以命中真词的摘要会自然排前面。
  const queryTokens = new Set(tokens);
  let minedWords = 0;
  try {
    const wordIndex = loadWordIndex(db);
    if (wordIndex) {
      for (const w of findWordsIn(effectiveQuery, wordIndex)) {
        queryTokens.add(w);
        minedWords += 1;
      }
    }
  } catch {
    // 词表读不到就当没有，纯 bigram 检索照常工作
  }

  // ① 命中关键词库
  // df_content 是「按不同正文去重」的 df；老库可能还没算过，退回 terms.df。
  const findTerm = db.prepare('SELECT id, term, df, df_content, muted FROM terms WHERE term = ?');
  /** @type {Array<{id:number,w:number,term:string}>} */
  const seeds = [];
  // 诊断：被挡在种子之外的词，以及原因。联想页要能解释「为什么这个词没参与」。
  const blocked = [];
  for (const t of queryTokens) {
    const row = findTerm.get(t);
    if (!row) { blocked.push({ term: t, why: '词库里没有' }); continue; }
    if (row.muted) { blocked.push({ term: t, why: '被屏蔽' }); continue; }
    const df = Number(row.df_content) > 0 ? Number(row.df_content) : Number(row.df);
    // 噪声词过滤：出现在超过 60% 内容里的词没有区分度。但必须加绝对下限
    // （df>3），否则在小语料里 df=2 的词也会被误判成噪声，什么都搜不到。
    if (df > 3 && df > total * maxDfRatio) {
      blocked.push({ term: row.term, why: `过于常见（df ${df}/${total}）` });
      continue;
    }
    seeds.push({ id: row.id, w: termWeight(df, total, null), term: row.term });
  }

  if (seeds.length === 0) {
    return {
      hits: [],
      seedTerms: [],
      stats: { total, tokens: tokens.length, minedWords, matched: 0, ms: Date.now() - started },
    };
  }

  const seedDenom = seeds.reduce((acc, s) => acc + s.w, 0) || 1;
  const seedIds = new Set(seeds.map((s) => s.id));

  // 扩展点：第三方排序器可以按 summaryId 加/减分（0~1 区间内叠加）
  const boosts = collectBoosts({
    db,
    query: effectiveQuery,
    seedTerms: seeds.map((s) => s.term),
    total,
  });

  /** 排名用的 term 权重表 */
  let ranked = seeds.map((s) => [s.id, s.w]);

  /**
   * 用给定的 term 权重表给摘要打分并取 top-N。
   * @param {Array<[number, number]>} table
   * @returns {Array<object>}
   */
  // 按标签读：只保留白名单里的会话。null = 不限（scope 是 all / own / tags 为空）
  const allowIds = Array.isArray(sessionIds) ? new Set(sessionIds) : null;

  const scoreWith = (table) => {
    if (table.length === 0) return [];
    const wOf = new Map(table);
    // term id → 词面，只给诊断用（「这条是被哪个词命中的」）
    const termNameOf = new Map();
    try {
      const ids = table.map(([id]) => id);
      const ph2 = ids.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT id, term FROM terms WHERE id IN (${ph2})`).all(...ids)) {
        termNameOf.set(r.id, r.term);
      }
    } catch {
      // 查不到就退回 #id，不影响检索
    }
    let spreadDenom = 0;
    for (const [id, w] of table) if (!seedIds.has(id)) spreadDenom += w;
    spreadDenom = spreadDenom || 1;

    const ph = table.map(() => '?').join(',');
    const invRows = db
      .prepare(`SELECT term, summary, w FROM terms_inv WHERE term IN (${ph})`)
      .all(...table.map(([id]) => id));

    /** @type {Map<number, { seedRaw: number, spreadRaw: number, seedHits: number, hitTerms: string[] }>} */
    const agg = new Map();
    for (const row of invRows) {
      const tw = wOf.get(row.term) ?? 0;
      const cur = agg.get(row.summary) ?? { seedRaw: 0, spreadRaw: 0, seedHits: 0, hitTerms: [] };
      if (seedIds.has(row.term)) {
        cur.seedRaw += tw * (row.w ?? 1);
        cur.seedHits += 1;
        // 记录命中的是哪个词（诊断用；上限 8 个避免撑爆）
        if (cur.hitTerms.length < 8) cur.hitTerms.push(termNameOf.get(row.term) ?? `#${row.term}`);
      } else {
        cur.spreadRaw += tw * (row.w ?? 1);
      }
      agg.set(row.summary, cur);
    }

    // hub 降权：一次查回候选摘要的正文长度（通常几十条，开销可忽略）。
    // 查不到就当作不降权，检索绝不能因为这个失败。
    const candIds = [...agg.keys()];
    const lenOf = new Map();
    if (candIds.length > 0 && candIds.length <= 900) {
      try {
        const lenRows = db
          .prepare(
            `SELECT id, LENGTH(body) AS len FROM summaries WHERE id IN (${candIds.map(() => '?').join(',')})`,
          )
          .all(...candIds);
        for (const r of lenRows) lenOf.set(Number(r.id), Number(r.len) || 0);
      } catch {
        // 忽略：没有长度信息时 hubFactor 走 len=0 分支，等于不降权
      }
    }

    /** @type {Array<{ summaryId: number, score: number, seedHits: number }>} */
    const scored = [...agg.entries()]
      .map(([summaryId, v]) => {
        const boost = boosts.get(summaryId) ?? 0;
        // 词命中分先算，再乘 hub 降权，最后加 boost（boost 不该被长度惩罚）
        const seedScore = v.seedRaw / seedDenom;
        const spreadScore = 0.25 * (v.spreadRaw / spreadDenom);
        const len = lenOf.get(summaryId) ?? 0;
        const hub = hubFactor(len);
        return {
          summaryId,
          boost,
          score: Math.min(1, Math.max(0, (seedScore + spreadScore) * hub + boost)),
          seedHits: v.seedHits,
          // 诊断：这条为什么得了这个分。只用于回看，不参与打分。
          diag: {
            seedScore: Number(seedScore.toFixed(3)),
            spreadScore: Number(spreadScore.toFixed(3)),
            hub: Number(hub.toFixed(3)),
            boost: Number(boost.toFixed(3)),
            len,
            hitTerms: v.hitTerms ?? [],
          },
        };
      })
      .filter((x) => x.score >= threshold && x.seedHits >= minSeedHits)
      // 分数会被 1.0  clamp 住，所以并列时用 boost 做次级排序，
      // 否则排序器的加成在"多条都是满分"时会完全失效。
      .sort((a, b) => b.score - a.score || b.boost - a.boost)
      .slice(0, limit * 4);

    // ② 补全详情 + read_scope 过滤 + 折叠重复内容
    // 同一段话（人设卡、同一份提示词）会在很多会话里各存一份，不去重的话
    // 一次检索 3 条结果全是同一段文字，看着像命中很多其实只有一条。
    const detail = db.prepare(
      `SELECT id, session_id, workspace, kind, title, body, period_from, period_to, seq_from, seq_to
       FROM summaries WHERE id = ?`,
    );
    const seen = new Set();
    const hits = [];
    for (const { summaryId, score, seedHits, diag } of scored) {
      if (hits.length >= limit) break;
      const row = detail.get(summaryId);
      if (!row) continue;
      if (sessionId && row.session_id !== sessionId) continue;
      if (allowIds && !allowIds.has(row.session_id)) continue;

      const dedupeKey = `${row.title ?? ''}|${String(row.body ?? '').slice(0, 120)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      hits.push({
        id: row.id,
        sessionId: row.session_id,
        workspace: row.workspace,
        kind: row.kind,
        title: row.title,
        excerpt: String(row.body ?? '').slice(0, 200),
        score: Number(score.toFixed(3)),
        seedHits,
        // 这条为什么得这个分（联想页「为什么」按钮展开用）
        diag,
        periodFrom: row.period_from,
        periodTo: row.period_to,
        seqFrom: row.seq_from,
        seqTo: row.seq_to,
      });
    }
    return hits;
  };

  // ② 第一遍：只用查询词本身打分（便宜）
  let hits = scoreWith(ranked);
  let spreadSize = 0;
  let spreadMs = 0;

  // ③ 只有第一遍没凑够，才做共现扩散，用「查询词覆盖率 + 扩散覆盖率」重算
  if (hits.length < limit && lazySpread) {
    const tSpread = Date.now();
    const weights = spread(db, seeds.map(({ id, w }) => ({ id, w })), {
      depth,
      jump,
      threshold: spreadThreshold,
      maxNeighbors,
      maxFrontier,
      maxSpreadTerms,
    });

    // 把过于普适的扩散词剔出打分池：它们出现在绝大部分摘要里，带进倒排查询
    // 会让返回行数从几百涨到一万五，白花 30ms 且没有区分度。
    if (weights.size > seeds.length) {
      const ids = [...weights.keys()];
      const ph = ids.map(() => '?').join(',');
      const dfRows = db.prepare(`SELECT id, df FROM terms WHERE id IN (${ph})`).all(...ids);
      const dfMap = new Map(dfRows.map((r) => [r.id, r.df]));
      for (const id of ids) {
        if (seedIds.has(id)) continue;
        const df = dfMap.get(id) ?? 0;
        if (df > 3 && df > total * maxDfRatio) weights.delete(id);
      }
    }

    spreadSize = weights.size;
    spreadMs = Date.now() - tSpread;
    ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SCORE_TERMS);
    hits = scoreWith(ranked);
  }

  // 扩展点：允许第三方过滤 / 重排最终结果
  const finalPayload = emit(HOOK.RECALL_AFTER_GATE, {
    hits,
    query: effectiveQuery,
    seedTerms: seeds.map((s) => s.term),
  });
  const finalHits = Array.isArray(finalPayload?.hits) ? finalPayload.hits : hits;

  return remember({
    hits: finalHits,
    seedTerms: seeds.map((s) => s.term),
    // 诊断：这次查询怎么走的。联想页「为什么」面板用。
    diag: {
      query: effectiveQuery,
      tokens: tokens.length,
      seeds: seeds.map((s) => ({
        term: s.term,
        w: Number(s.w.toFixed(3)),
        // 每个词在总分里的占比（分母是全部 seed 权重之和）
        share: Number((s.w / seedDenom).toFixed(3)),
      })),
      blocked: blocked.slice(0, 12),
      total,
      threshold,
    },
    stats: {
      total,
      matched: seeds.length,
      // 查询侧认出多少个词表里的真词（0 表示这次只有 bigram 起作用）
      minedWords,
      spread: spreadSize,
      spreadMs,
      lazy: hits.length >= limit,
      ms: Date.now() - started,
    },
  });
}

/**
 * 取某条摘要覆盖的原文全文。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} summaryId
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ summary: object|null, events: Array<object> }}
 */
export function openSummary(db, summaryId, opts = {}) {
  const { maxChars = 40000 } = opts;
  const summary = db.prepare('SELECT * FROM summaries WHERE id = ?').get(summaryId);
  if (!summary) return { summary: null, events: [] };

  const { seq_from: from, seq_to: to, session_id: sid, period_from: pFrom, period_to: pTo } = summary;

  let rows;
  if (from !== null && to !== null && from !== undefined && to !== undefined) {
    rows = db
      .prepare(
        `SELECT id, session_id, seq, kind, role, turn, ts, text, meta
         FROM events WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq, id`,
      )
      .all(sid, from, to);
  } else if (pFrom !== null && pTo !== null) {
    rows = db
      .prepare(
        `SELECT id, session_id, seq, kind, role, turn, ts, text, meta
         FROM events WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id`,
      )
      .all(sid, pFrom, pTo);
  } else {
    rows = [];
  }

  let used = 0;
  const events = [];
  for (const row of rows) {
    const len = String(row.text ?? '').length;
    if (used + len > maxChars) {
      events.push({ ...row, text: `${String(row.text).slice(0, Math.max(0, maxChars - used))}\n…[已截断]` });
      break;
    }
    used += len;
    events.push(row);
  }

  return { summary, events };
}

/**
 * 直接全文检索原文（兜底通道，不经关键词层）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} query
 * @param {{ limit?: number, sessionId?: string|null }} [opts]
 */
export function searchEvents(db, query, opts = {}) {
  const { limit = 5, sessionId = null, sessionIds = null } = opts;
  // 每个词都要用双引号包起来。
  //
  // FTS5 的 MATCH 是**查询语法**，不是纯文本：`whale-memory` 里的连字符会被
  // 解析成 `NOT`（→ 报错 no such column: memory），`/`、`*`、`:`、`AND` 同理。
  // 用户搜一个带连字符的项目名就直接崩，所以这里必须转义成字符串字面量。
  const seg = tokenize(query)
    .map((t) => `"${String(t).replace(/"/g, '""')}"`)
    .join(' ');
  if (!seg) return [];
  const rows = db
    .prepare(
      `SELECT e.id, e.session_id, e.seq, e.kind, e.ts, e.text, bm25(events_fts) AS rank
       FROM events_fts JOIN events e ON e.id = events_fts.rowid
       WHERE events_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(seg, limit * 4);
  // 白名单优先（read_scope=tags 时是一组会话），没有白名单才看单会话
  const allow = sessionIds ? new Set(sessionIds) : null;
  return rows
    .filter((r) => (allow ? allow.has(r.session_id) : (!sessionId || r.session_id === sessionId)))
    .slice(0, limit);
}

/**
 * 把命中结果渲染成注入系统提示的短提示。
 * **只给标题和 id，不给正文** —— 约 50 token，避免噪声和误导读模型。
 *
 * @param {Array<object>} hits
 * @param {string} [header]
 * @returns {string}
 */
export function renderHint(hits, header = '〔记忆提示〕库里有相关记录：') {
  if (!hits || hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    const when = h.periodFrom ? new Date(h.periodFrom).toISOString().slice(0, 10) : '时间未知';
    const head = h.title || String(h.excerpt ?? '').slice(0, 30);
    return `${i + 1}. ${head} · ${when} · #${h.id}（相关度 ${h.score}）`;
  });
  return `${header}\n${lines.join('\n')}\n需要时用 memory_open 展开 #id 查看原文。`;
}

/** 常驻的记忆边界声明。约 50 token，但能显著改变「编造」行为。 */
export const BOUNDARY_NOTICE =
  '〔记忆边界〕你能逐字看到的只有本会话最近一段上下文；更早的原文存在记忆库里。'
  + '当用户提到过去的事、或你对上下文没有把握时，先用 memory_recall 查，不要凭印象回答。';
