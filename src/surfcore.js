/**
 * surfcore 记忆卡的**只读**适配器。
 *
 * 铁律：这个文件里不允许出现任何写操作（writeFileSync / mkdirSync / rm / rename / copy）。
 * surfcore 自己负责它的衰减、合并、落盘，我们只在旁边看，一个字节都不碰。
 *
 * 为什么不用 surfcore 的 `lib/memory-card.js`：
 *   · 它导出的是好用的读函数（memoryCardSnapshot 等），但 import 它会连带
 *     paths.js / store.js 一串依赖，surfcore 一升级我们这边就可能跟着炸；
 *   · 而它落盘的文件格式极其简单（一个 JSON + 一个 JSONL），自己解析反而更稳。
 *
 * 数据位置（读得到就认，读不到就报 missing）：
 *   <DSH_HOME>/surfcore/characters/current.json      → { id }
 *   <DSH_HOME>/surfcore/characters/<id>/memory/memory-card.json   主卡（日常加载）
 *   <DSH_HOME>/surfcore/characters/<id>/memory/memory-card-full.jsonl  全量档案（只存档）
 *
 * 老版本把记忆卡放在 <DSH_HOME>/surfcore/memory/ 下，也兼容。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 主卡里最多多少条（surfcore 自己控制在几百条；防止异常文件撑爆内存）。 */
const MAX_CARD_RECORDS = 2000;
/** 全量档案一次最多读多少条。282 KB 的 jsonl 大概 400 条，够用。 */
const MAX_FULL_RECORDS = 4000;
/** 单条正文截断，防止一条几十万字的记录卡死界面。 */
const MAX_TEXT = 4000;

/** mtime+size 缓存：文件没变就不重复 parse。 */
const cache = new Map();

function statOf(file) {
  try {
    const s = statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function readJsonCached(file) {
  const st = statOf(file);
  if (!st) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    cache.set(file, { ...st, data });
    return data;
  } catch {
    // surfcore 正在写的时候可能读到半截；本次当读不到，下次再看。
    // 绝不能在这里"顺手修一下"写回去。
    return null;
  }
}

/** 读 jsonl，逐行 parse，坏行跳过。 */
function readJsonl(file, limit) {
  const st = statOf(file);
  if (!st) return { rows: [], truncated: false, mtimeMs: 0 };
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: [], truncated: false, mtimeMs: 0 };
  }
  const rows = [];
  let truncated = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (rows.length >= limit) { truncated = true; break; }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 坏行跳过（写一半的尾巴）
    }
  }
  const data = { rows, truncated, mtimeMs: st.mtimeMs };
  cache.set(file, { ...st, data });
  return data;
}

/**
 * 找到 surfcore 的记忆卡在哪。
 * @param {string} dshHome
 */
export function discover(dshHome) {
  const root = join(dshHome, 'surfcore');
  const out = {
    ok: false,
    root,
    characterId: '',
    characterName: '',
    cardFile: '',
    fullFile: '',
    mode: '', // 'character' | 'legacy'
    reason: '',
  };

  // ① 角色模式（新版）
  const current = readJsonCached(join(root, 'characters', 'current.json'));
  const charId = typeof current?.id === 'string' ? current.id.trim() : '';
  if (charId && /^[A-Za-z0-9_-]{1,64}$/.test(charId)) {
    const dir = join(root, 'characters', charId, 'memory');
    const card = join(dir, 'memory-card.json');
    if (statOf(card)) {
      out.ok = true;
      out.characterId = charId;
      out.characterName = typeof current?.name === 'string' ? current.name : '';
      out.cardFile = card;
      out.fullFile = join(dir, 'memory-card-full.jsonl');
      out.mode = 'character';
      return out;
    }
  }

  // ② legacy 全局模式
  const legacy = join(root, 'memory', 'memory-card.json');
  if (statOf(legacy)) {
    out.ok = true;
    out.cardFile = legacy;
    out.fullFile = join(root, 'memory', 'memory-card-full.jsonl');
    out.mode = 'legacy';
    return out;
  }

  out.reason = charId ? `找到角色 ${charId} 但没有记忆卡` : '没有找到 surfcore 记忆卡';
  return out;
}

function clampText(v) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

/**
 * 把 surfcore 的一条记录压成界面要的形状。
 *
 * 隐私：`sensitive` / `private` 的正文不在这里丢掉（镜像入库要存），
 * 只由界面决定遮不遮 —— 这样用户点开还能看。
 */
export function normalizeRecord(r, { inCard = true } = {}) {
  if (!r || typeof r !== 'object') return null;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  return {
    id,
    inCard,
    source: String(r.source ?? ''),
    platform: String(r.platform ?? ''),
    scope: String(r.scope ?? ''),
    kind: String(r.kind ?? ''),
    title: clampText(r.title ?? '').slice(0, 300),
    text: clampText(r.text ?? ''),
    detail: clampText(r.detail ?? ''),
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string').slice(0, 20) : [],
    importance: Number(r.importance) || 0,
    importanceReasons: Array.isArray(r.importanceReasons)
      ? r.importanceReasons.filter((t) => typeof t === 'string').slice(0, 8) : [],
    emotional: Number(r.emotional) || 0,
    pinned: r.pinned === true,
    anchor: r.anchor === true,
    sensitive: r.sensitive === true,
    private: r.private === true,
    isSelf: r.isSelf === true,
    clarity: String(r.clarity ?? ''),
    decaySteps: Number(r.decaySteps) || 0,
    recallCount: Number(r.recallCount) || 0,
    speaker: String(r.speaker ?? ''),
    createdAt: String(r.createdAt ?? ''),
    lastSeenAt: String(r.lastSeenAt ?? ''),
  };
}

/**
 * 读主卡（日常加载的那份，会被衰减）。
 */
export function readCard(paths) {
  const raw = readJsonCached(paths.cardFile);
  const st = statOf(paths.cardFile);
  if (!raw) {
    return {
      ok: false,
      reason: '主卡读取失败（可能正在被 surfcore 写入）',
      records: [],
      stats: {},
      mtimeMs: st?.mtimeMs ?? 0,
      sizeBytes: st?.size ?? 0,
    };
  }
  const list = Array.isArray(raw.records) ? raw.records.slice(0, MAX_CARD_RECORDS) : [];
  const records = [];
  for (const r of list) {
    const n = normalizeRecord(r, { inCard: true });
    if (n) records.push(n);
  }
  return {
    ok: true,
    version: Number(raw.version) || 0,
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    lastDecayDate: String(raw.lastDecayDate ?? ''),
    lastMaintenanceAt: String(raw.lastMaintenanceAt ?? ''),
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : {},
    alerts: raw.alerts && typeof raw.alerts === 'object' ? raw.alerts : {},
    records,
    truncated: Array.isArray(raw.records) && raw.records.length > MAX_CARD_RECORDS,
    mtimeMs: st?.mtimeMs ?? 0,
    sizeBytes: st?.size ?? 0,
  };
}

/**
 * 读全量档案（只存档，不参与日常提示词）。
 * 这里面包含已经被衰减/遗忘掉、但档案还留着的记录。
 */
export function readFull(paths) {
  const got = readJsonl(paths.fullFile, MAX_FULL_RECORDS);
  if (!got.rows.length) {
    return {
      ok: false, reason: '没有全量档案', records: [], mtimeMs: got.mtimeMs,
    };
  }
  const records = [];
  for (const r of got.rows) {
    const n = normalizeRecord(r, { inCard: false });
    if (n) records.push(n);
  }
  return {
    ok: true,
    records,
    truncated: got.truncated,
    mtimeMs: got.mtimeMs,
  };
}

/**
 * 差异：「全量档案里有、但主卡里已经没有了」= surfcore 忘掉的。
 *
 * 这是这个 tab 最有价值的一块 —— surfcore 按它的遗忘曲线跑，
 * 但档案里其实还留着，用户能看见"它忘了什么"。
 */
export function forgottenOf(cardRecords, fullRecords) {
  const live = new Set(cardRecords.map((r) => r.id));
  const out = [];
  const seen = new Set();
  for (const r of fullRecords) {
    if (live.has(r.id)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/**
 * 概览：给界面首屏用。不读全量档案（那个要按需）。
 */
export function overview(dshHome) {
  const paths = discover(dshHome);
  if (!paths.ok) {
    return {
      ok: false,
      reason: paths.reason,
      root: paths.root,
      enabled: false,
    };
  }
  const card = readCard(paths);
  const byKind = {};
  for (const r of card.records) byKind[r.kind || '?'] = (byKind[r.kind || '?'] ?? 0) + 1;
  const st = card.stats ?? {};
  return {
    ok: card.ok,
    enabled: true,
    mode: paths.mode,
    characterId: paths.characterId,
    characterName: paths.characterName,
    paths: {
      card: paths.cardFile,
      full: paths.fullFile,
    },
    card: {
      version: card.version,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      lastDecayDate: card.lastDecayDate,
      lastMaintenanceAt: card.lastMaintenanceAt,
      sizeBytes: card.sizeBytes,
      mtimeMs: card.mtimeMs,
      total: card.records.length,
      truncated: card.truncated,
      byKind,
      stats: {
        ingested: Number(st.ingested) || 0,
        fromQq: Number(st.fromQq) || 0,
        fromBili: Number(st.fromBili) || 0,
        decayed: Number(st.decayed) || 0,
        compacted: Number(st.compacted) || 0,
        forgotten: Number(st.forgotten) || 0,
        lastIngestAt: String(st.lastIngestAt ?? ''),
        lastDecayAt: String(st.lastDecayAt ?? ''),
        lastCompactionAt: st.lastCompactionAt ? String(st.lastCompactionAt) : '',
      },
      alerts: {
        level: Number(card.alerts?.level) || 0,
        acknowledgedLevel: Number(card.alerts?.acknowledgedLevel) || 0,
      },
    },
  };
}

/** 缓存清理（测试用）。 */
export function clearCache() {
  cache.clear();
}
