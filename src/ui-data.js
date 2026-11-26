/**
 * 设置页用的数据整形（纯函数，不依赖 DSH，可单测）。
 *
 * 路由层只负责取数、鉴权、序列化；把「怎么组织成 UI 想要的结构」放在这里，
 * 这样表格逻辑能被测试覆盖，而不必启动一个 webServer。
 */

import { looksLikePrompt } from './extract.js';
import { parseTagScope } from './policy.js';

/**
 * 这个「标题」其实是机器生成的占位文本，拿来区分会话毫无用处。
 *
 * 实测真实库里最常见的几种：
 *   · "第 0 轮 · 工具记录" / "第 3 轮 · 工具结果" —— 分块摘要的默认标题
 *   · "1111111111111111" —— 纯数字（测试消息）
 *   · "The approval policy changed from ..." —— 英文系统提示
 *
 * @param {string} t
 * @returns {boolean}
 */
export function looksLikeJunkTitle(t) {
  const s = String(t ?? '').trim();
  if (!s) return true;
  if (s.length < 2) return true;
  if (/^\d+$/.test(s)) return true;
  if (/^第\s*\d+\s*轮\s*·/.test(s)) return true;
  if (/^[-–—=*#\s]+$/.test(s)) return true;
  if (s.length > 80) return true;
  // 英文系统提示：一律当垃圾（会话标题基本都是中文）
  if (/^(The|This|You|Please|Current)\s/.test(s) && !/[\u4e00-\u9fff]/.test(s)) return true;
  return false;
}

/**
 * 挑一个能用来区分会话的标题。
 *
 * 顺序：会话自带标题 → 摘要标题里第一个不像垃圾的 → 短 id 兑底。
/**
 * 取一段文本的「第一句话」。
 *
 * 中文按句末标点切，英文按 .!? 切，另外换行也算断句（消息常带 markdown 标题）。
 * 结果截断到 maxLen，超长加省略号。
 *
 * @param {string} text
 * @param {number} [maxLen=36]
 * @returns {string}
 */
export function firstSentence(text, maxLen = 36) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 先找第一个句末标点 / 换行
  const m = s.match(/^[^。！？!?；;\n\r]{1,120}/);
  let head = (m ? m[0] : s).trim();
  // 去掉开头的 markdown 记号（#、-、*、>、` 等）
  head = head.replace(/^[#>*\-\s`]+/, '').trim();
  if (!head) return '';
  if (head.length > maxLen) head = `${head.slice(0, maxLen)}…`;
  return head;
}

/**
 * 挑一个能用来区分会话的标题。
 *
 * **优先用会话第一条用户消息的第一句话**（用户要求的核对方式：直接看到原话）。
 * 这条路径不做"像不像提示词"的过滤 —— 宁可显示一条人设卡的开头，
 * 也不要显示一个无法核对的名字。
 *
 * 兑底顺序：第一条用户消息 → 会话自带标题 → 摘要标题里第一个像样的 → 短 id。
 *
 * @param {{ id?: string, title?: string, first_user_text?: string,
 *   summary_titles?: string, first_summary_title?: string }} row
 * @param {string} shortId
 * @returns {string}
 */
export function pickSessionTitle(row, shortId) {
  // ① 用户消息里挑第一句：优先"不像注入提示词"的，都没有才退回真正的第一条。
  //
  // DSH 每轮都会把 人设卡 / runtime context 当第一条用户消息塞进来，
  // 如果直接取第一条，几十个会话的标题会一模一样（全是"［身份］称用户…"），
  // 用户根本没法核对。所以跳过那些，取用户真正打出去的第一句。
  const joined = String(row?.user_texts ?? '');
  const userTexts = joined ? joined.split('\x1e').map((t) => String(t ?? '')) : [];
  if (userTexts.length === 0 && row?.first_user_text) userTexts.push(String(row.first_user_text));

  for (const t of userTexts) {
    if (!t.trim()) continue;
    if (looksLikePrompt(t)) continue;
    const s = firstSentence(t);
    if (s) return s;
  }

  // ② 会话自带标题
  // 这里仍要挡 prompt：DSH 自动生成的标题本身就是注入内容的开头。
  const raw = String(row?.title ?? '').trim();
  if (raw && !looksLikeJunkTitle(raw) && !looksLikePrompt(raw)) return firstSentence(raw) || raw;

  // ③ 摘要标题里挑第一个像样的
  const sumJoined = String(row?.summary_titles ?? '');
  const candidates = sumJoined ? sumJoined.split('\x1f') : [];
  if (candidates.length === 0 && row?.first_summary_title) candidates.push(String(row.first_summary_title));
  for (const c of candidates) {
    const t = String(c ?? '').trim();
    if (!t) continue;
    if (looksLikeJunkTitle(t)) continue;
    if (looksLikePrompt(t)) continue;
    return firstSentence(t) || t;
  }

  // ④ 实在没招了：退回第一条用户消息的第一句。
  //    全是注入内容时也能让用户认出这是哪一类会话，比一个纯 id 强。
  for (const t of userTexts) {
    const s = firstSentence(t);
    if (s) return s;
  }

  // ⑤ 最后兜底：用「最后活动时间」而不是短 id。
  //
  // 短 id（403aa5）对用户没有任何意义，而且 whale-work 那批自动化会话
  // 标题全被当成注入内容挡掉了、也没入库内容，于是下拉里 31 条全是
  // 「（会话 403aa5）」这种，根本没法选。给个时间至少能按时间定位。
  const when = monthDayOf(row?.last_seen_at);
  if (when) {
    const n = Number(row?.event_count) || 0;
    return n > 0 ? `（${when} · ${n} 条）` : `（${when} · 空会话）`;
  }
  return `（会话 ${shortId}）`;
}

/** 把毫秒时间戳格式化成 `MM-DD HH:mm`，拿不到就返回空串。 */
function monthDayOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 策略值的中文标签，前端与后端共用一份，避免两边不一致。 */
export const STORE_OPTIONS = [
  { value: 'inherit', label: '继承' },
  { value: 'store', label: '存' },
  { value: 'skip', label: '不存' },
];

export const READ_OPTIONS = [
  { value: 'inherit', label: '继承' },
  { value: 'off', label: '关' },
  { value: 'own', label: '仅本会话' },
  { value: 'all', label: '全库' },
];

export const WORKSPACE_STORE_OPTIONS = [
  { value: 'store', label: '存' },
  { value: 'skip', label: '不存' },
];

export const WORKSPACE_READ_OPTIONS = [
  { value: 'off', label: '关' },
  { value: 'own', label: '仅本会话' },
  { value: 'all', label: '全库' },
];

/**
 * 把会话行按工作区分组，供设置页渲染表格。
 *
 * @param {Array<object>} sessionRows sessions + 物化策略
 * @param {Array<object>} workspaceRows workspace_policy 行
 * @returns {Array<{ workspace: string, storeDefault: string, readDefault: string, sessions: Array<object> }>}
 */
export function groupSessions(sessionRows, workspaceRows = []) {
  const wsMap = new Map(
    (workspaceRows ?? []).map((r) => [String(r.workspace ?? ''), r]),
  );
  /** @type {Map<string, any>} */
  const groups = new Map();

  for (const r of sessionRows ?? []) {
    const ws = String(r.workspace ?? '') || '（未知工作区）';
    if (!groups.has(ws)) {
      const wp = wsMap.get(ws);
      groups.set(ws, {
        workspace: ws,
        // 显示名：DSH 自己的工作区标题（「工作区」「微信会话」…）。
        // key 仍然用完整路径，避免同名工作区串在一起。
        workspaceLabel: String(r.workspace_title ?? '').trim() || ws,
        // 兑底与 src/policy.js 的 DEFAULT_STORE / DEFAULT_READ 保持一致：默认全关
        storeDefault: String(wp?.store_default ?? 'skip'),
        readDefault: String(wp?.read_default ?? 'off'),
        sessions: [],
      });
    }
    const shortId = String(r.id ?? '').slice(-6);
    const title = pickSessionTitle(r, shortId);

    groups.get(ws).sessions.push({
      id: String(r.id ?? ''),
      // 短 id 用于消歧：很多会话标题重复（都来自同一段注入的人设卡）
      shortId,
      title,
      events: Number(r.event_count ?? 0) || 0,
      // 真正入库的事件数：0 说明这个会话被策略挡住了，历史一条没进库
      storedEvents: Number(r.stored_events ?? 0) || 0,
      lastSeenAt: Number(r.last_seen_at ?? 0) || 0,
      storeMode: String(r.store_mode ?? 'inherit'),
      readMode: String(r.read_mode ?? 'inherit'),
      effStore: Number(r.eff_store ?? 0) ? 'store' : 'skip',
      effRead: String(r.eff_read ?? 'off'),
      resolvedFrom: String(r.resolved_from ?? 'global'),
      // 标签（core.js#sessionTree 用 \x1f 拼接）
      tags: Array.isArray(r.tags)
        ? r.tags.map(String)
        : String(r.tags ?? '').split('\x1f').filter(Boolean),
      // read_scope=tags 时，该会话实际读的是哪些标签
      readTags: (() => {
        try {
          const parsed = JSON.parse(r.eff_read_tags ?? '[]');
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })(),
    });
  }

  return [...groups.values()].sort((a, b) => {
    // 会话多的、最近活跃的排前面
    if (b.sessions.length !== a.sessions.length) return b.sessions.length - a.sessions.length;
    const la = Math.max(0, ...a.sessions.map((s) => s.lastSeenAt));
    const lb = Math.max(0, ...b.sessions.map((s) => s.lastSeenAt));
    return lb - la;
  });
}

/**
 * 会话表格的汇总数字。
 * @param {Array<object>} groups groupSessions 的结果
 */
export function sessionSummary(groups) {
  let total = 0;
  let storing = 0;
  let reading = 0;
  for (const g of groups ?? []) {
    for (const s of g.sessions ?? []) {
      total += 1;
      if (s.effStore === 'store') storing += 1;
      if (s.effRead !== 'off') reading += 1;
    }
  }
  return { workspaces: (groups ?? []).length, total, storing, reading };
}

/**
 * 概览页的负载。
 *
 * @param {object} stats SessionVault#stats()
 * @param {Array<object>} switches allSwitches()
 * @param {object} [extra]
 */
export function overviewPayload(stats, switches, extra = {}) {
  const bytes = Number(stats?.sizeBytes ?? 0) || 0;
  return {
    dataDir: stats?.dataDir ?? '',
    dbFile: stats?.dbFile ?? '',
    sizeMB: Number((bytes / 1048576).toFixed(2)),
    sizeBytes: bytes,
    sessions: Number(stats?.sessions ?? 0),
    events: Number(stats?.events ?? 0),
    summaries: Number(stats?.summaries ?? 0),
    compactionSummaries: Number(stats?.compactionSummaries ?? 0),
    terms: Number(stats?.terms ?? 0),
    activeTerms: Number(stats?.activeTerms ?? 0),
    edges: Number(stats?.edges ?? 0),
    recalls: Number(stats?.recalls ?? 0),
    latestEventAt: Number(stats?.latest ?? 0),
    byKind: Array.isArray(stats?.byKind) ? stats.byKind : [],
    switches: (switches ?? []).map((s) => ({
      name: s.name,
      on: Boolean(s.on),
      source: s.source,
      label: s.label,
    })),
    lastScan: extra.lastScan ?? null,
    scanProgress: extra.scanProgress ?? null,
    bootAt: extra.bootAt ?? 0,
  };
}

/**
 * 校验来自前端的策略改动，返回可执行的参数或错误。
 *
 * 前端传来的值一定要校验 —— 它会直接写进数据库。
 *
 * @param {object} body
 * @returns {{ ok: true, kind: 'session', args: object } | { ok: true, kind: 'workspace', args: object } | { ok: false, error: string }}
 */
export function parsePolicyChange(body) {
  const b = body && typeof body === 'object' ? body : {};

  if (typeof b.workspace === 'string' && b.workspace) {
    const storeDefault = b.storeDefault;
    const readDefault = b.readDefault;
    if (storeDefault !== undefined && !['store', 'skip'].includes(storeDefault)) {
      return { ok: false, error: `storeDefault 只能是 store/skip，收到 ${String(storeDefault)}` };
    }
    if (readDefault !== undefined && !['off', 'own', 'all'].includes(readDefault)) {
      return { ok: false, error: `readDefault 只能是 off/own/all，收到 ${String(readDefault)}` };
    }
    return {
      ok: true,
      kind: 'workspace',
      args: { workspace: b.workspace, storeDefault, readDefault },
    };
  }

  if (typeof b.sessionId === 'string' && b.sessionId) {
    const storeMode = b.storeMode;
    const readMode = b.readMode;
    if (storeMode !== undefined && !['inherit', 'store', 'skip'].includes(storeMode)) {
      return { ok: false, error: `storeMode 只能是 inherit/store/skip，收到 ${String(storeMode)}` };
    }
    // 读模式除了基础四档，还接受 `tags:a,b`（按标签读，支持多选）。
    //
    // 这里曾经只放行四档，导致前端在「读」下拉里选中「标签：xxx」之后请求被
    // 400 打回 —— 表现就是「新建了标签但选不上、多选根本不出现」。
    // policy.js 的 normalizeReadMode 本来就支持 tags 形式，是这层校验挡掉了。
    if (readMode !== undefined) {
      const base = ['inherit', 'off', 'own', 'all'];
      const isTagMode = String(readMode).startsWith('tags:') && parseTagScope(readMode).length > 0;
      if (!base.includes(readMode) && !isTagMode) {
        return { ok: false, error: `readMode 只能是 inherit/off/own/all 或 tags:标签1,标签2，收到 ${String(readMode)}` };
      }
    }
    return {
      ok: true,
      kind: 'session',
      args: { sessionId: b.sessionId, storeMode, readMode },
    };
  }

  return { ok: false, error: '需要 sessionId 或 workspace' };
}
