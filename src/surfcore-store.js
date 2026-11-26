/**
 * surfcore 记忆卡的镜像层：把只读读到的内容落进本库，方便搜索和跨库对照。
 *
 * 边界：这里只写入 **自己的库**（sc_records 表），从不碰 surfcore 的文件。
 * 唯一的输入是 `surfcore.js` 那两个只读函数。
 *
 * 两种模式（用户自己选）：
 *   · live   —— 每次请求现读 surfcore 文件，不落库。数据永远最新，但慢一点、
 *               也没法和其他表做 SQL 关联。
 *   · mirror —— 落进 sc_records，按文件 mtime 判断要不要重同步。
 */

import { discover, readCard, readFull, forgottenOf } from './surfcore.js';

export const MIRROR_MODE_KEY = 'surfcoreMode';
/** 'live' | 'mirror' */
export const MIRROR_MODES = ['live', 'mirror'];
export const DEFAULT_MIRROR_MODE = 'live';

const jsonOf = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const bool = (v) => (v ? 1 : 0);

/**
 * 把一份读到的记录写进表里（整表替换，几百条不心疼）。
 *
 * @returns {{ added: number, total: number, inCard: number, forgotten: number }}
 */
export function mirrorWrite(db, { cardRecords, fullRecords }) {
  const merged = new Map();
  for (const r of cardRecords) merged.set(r.id, { ...r, inCard: true });
  for (const r of fullRecords) {
    if (!merged.has(r.id)) merged.set(r.id, { ...r, inCard: false });
  }

  const ins = db.prepare(
    `INSERT OR REPLACE INTO sc_records(
       id, in_card, source, platform, scope, kind, title, text, detail, tags,
       importance, importance_reasons, emotional, pinned, anchor, sensitive, private, is_self,
       clarity, decay_steps, recall_count, speaker, created_at, last_seen_at, synced_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const now = Date.now();
  let inCard = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM sc_records');
    for (const r of merged.values()) {
      if (r.inCard) inCard += 1;
      ins.run(
        r.id, bool(r.inCard), r.source ?? '', r.platform ?? '', r.scope ?? '', r.kind ?? '',
        r.title ?? '', r.text ?? '', r.detail ?? '', jsonOf(r.tags),
        Number(r.importance) || 0, jsonOf(r.importanceReasons), Number(r.emotional) || 0,
        bool(r.pinned), bool(r.anchor), bool(r.sensitive), bool(r.private), bool(r.isSelf),
        r.clarity ?? '', Number(r.decaySteps) || 0, Number(r.recallCount) || 0,
        r.speaker ?? '', r.createdAt ?? '', r.lastSeenAt ?? '', now,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    added: merged.size,
    total: merged.size,
    inCard,
    forgotten: merged.size - inCard,
  };
}

/**
 * 同步一次：读 surfcore → 写镜像表。
 *
 * @returns {{ ok: boolean, reason?: string, added?: number, total?: number, inCard?: number, forgotten?: number, character?: string }}
 */
export function mirrorSync(db, dshHome) {
  const paths = discover(dshHome);
  if (!paths.ok) return { ok: false, reason: paths.reason };
  const card = readCard(paths);
  if (!card.ok) return { ok: false, reason: card.reason };
  const full = readFull(paths);
  const report = mirrorWrite(db, {
    cardRecords: card.records,
    fullRecords: full.ok ? full.records : [],
  });
  return {
    ok: true,
    ...report,
    character: paths.characterName || paths.characterId,
    cardUpdatedAt: card.updatedAt,
    cardMtimeMs: card.mtimeMs,
  };
}

/** 上一次同步留下的一些元信息（取 synced_at 最大值 + 是否为空）。 */
export function mirrorInfo(db) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN in_card = 1 THEN 1 ELSE 0 END) AS in_card,
            SUM(CASE WHEN in_card = 0 THEN 1 ELSE 0 END) AS forgotten,
            MAX(synced_at) AS synced_at
     FROM sc_records`,
  ).get() ?? {};
  const total = Number(row.total) || 0;
  return {
    total,
    inCard: Number(row.in_card) || 0,
    forgotten: Number(row.forgotten) || 0,
    syncedAt: Number(row.synced_at) || 0,
    empty: total === 0,
  };
}

function mapRow(r) {
  const parse = (s) => {
    try {
      const v = JSON.parse(s ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    inCard: r.in_card === 1,
    source: r.source,
    platform: r.platform,
    scope: r.scope,
    kind: r.kind,
    title: r.title,
    text: r.text,
    detail: r.detail,
    tags: parse(r.tags),
    importance: r.importance,
    importanceReasons: parse(r.importance_reasons),
    emotional: r.emotional,
    pinned: r.pinned === 1,
    anchor: r.anchor === 1,
    sensitive: r.sensitive === 1,
    private: r.private === 1,
    isSelf: r.is_self === 1,
    clarity: r.clarity,
    decaySteps: r.decay_steps,
    recallCount: r.recall_count,
    speaker: r.speaker,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

/**
 * 查镜像表。
 *
 * @param {{ q?: string, kind?: string, inCard?: '1'|'0'|'', limit?: number, offset?: number }} opts
 */
export function mirrorList(db, { q = '', kind = '', inCard = '', limit = 60, offset = 0 } = {}) {
  const conds = [];
  const args = [];
  const query = String(q ?? '').trim();
  if (query) {
    // instr 比 LIKE 安全：不用管 % 和 _ 的转义
    conds.push('(instr(title, ?) > 0 OR instr(text, ?) > 0 OR instr(detail, ?) > 0 OR instr(tags, ?) > 0)');
    args.push(query, query, query, query);
  }
  if (kind) {
    conds.push('kind = ?');
    args.push(kind);
  }
  if (inCard === '1' || inCard === '0') {
    conds.push('in_card = ?');
    args.push(Number(inCard));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(500, Number(limit) || 60));
  const off = Math.max(0, Number(offset) || 0);

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM sc_records ${where}`).get(...args)?.n) || 0;
  const rows = db.prepare(
    `SELECT * FROM sc_records ${where}
     ORDER BY (in_card = 0), importance DESC, created_at DESC
     LIMIT ? OFFSET ?`,
  ).all(...args, lim, off);

  return { total, limit: lim, offset: off, rows: rows.map(mapRow) };
}

/** 镜像表里的类型分布（给筛选下拉用）。 */
export function mirrorKinds(db) {
  return db.prepare(
    'SELECT kind, COUNT(*) AS n FROM sc_records GROUP BY kind ORDER BY n DESC',
  ).all().map((r) => ({ kind: r.kind || '?', n: Number(r.n) || 0 }));
}

/**
 * 被遗忘的那些：镜像表里 in_card = 0 的。
 * 只在 mirror 模式下有意义（live 模式直接算内存差异）。
 */
export function mirrorForgotten(db, { limit = 60, offset = 0 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 60));
  const off = Math.max(0, Number(offset) || 0);
  const total = Number(
    db.prepare('SELECT COUNT(*) AS n FROM sc_records WHERE in_card = 0').get()?.n,
  ) || 0;
  const rows = db.prepare(
    `SELECT * FROM sc_records WHERE in_card = 0
     ORDER BY importance DESC, created_at DESC LIMIT ? OFFSET ?`,
  ).all(lim, off);
  return { total, limit: lim, offset: off, rows: rows.map(mapRow) };
}

/** 清空镜像（切回 live 或想重来时用）。不动 surfcore。 */
export function mirrorClear(db) {
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM sc_records').get()?.n) || 0;
  db.exec('DELETE FROM sc_records');
  return { cleared: n };
}

/**
 * live 模式下的「被遗忘」：直接从文件算，不落库。
 */
export function liveForgotten(dshHome, { limit = 60 } = {}) {
  const paths = discover(dshHome);
  if (!paths.ok) return { ok: false, reason: paths.reason, total: 0, rows: [] };
  const card = readCard(paths);
  const full = readFull(paths);
  const rows = forgottenOf(card.records, full.ok ? full.records : []);
  return {
    ok: true,
    total: rows.length,
    rows: rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 60))),
  };
}
