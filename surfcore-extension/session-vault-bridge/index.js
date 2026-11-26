/**
 * surfcore 扩展：把记忆卡的全量归档投递给 dsh-session-vault。
 *
 * 为什么做成「扩展」而不是塞进 dsh-session-vault 本体：
 *   不是每个 DSH 用户都装了 surfcore。把 QQ 侧逻辑放在 core 里，等于强迫所有人
 *   承受一个他们用不到、也可能不存在的依赖。做成扩展后：
 *     · 没装 surfcore 的人，dsh-session-vault 完全不知道它存在；
 *     · 装了的人，自己决定要不要开（surfcore 规定扩展默认 enabled:false）；
 *     · 两边任一坏了都不影响另一边。
 *
 * 通信方式是**文件投递箱（spool）**，不是进程内调用：
 *   本扩展只往 <session-vault>/inbox/qq.jsonl 追加 JSON 行，dsh-session-vault 按字节水位读。
 *   append-only + 偏移 + 内容哈希 = 任一侧崩溃重启都不会丢也不会重。
 *
 * 隐私：只投递 surfcore 已经脱敏过的全量归档内容，本扩展不做二次脱敏，
 *       也不读取任何私信文件。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const NS = 'session-vault-bridge';
const STATE_FILE = 'offset.json';

/**
 * activate 时保存下来的宿主句柄。
 * surfcore 的 onEvent(event, payload) 不给 api，所以必须在模块作用域留一份，
 * 否则"记忆同步完成后自动投递"就无从谈起。
 */
let apiRef = null;

/** 从一条 surfcore 记忆记录里尽力取出可用字段（字段名可能有多个历史版本）。 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(
    raw.text ?? raw.content ?? raw.body ?? raw.summary ?? raw.note ?? '',
  ).trim();
  if (!text) return null;

  const ts = Number(raw.ts ?? raw.time ?? raw.createdAt ?? raw.updatedAt ?? 0) || Date.now();
  const channel = String(
    raw.channel ?? raw.scope ?? raw.platform ?? raw.kind ?? 'memory-card',
  );
  const who = raw.isOwner === true ? 'owner' : (raw.role ?? raw.sender ?? 'peer');
  return {
    text,
    ts,
    channel,
    meta: {
      isOwner: raw.isOwner === true,
      role: who,
      platform: raw.platform ?? null,
      level: raw.level ?? raw.tier ?? null,
      keys: Array.isArray(raw.keys) ? raw.keys.slice(0, 20) : (raw.keywords ?? null),
    },
  };
}

/** 定位 surfcore 的记忆归档文件（多路兜底，适配不同版本）。 */
function resolveMemoryFile(api) {
  const candidates = [];
  try {
    const p = api.paths ?? {};
    for (const key of ['memoryFullFile', 'memoryCardFull', 'memoryFile', 'memoryDir', 'memory']) {
      if (typeof p[key] === 'string') {
        candidates.push(p[key].endsWith('.jsonl') ? p[key] : join(p[key], 'memory-card-full.jsonl'));
      }
    }
  } catch {
    // 忽略
  }
  candidates.push(join(homedir(), '.dsh', 'surfcore', 'memory', 'memory-card-full.jsonl'));
  return candidates.find((f) => existsSync(f)) ?? null;
}

/** 定位 dsh-session-vault 的数据目录与投递箱。 */
function resolveInbox(api) {
  const cfg = api.config.get() ?? {};
  const dir = String(cfg.session-vaultDataDir ?? process.env.SESSION_VAULT_DATA_DIR ?? join(homedir(), '.dsh', 'session-vault'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  return { dir, file: join(inbox, 'qq.jsonl') };
}

function readOffset(api) {
  try {
    const f = join(api.dataDir, STATE_FILE);
    if (!existsSync(f)) return { offset: 0, pushed: 0 };
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return { offset: 0, pushed: 0 };
  }
}

function writeOffset(api, state) {
  try {
    mkdirSync(api.dataDir, { recursive: true });
    writeFileSync(join(api.dataDir, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // 状态写失败只影响增量精度，下次重放由 hash 兜住
  }
}

/**
 * 核心动作：把未投递的部分推进 spool。
 * @returns {{ ok: boolean, reason?: string, pushed: number, total: number }}
 */
function flush(api) {
  const src = resolveMemoryFile(api);
  if (!src) return { ok: false, reason: 'memory-file-not-found', pushed: 0, total: 0 };

  let size = 0;
  try {
    size = statSync(src).size;
  } catch {
    return { ok: false, reason: 'stat-failed', pushed: 0, total: 0 };
  }

  const state = readOffset(api);
  const offset = Number(state.offset) || 0;
  if (size <= offset) return { ok: true, pushed: 0, total: state.pushed ?? 0 };

  let chunk = '';
  try {
    chunk = readFileSync(src).subarray(offset, size).toString('utf8');
  } catch {
    return { ok: false, reason: 'read-failed', pushed: 0, total: 0 };
  }

  // 只处理完整的行
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl < 0) return { ok: true, pushed: 0, total: state.pushed ?? 0 };
  const usable = chunk.slice(0, lastNl + 1);
  const consumedTo = offset + Buffer.byteLength(usable, 'utf8');

  const { file } = resolveInbox(api);
  let pushed = 0;
  const lines = [];

  for (const line of usable.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const n = normalizeRecord(rec);
    if (!n) continue;
    const hash = createHash('sha256')
      .update(`surfcore-qq|${n.channel}|${n.ts}|${n.text}`)
      .digest('hex')
      .slice(0, 32);
    lines.push(JSON.stringify({
      v: 1,
      source: 'surfcore-qq',
      channel: n.channel,
      ts: n.ts,
      kind: 'memory',
      text: n.text,
      meta: n.meta,
      hash,
    }));
    pushed += 1;
  }

  if (lines.length > 0) {
    try {
      appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      return { ok: false, reason: `append-failed: ${String(error)}`, pushed: 0, total: state.pushed ?? 0 };
    }
  }

  const total = (Number(state.pushed) || 0) + pushed;
  writeOffset(api, { offset: consumedTo, pushed: total, updatedAt: Date.now() });
  return { ok: true, pushed, total };
}

export async function activate(api) {
  apiRef = api;
  api.log(`${NS} 已激活；投递目标 <session-vault>/inbox/qq.jsonl`);

  // 手动触发 / 诊断
  api.registerRoute('GET', '/status', async (req, res) => {
    const src = resolveMemoryFile(api);
    const state = readOffset(api);
    const body = {
      ok: true,
      extension: NS,
      sourceFile: src,
      sourceExists: Boolean(src),
      offset: state.offset ?? 0,
      pushed: state.pushed ?? 0,
      session-vaultDataDir: resolveInbox(api).dir,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  });

  api.registerRoute('POST', '/flush', async (req, res) => {
    const r = flush(api);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(r));
  });

  // 首次激活先补一次历史
  try {
    const r = flush(api);
    if (r.ok) api.log(`${NS} 首次投递 ${r.pushed} 条（累计 ${r.total}）`);
    else api.log(`${NS} 首次投递跳过：${r.reason}`);
  } catch (error) {
    api.log(`${NS} 首次投递失败（忽略）：${String(error)}`);
  }
}

/**
 * surfcore 事件回调。记忆同步完成后自动增量投递。
 */
export function onEvent(event, payload) {
  if (event !== 'memory.synced' && event !== 'memory.updated') return;
  if (!apiRef) return;
  try {
    const r = flush(apiRef);
    if (r.ok && r.pushed > 0) apiRef.log(`${NS} 事件 ${event} 触发投递 ${r.pushed} 条（累计 ${r.total}）`);
    else if (!r.ok) apiRef.log(`${NS} 事件 ${event} 投递跳过：${r.reason}`);
  } catch (error) {
    apiRef.log(`${NS} 事件 ${event} 投递失败（忽略）：${String(error)}`);
  }
  void payload;
}
