/**
 * 置顶（pin）：把会话里的一段内容固定成「常驻记忆」。
 *
 * 为什么需要：检索是概率性的 —— 命中才给。有些内容用户希望「不用猜、一定在」，
 * 比如库的路径、称呼规则、某个结论。这类东西不适合靠 tf-idf 碰运气。
 *
 * 三种来源共用一张表（见 db.js 的 pins）：
 *   · summary —— 整条分块摘要
 *   · range   —— 消息区间（seq_from..seq_to），能核对原话
 *   · event   —— 单条消息
 *
 * 三种模式：
 *   · always  —— 每轮注入（确定性最高，占 token）
 *   · onMatch —— 本轮话题命中才注入（默认，省 token）
 *   · manual  —— 不注入，只有 memory_pin 工具按需读
 *
 * 注入受总预算约束：超了就按 order_no 截断，并在末尾说明还剩几条。
 */

import { terms as tokenize } from './ngram.js';
import { sessionIdsByTags } from './policy.js';

/** 参与 onMatch 判定的词数上限（太多会让命中率虚高）。 */
const MAX_PIN_TERMS = 40;

/** 默认总预算（字符数）。超了就截断。 */
export const DEFAULT_PIN_BUDGET = 1500;

/** onMatch 的命中阈值：Σ 1/log2(2+df)。单个稀有词约 0.35，两个常见词约 0.2。 */
export const DEFAULT_HIT_THRESHOLD = 0.35;

/**
 * 摘要模式下允许的渲染长度（太长的摘要整段贴进去会吃掉整个预算）。
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function clip(s, max) {
  const t = String(s ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * 从正文里挖出用于 onMatch 判定的词。
 * @param {string} text
 * @returns {string[]}
 */
export function pinTermsOf(text) {
  return tokenize(text, { mining: true }).slice(0, MAX_PIN_TERMS);
}

/**
 * 当前会话「能看见」的会话 id 集合。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sessionId?: string, readScope?: string, readTags?: string[] }} scope
 * @returns {Set<string>|null} null = 全部可见
 */
export function visibleSessions(db, { sessionId, readScope, readTags = [] } = {}) {
  if (readScope === 'off') return new Set();
  if (readScope === 'all') return null;
  if (readScope === 'tags') {
    const set = new Set(sessionIdsByTags(db, readTags));
    if (sessionId) set.add(sessionId);
    return set;
  }
  // own（默认）
  return new Set(sessionId ? [sessionId] : []);
}

/**
 * 渲染一条置顶的正文。
 * @param {object} pin
 * @returns {string}
 */
export function renderPin(pin) {
  return clip(pin.body ?? '', 600);
}

/**
 * 挑出本轮要注入的置顶。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @param {string} [opts.readScope]
 * @param {string[]} [opts.readTags]
 * @param {string} [opts.query] 本轮用户消息，用于 onMatch 判定
 * @param {number} [opts.budget] 总预算（字符）
 * @param {number} [opts.hitThreshold]
 * @returns {{ text: string, injected: number, skipped: number, ids: number[] }}
 */
export function pinsForTurn(db, opts = {}) {
  const {
    sessionId,
    readScope = 'off',
    readTags = [],
    query = '',
    budget = DEFAULT_PIN_BUDGET,
    hitThreshold = DEFAULT_HIT_THRESHOLD,
  } = opts;

  // 当前会话连「读」都没开，就什么都不注入 —— 用户按了全关就该真的静默
  if (readScope === 'off') return {
    text: '', injected: 0, skipped: 0, ids: [],
  };

  const visible = visibleSessions(db, { sessionId, readScope, readTags });
  const rows = db
    .prepare("SELECT * FROM pins WHERE mode IN ('always','onMatch') ORDER BY order_no, id")
    .all();

  const queryTerms = tokenize(query, { mining: true });
  const querySet = new Set(queryTerms);

  // 词的 df：用来给命中加权，避免「的」「这个」这种词触发
  const dfOf = (t) => db.prepare('SELECT df FROM terms WHERE term = ?').get(t)?.df ?? 1;

  const picked = [];
  for (const pin of rows) {
    // 可见性：自己的置顶一定可见；别人的置顶要落在可见集合里，
    // 除非用户显式关掉了 follow_read（那条是「无视读策略」）
    const own = pin.session_id === sessionId;
    if (!own) {
      if (pin.follow_read === 1) {
        if (visible && !visible.has(pin.session_id)) continue;
      }
    }
    if (pin.mode === 'onMatch') {
      let hit = 0;
      let matched = 0;
      let pinTerms = [];
      try {
        const parsed = JSON.parse(pin.terms ?? '[]');
        if (Array.isArray(parsed)) pinTerms = parsed;
      } catch {
        // 脏数据当作没有词
      }
      for (const t of pinTerms) {
        if (!querySet.has(t)) continue;
        matched += 1;
        hit += 1 / Math.log2(2 + dfOf(t));
      }
      if (matched === 0 || hit < hitThreshold) continue;
    }
    picked.push(pin);
  }

  let used = 0;
  let skipped = 0;
  const lines = [];
  const ids = [];
  for (const pin of picked) {
    const body = renderPin(pin);
    if (!body) {
      skipped += 1;
      continue;
    }
    const head = `【置顶·${pin.title}】${pin.note ? `（${pin.note}）` : ''}`;
    const block = `${head}\n${body}\n`;
    if (used + block.length > budget) {
      skipped += 1;
      continue;
    }
    used += block.length;
    lines.push(block);
    ids.push(pin.id);
  }

  if (lines.length === 0) {
    return {
      text: '', injected: 0, skipped, ids,
    };
  }

  const tail = skipped > 0
    ? `\n（另有 ${skipped} 条置顶因预算或未命中未注入，可用 memory_pin 按需读取）`
    : '';
  return {
    text: `〔置顶记忆〕\n${lines.join('\n')}${tail}`,
    injected: lines.length,
    skipped,
    ids,
  };
}

/**
 * 新增一条置顶。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @returns {number} 新 pin 的 id
 */
export function createPin(db, input) {
  const {
    sessionId, source, summaryId = null, seqFrom = null, seqTo = null,
    title, note = null, body, mode = 'onMatch', orderNo = 0, followRead = 1,
  } = input;
  if (!sessionId) throw new Error('缺少 sessionId');
  if (!['summary', 'range', 'event'].includes(source)) throw new Error(`未知来源：${source}`);
  const text = String(body ?? '').trim();
  if (!text) throw new Error('置顶内容不能为空');
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO pins(session_id, source, summary_id, seq_from, seq_to, title, note, body,
                      mode, order_no, follow_read, terms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId, source, summaryId, seqFrom, seqTo,
    String(title ?? '').trim() || '未命名置顶', note,
    text, ['always', 'onMatch', 'manual'].includes(mode) ? mode : 'onMatch',
    Number(orderNo) || 0, followRead ? 1 : 0,
    JSON.stringify(pinTermsOf(text)), now, now,
  );
  return Number(info.lastInsertRowid);
}

/** 修改置顶。只改传进来的字段。 */
export function updatePin(db, id, patch = {}) {
  const cur = db.prepare('SELECT * FROM pins WHERE id = ?').get(id);
  if (!cur) throw new Error(`置顶不存在：${id}`);
  const next = {
    title: patch.title === undefined ? cur.title : String(patch.title).trim() || cur.title,
    note: patch.note === undefined ? cur.note : patch.note,
    mode: patch.mode === undefined ? cur.mode : patch.mode,
    orderNo: patch.orderNo === undefined ? cur.order_no : Number(patch.orderNo) || 0,
    followRead: patch.followRead === undefined ? cur.follow_read : (patch.followRead ? 1 : 0),
  };
  if (patch.mode !== undefined && !['always', 'onMatch', 'manual'].includes(next.mode)) {
    throw new Error(`未知模式：${next.mode}`);
  }
  db.prepare(
    `UPDATE pins SET title = ?, note = ?, mode = ?, order_no = ?, follow_read = ?, updated_at = ?
     WHERE id = ?`,
  ).run(next.title, next.note, next.mode, next.orderNo, next.followRead, Date.now(), id);
  return db.prepare('SELECT * FROM pins WHERE id = ?').get(id);
}

/** 删除置顶。 */
export function deletePin(db, id) {
  const info = db.prepare('DELETE FROM pins WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}

/** 列出置顶（可按会话 / 模式过滤）。 */
export function listPins(db, { sessionId = '', mode = '' } = {}) {
  const conds = [];
  const args = [];
  if (sessionId) {
    conds.push('session_id = ?');
    args.push(sessionId);
  }
  if (mode) {
    conds.push('mode = ?');
    args.push(mode);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM pins ${where} ORDER BY order_no, id`)
    .all(...args);
}

/**
 * 按 id 取一条置顶的完整内容（memory_pin 工具用）。
 * @returns {object|null}
 */
export function getPin(db, id) {
  return db.prepare('SELECT * FROM pins WHERE id = ?').get(id) ?? null;
}
