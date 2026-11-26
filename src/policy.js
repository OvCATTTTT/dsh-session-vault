/**
 * 会话策略：写入（store）与读取（read）两个互相独立的维度，三级解析。
 *
 *   会话显式 > 工作区默认 > 全局默认
 *
 * 解析结果物化到 `session_policy_effective`，运行时和 UI 都只读那张表，
 * 避免每轮对话做三次查询。
 *
 * 为什么两个维度必须独立：`store=skip` 不等于 `read=off`。
 * 常见诉求是「这个会话里我不想让它记录我说的话，但它可以用别的记忆来回答我」。
 */

export const STORE_MODES = ['inherit', 'store', 'skip'];
export const READ_MODES = ['inherit', 'off', 'own', 'all'];

const STORE_TRUE = new Set(['store']);
const READ_SCOPES = new Set(['off', 'own', 'all']);

/** 标签名的合法形式：不能含分隔符，长度 1~32。 */
const TAG_NAME = /^[^\s,:，：]{1,32}$/;

/**
 * 解析 `tags:a,b` 形式的读模式。
 * @param {string} value
 * @returns {string[]|null} null 表示不是 tags 形式
 */
export function parseTagScope(value) {
  const s = String(value ?? '');
  if (!s.startsWith('tags:')) return null;
  return s.slice(5)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => TAG_NAME.test(t));
}

/** 把标签数组拼成 read_mode 的存储形式。 */
export function formatTagScope(tags) {
  const list = (Array.isArray(tags) ? tags : [])
    .map((t) => String(t ?? '').trim())
    .filter((t) => TAG_NAME.test(t));
  return list.length ? `tags:${[...new Set(list)].join(',')}` : 'off';
}

function normalizeStoreMode(value) {
  return STORE_MODES.includes(value) ? value : 'inherit';
}

function normalizeReadMode(value) {
  const s = String(value ?? '');
  if (READ_MODES.includes(s)) return s;
  // tags:xxx 是带参形式，合法标签至少一个
  const tags = parseTagScope(s);
  if (tags && tags.length) return formatTagScope(tags);
  return 'inherit';
}

/**
 * 默认值：**不存、不读**。
 *
 * 产品取向：装好插件后不许它自己决定记什么、能查什么。用户必须显式打开某个会话
 * 的「存」和「读」，才产生写入与检索。这样不会有"它怎么把我这段话也记下来了"的惊悚感，
 * 也符合"我自己决定存哪个读哪个"的要求。
 *
 * 注意 `normalizeXxxDefault` 只在**没有显式设置**时生效：
 * 显式写了 'store' / 'own' / 'all' 就一定尊重。
 */
function normalizeStoreDefault(value) {
  return value === 'store' ? 'store' : 'skip';
}

function normalizeReadDefault(value) {
  const s = String(value ?? '');
  const tags = parseTagScope(s);
  if (tags && tags.length) return formatTagScope(tags);
  return READ_SCOPES.has(s) ? s : 'off';
}

/** 全局默认值（写进 global_policy 表时用）。 */
export const DEFAULT_STORE = 'skip';
export const DEFAULT_READ = 'off';

/**
 * 解析某个会话的生效策略（不写库）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {string} [workspace]
 * @returns {{ store: 0|1, readScope: 'off'|'own'|'all', from: 'session'|'workspace'|'global' }}
 */
export function resolvePolicy(db, sessionId, workspace) {
  const session = sessionId
    ? db
        .prepare('SELECT store_mode, read_mode, workspace FROM sessions WHERE id = ?')
        .get(sessionId)
    : undefined;

  const ws = String(workspace ?? session?.workspace ?? '');
  const wsPolicy = ws
    ? db.prepare('SELECT store_default, read_default FROM workspace_policy WHERE workspace = ?').get(ws)
    : undefined;

  const storeDefaultRow = db.prepare("SELECT value FROM global_policy WHERE key = 'default_store'").get();
  const readDefaultRow = db.prepare("SELECT value FROM global_policy WHERE key = 'default_read'").get();

  let store;
  let readScope;
  let readTags = [];
  let from;

  if (session && session.store_mode !== 'inherit') {
    store = STORE_TRUE.has(session.store_mode) ? 1 : 0;
    from = 'session';
  } else if (wsPolicy) {
    store = normalizeStoreDefault(wsPolicy.store_default) === 'store' ? 1 : 0;
    from = 'workspace';
  } else {
    store = normalizeStoreDefault(storeDefaultRow?.value) === 'store' ? 1 : 0;
    from = 'global';
  }

  let readRaw;
  if (session && session.read_mode !== 'inherit') {
    readRaw = normalizeReadDefault(session.read_mode);
    from = 'session';
  } else if (wsPolicy) {
    readRaw = normalizeReadDefault(wsPolicy.read_default);
    if (from !== 'session') from = 'workspace';
  } else {
    readRaw = normalizeReadDefault(readDefaultRow?.value);
  }

  // tags:a,b → readScope='tags' + readTags=['a','b']
  const tagList = parseTagScope(readRaw);
  if (tagList) {
    readScope = 'tags';
    readTags = tagList;
  } else {
    readScope = readRaw;
  }

  return {
    store, readScope, readTags, from,
  };
}

/**
 * 重算并写入某个会话的物化策略。
 * @returns {{ store: 0|1, readScope: string, readTags: string[], from: string }}
 */
export function materializePolicy(db, sessionId, workspace) {
  const resolved = resolvePolicy(db, sessionId, workspace);
  db.prepare(
    `INSERT INTO session_policy_effective(session_id, store, read_scope, resolved_from, read_tags)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       store = excluded.store,
       read_scope = excluded.read_scope,
       resolved_from = excluded.resolved_from,
       read_tags = excluded.read_tags`,
  ).run(
    sessionId,
    resolved.store,
    resolved.readScope,
    resolved.from,
    JSON.stringify(resolved.readTags ?? []),
  );
  return resolved;
}

/**
 * 重算全部会话的物化策略。策略或工作区默认值变更后调用。
 * @returns {number} 受影响会话数
 */
export function materializeAll(db) {
  // 首次使用就把全局默认落成「不存 / 不读」，让 UI 和物化结果都明确，
  // 而不是靠代码里的兑底值隐式生效（用户看不出来默认到底是什么）。
  // 已有值不动：用户显式设过就尊重。
  try {
    db.prepare("INSERT OR IGNORE INTO global_policy(key, value) VALUES ('default_store', ?)").run(DEFAULT_STORE);
    db.prepare("INSERT OR IGNORE INTO global_policy(key, value) VALUES ('default_read', ?)").run(DEFAULT_READ);
  } catch {
    // 老库结构异常时不影响主流程
  }
  const rows = db.prepare('SELECT id, workspace FROM sessions').all();
  for (const row of rows) materializePolicy(db, row.id, row.workspace);
  return rows.length;
}

/**
 * 读取物化策略（运行时快路径）。
 * @returns {{ store: 0|1, readScope: 'off'|'own'|'all', from: string } | null}
 */
export function effectivePolicy(db, sessionId) {
  const row = db
    .prepare('SELECT store, read_scope, resolved_from, read_tags FROM session_policy_effective WHERE session_id = ?')
    .get(sessionId);
  if (!row) return null;
  let readTags = [];
  try {
    const parsed = JSON.parse(row.read_tags ?? '[]');
    if (Array.isArray(parsed)) readTags = parsed.map(String);
  } catch {
    // 脏数据当空
  }
  // 注意：`tags` 是物化表里的值，不是合法的 READ_SCOPES 成员，
  // 必须先按原值判断 —— normalizeReadDefault('tags') 会返回 'off'，
  // 那样「按标签读」就静默失效（这个 bug 真实出现过：策略看起来设好了，
  // 实际读=关、置顶也不注入）。
  const raw = String(row.read_scope ?? '');
  const tags = parseTagScope(raw);
  const readScope = raw === 'tags' || tags ? 'tags' : normalizeReadDefault(raw);
  return {
    store: row.store ? 1 : 0,
    readScope,
    readTags: tags && tags.length ? tags : readTags,
    from: row.resolved_from,
  };
}

// ── 标签 ──────────────────────────────────────────────────────────────────

/**
 * 给会话打标签（幂等）。
 * @returns {string[]} 打完之后该会话的全部标签
 */
export function addSessionTag(db, sessionId, tag) {
  const name = String(tag ?? '').trim();
  if (!TAG_NAME.test(name)) throw new Error(`标签名不合法：${name}`);
  db.prepare(
    'INSERT OR IGNORE INTO session_tags(session_id, tag, created_at) VALUES (?, ?, ?)',
  ).run(sessionId, name, Date.now());
  return listSessionTags(db, sessionId);
}

/** 去掉一个标签。 */
export function removeSessionTag(db, sessionId, tag) {
  db.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag = ?').run(sessionId, String(tag ?? '').trim());
  return listSessionTags(db, sessionId);
}

/** 某个会话的全部标签。 */
export function listSessionTags(db, sessionId) {
  return db
    .prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag')
    .all(sessionId)
    .map((r) => r.tag);
}

/** 全库标签 + 每个标签下的会话数。 */
export function listTags(db) {
  return db
    .prepare(`SELECT tag, COUNT(*) AS sessions FROM session_tags GROUP BY tag ORDER BY tag`)
    .all();
}

/**
 * 把标签展开成会话 id 集合。
 * @param {string[]} tags
 * @returns {string[]}
 */
export function sessionIdsByTags(db, tags) {
  const list = (Array.isArray(tags) ? tags : []).filter((t) => TAG_NAME.test(String(t ?? '').trim()));
  if (list.length === 0) return [];
  const marks = list.map(() => '?').join(',');
  return db
    .prepare(`SELECT DISTINCT session_id FROM session_tags WHERE tag IN (${marks})`)
    .all(...list)
    .map((r) => r.session_id);
}

/**
 * 设置会话级策略。传 null / 'inherit' 表示回退到继承。
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} [args.storeMode] store | skip | inherit
 * @param {string} [args.readMode] off | own | all | inherit
 * @param {string} [args.workspace]
 * @param {string} [args.title]
 */
export function setSessionPolicy(db, { sessionId, storeMode, readMode, workspace, title }) {
  const now = Date.now();
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);

  if (!exists) {
    db.prepare(
      `INSERT INTO sessions(id, workspace, workspace_label, title, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, workspace ?? null, workspace ?? null, title ?? null, now, now);
  }

  if (storeMode !== undefined) {
    db.prepare('UPDATE sessions SET store_mode = ?, store_changed_at = ? WHERE id = ?').run(
      normalizeStoreMode(storeMode),
      now,
      sessionId,
    );

    // 「打开存储」时补录历史。
    //
    // 默认策略是不存，所以大多数会话在被打开之前，事件已经被按策略丢弃、
    // 水位（source_files.bytes_done）却推进了 —— 只把开关拨到 store，
    // 用户会以为"我现在开始记了"，但历史内容永远补不回来，体验像坏了。
    //
    // 所以：拨到 store，且这个会话在 events 里一条都没有（从没导入过），
    // 就把水位清零，让下一次扫描从头读一遍。
    // 只在"一条都没有"时重置，避免重复导入已存在的事件。
    if (normalizeStoreMode(storeMode) === 'store') {
      const have = db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId)?.n ?? 0;
      if (have === 0) {
        db.prepare(
          'UPDATE source_files SET bytes_done = 0, frames_done = 0, updated_at = ? WHERE session_id = ?',
        ).run(now, sessionId);
      }
    }
  }
  if (readMode !== undefined) {
    db.prepare('UPDATE sessions SET read_mode = ?, read_changed_at = ? WHERE id = ?').run(
      normalizeReadMode(readMode),
      now,
      sessionId,
    );
  }

  const row = db.prepare('SELECT workspace FROM sessions WHERE id = ?').get(sessionId);
  return materializePolicy(db, sessionId, workspace ?? row?.workspace);
}

/**
 * 设置工作区默认策略。**只改传进来的维度。**
 *
 * 这里有个坑必须记着：早期实现是无条件写两列，只调整「读」的时候
 * `storeDefault` 是 undefined，被 normalize 成默认值写进库 ——
 * 用户的「存」会莫名其妙被重置。所以现在对未传的维度一律沿用库里现值。
 *
 * @param {object} args
 * @param {string} args.workspace
 * @param {string} [args.storeDefault] store | skip
 * @param {string} [args.readDefault] off | own | all
 * @returns {{ workspace: string, storeDefault: string, readDefault: string }}
 */
export function setWorkspacePolicy(db, { workspace, storeDefault, readDefault }) {
  const key = String(workspace ?? '');
  if (!key) throw new Error('缺少 workspace');

  const cur = db
    .prepare('SELECT store_default, read_default FROM workspace_policy WHERE workspace = ?')
    .get(key);
  const nextStore = storeDefault === undefined
    ? normalizeStoreDefault(cur?.store_default)
    : normalizeStoreDefault(storeDefault);
  const nextRead = readDefault === undefined
    ? normalizeReadDefault(cur?.read_default)
    : normalizeReadDefault(readDefault);

  db.prepare(
    `INSERT INTO workspace_policy(workspace, store_default, read_default) VALUES (?, ?, ?)
     ON CONFLICT(workspace) DO UPDATE SET
       store_default = excluded.store_default,
       read_default  = excluded.read_default`,
  ).run(key, nextStore, nextRead);

  materializeAll(db);
  return { workspace: key, storeDefault: nextStore, readDefault: nextRead };
}

/**
 * 设置全局默认策略。
 * @param {object} args
 * @param {string} [args.defaultStore] store | skip
 * @param {string} [args.defaultRead] off | own | all
 */
export function setGlobalPolicy(db, { defaultStore, defaultRead }) {
  if (defaultStore !== undefined) {
    db.prepare("INSERT INTO global_policy(key, value) VALUES ('default_store', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      normalizeStoreDefault(defaultStore),
    );
  }
  if (defaultRead !== undefined) {
    db.prepare("INSERT INTO global_policy(key, value) VALUES ('default_read', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      normalizeReadDefault(defaultRead),
    );
  }
  materializeAll(db);
}

/**
 * 登记（或更新）一个会话的基础信息，不改策略。
 * @returns {boolean} 是否为新会话
 */
export function upsertSession(db, { id, workspace, workspaceLabel, title, createdAt }) {
  const now = Date.now();
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  if (!exists) {
    db.prepare(
      `INSERT INTO sessions(id, workspace, workspace_label, title, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, workspace ?? null, workspaceLabel ?? workspace ?? null, title ?? null, createdAt ?? now, now);
    return true;
  }
  db.prepare(
    `UPDATE sessions SET
       workspace = COALESCE(?, workspace),
       workspace_label = COALESCE(?, workspace_label),
       title = COALESCE(?, title),
       last_seen_at = ?
     WHERE id = ?`,
  ).run(workspace ?? null, workspaceLabel ?? null, title ?? null, now, id);
  return false;
}
