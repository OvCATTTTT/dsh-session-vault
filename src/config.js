/**
 * 配置默认值与归一化（纯函数，不依赖 DSH，可单测）。
 * 真正的 schemastery schema 在 src/index.js 里定义。import DSH 包的只有 src/index.js
 * 和 src/tools.js 两个文件。
 */

import { join } from 'node:path';

/**
 * 生成一份默认配置。
 * @param {{ dshHome: string }} env
 */
export function defaults(env) {
  const home = env.dshHome;
  return {
    enabled: true,
    dataDir: join(home, 'session-vault'),
    sessionsRoot: join(home, 'sessions'),

    // ── 内容范围 ──
    //
    // 默认**只保存人和助手的对话**。
    // 工具调用 / 工具结果进「归档层」（可以搜、展开原文能看到），
    // 但**不参与摘要与关键词挖掘**（记忆层只有对话）。
    // 注入的系统提示 / 压缩摘要 / 思考过程不存。
    storeUser: true,
    storeAssistant: true,
    storeReasoning: false,
    storeToolCall: true,
    storeToolResult: true,
    storeSystem: false,
    storeDeveloper: false,
    storeCompactionSummary: false,
    maxEventChars: 200000,
    summaryMaxChars: 1200,
    ftsMaxChars: 20000,

    // ── 检索与提示 ──
    autoHint: true,
    hintThreshold: 0.35,
    hintMaxItems: 3,
    hintCooldownMin: 10,
    injectBoundaryNotice: true,
    spreadDepth: 2,
    spreadJump: 0.4,
    spreadThreshold: 0.15,

    // ── 关键词库 ──
    termMinDf: 2,
    termMaxCount: 8000,
    minEdgeHits: 2,
    mutedTerms: [],
    pinnedTerms: [],

    // ── 扩散性能护栏 ──
    maxNeighbors: 30,
    maxFrontier: 100,
    maxSpreadTerms: 400,

    // ── 分会话策略 ──
    sessionStore: {},
    sessionRead: {},
    workspaceStore: {},
    workspaceRead: {},

    // ── 运维 ──
    scanIntervalSec: 300,
    // 词向量（PPMI + SVD）多久重训一次。默认 6 小时。
    //
    // 这套训练是**全量**的（从零重算），不是增量 —— PPMI 的分母是全局统计量，
    // 新内容一进来旧值就该重算，所以增量在数学上没有意义。
    // 但实测训练只要 700ms（QR 分解 O(词数×k²)，内容变多影响很小），全量完全够用。
    // 设 0 关闭。
    vectorTrainIntervalSec: 21600,
    spoolEnabled: true,
    debug: false,
  };
}

/** 数值收敛到 [min,max]，非法值（含 null / '' / NaN）退回 fallback。 */
export function clampNumber(value, { min, max, fallback }) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * 把外部注入的配置和默认值合并，并做类型收敛。
 * 任何非法输入都退回默认值，绝不抛错 —— 插件不能因为配置写错而起不来。
 */
export function normalizeConfig(raw, env) {
  const base = defaults(env);
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };

  const bool = (k) => {
    merged[k] = merged[k] !== false;
  };
  for (const k of [
    'enabled', 'storeUser', 'storeAssistant', 'storeReasoning', 'storeToolCall',
    'storeToolResult', 'storeSystem', 'storeDeveloper', 'storeCompactionSummary',
    'autoHint', 'injectBoundaryNotice', 'spoolEnabled', 'debug',
  ]) bool(k);

  merged.dataDir = String(merged.dataDir || base.dataDir);
  merged.sessionsRoot = String(merged.sessionsRoot || base.sessionsRoot);

  merged.hintThreshold = clampNumber(merged.hintThreshold, { min: 0.05, max: 0.95, fallback: base.hintThreshold });
  merged.hintMaxItems = Math.round(clampNumber(merged.hintMaxItems, { min: 1, max: 8, fallback: base.hintMaxItems }));
  merged.hintCooldownMin = clampNumber(merged.hintCooldownMin, { min: 0, max: 1440, fallback: base.hintCooldownMin });
  merged.spreadDepth = Math.round(clampNumber(merged.spreadDepth, { min: 0, max: 4, fallback: base.spreadDepth }));
  merged.spreadJump = clampNumber(merged.spreadJump, { min: 0.1, max: 1, fallback: base.spreadJump });
  merged.spreadThreshold = clampNumber(merged.spreadThreshold, { min: 0.01, max: 0.9, fallback: base.spreadThreshold });
  merged.maxEventChars = Math.round(clampNumber(merged.maxEventChars, { min: 1000, max: 5000000, fallback: base.maxEventChars }));
  merged.summaryMaxChars = Math.round(clampNumber(merged.summaryMaxChars, { min: 200, max: 20000, fallback: base.summaryMaxChars }));
  merged.ftsMaxChars = Math.round(clampNumber(merged.ftsMaxChars, { min: 500, max: 500000, fallback: base.ftsMaxChars }));
  merged.scanIntervalSec = Math.round(clampNumber(merged.scanIntervalSec, { min: 0, max: 86400, fallback: base.scanIntervalSec }));
  merged.vectorTrainIntervalSec = Math.round(clampNumber(merged.vectorTrainIntervalSec, { min: 0, max: 604800, fallback: base.vectorTrainIntervalSec }));
  merged.termMinDf = Math.round(clampNumber(merged.termMinDf, { min: 1, max: 50, fallback: base.termMinDf }));
  merged.termMaxCount = Math.round(clampNumber(merged.termMaxCount, { min: 0, max: 200000, fallback: base.termMaxCount }));
  merged.minEdgeHits = Math.round(clampNumber(merged.minEdgeHits, { min: 1, max: 20, fallback: base.minEdgeHits }));
  merged.maxNeighbors = Math.round(clampNumber(merged.maxNeighbors, { min: 3, max: 500, fallback: base.maxNeighbors }));
  merged.maxFrontier = Math.round(clampNumber(merged.maxFrontier, { min: 5, max: 2000, fallback: base.maxFrontier }));
  merged.maxSpreadTerms = Math.round(clampNumber(merged.maxSpreadTerms, { min: 20, max: 20000, fallback: base.maxSpreadTerms }));

  merged.mutedTerms = Array.isArray(merged.mutedTerms) ? merged.mutedTerms.map(String).slice(0, 500) : [];
  merged.pinnedTerms = Array.isArray(merged.pinnedTerms) ? merged.pinnedTerms.map(String).slice(0, 500) : [];

  // 分会话策略：必须是「字符串 → 字符串」的对象，其它形状一律丢弃
  const dict = (v) => {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (n >= 5000) break;
      if (typeof k !== 'string' || !k) continue;
      out[k] = String(val ?? '');
      n += 1;
    }
    return out;
  };
  merged.sessionStore = dict(merged.sessionStore);
  merged.sessionRead = dict(merged.sessionRead);
  merged.workspaceStore = dict(merged.workspaceStore);
  merged.workspaceRead = dict(merged.workspaceRead);
  merged.sessionList = Array.isArray(merged.sessionList) ? merged.sessionList : [];

  return merged;
}
