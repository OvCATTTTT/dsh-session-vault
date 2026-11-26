#!/usr/bin/env node
/**
 * 把设置页的真实 React 组件渲染成静态 HTML，方便用无头浏览器截图验证布局。
 *
 * 为什么需要：`dev/ui.html` 是早期的设计稿，早就和真实组件不同步了。
 * 改了 CSS / 布局之后，只有渲染真实组件才看得出问题。
 *
 * 做法：用最小的假 React（函数组件直接调用）跑 `lib/client.js`，
 * 拿到 `__tabs` 里的组件，把 `h()` 的树序列化成 HTML，再补上 CSS 变量。
 *
 * 用法：
 *   node scripts/render-preview.mjs <输出目录>
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const OUT = resolve(process.argv[2] ?? 'tmp/preview');
const CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js');

// ── 最小的假 React ────────────────────────────────────────────────────────
function makeReact() {
  const forbidden = (name) => () => {
    throw new Error(`tab 组件里不能用 ${name}`);
  };
  return {
    createElement(type, props, ...children) {
      if (typeof type === 'function') {
        return type({ ...(props ?? {}), children: children.flat() });
      }
      return { tag: type, props: props ?? {}, children: children.flat() };
    },
    useState: forbidden('useState'),
    useEffect: forbidden('useEffect'),
    useLayoutEffect: forbidden('useLayoutEffect'),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    Component: class {
      constructor(props) { this.props = props; this.state = {}; }

      setState(next) { this.state = { ...this.state, ...next }; }
    },
  };
}

function loadTabs() {
  const src = readFileSync(CLIENT, 'utf8');
  let captured = null;
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load: (o) => { captured = o; } },
      confirm: () => false,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
  };
  runInContext(src, createContext(sandbox));
  if (!captured) throw new Error('客户端 bundle 没有调用 __ModuleLoader__.load');
  const mod = captured.factory((name) => {
    if (name === 'react') return makeReact();
    throw new Error(`不应 require(${name})`);
  });
  if (!mod.__tabs) throw new Error('没有导出 __tabs');
  return mod.__tabs;
}

// ── CSS（从 client.js 的 CSS 常量里抠出来，保证和真实样式一致）────────────
function extractCss() {
  const src = readFileSync(CLIENT, 'utf8');
  const m = src.match(/const CSS = `([\s\S]*?)`;\n/);
  if (!m) throw new Error('没找到 CSS 常量');
  // 模板里嵌的是 `${T.xxx}`，这里把 T 的取值替换成 CSS 变量
  const T = {
    text: 'var(--dsw-alias-label-primary)',
    text2: 'var(--dsw-alias-label-secondary)',
    text3: 'var(--dsw-alias-label-tertiary)',
    caption: 'var(--dsw-alias-label-caption)',
    cardFill: 'var(--dsw-alias-settings-card-fill)',
    cardStroke: 'var(--dsw-alias-settings-card-stroke)',
    border: 'var(--dsw-alias-border-l2)',
    border3: 'var(--dsw-alias-border-l3)',
    inputFill: 'var(--dsw-alias-bg-layer-2)',
    hover: 'var(--dsw-alias-interactive-bg-hover)',
    brand: 'var(--dsw-alias-state-business-primary)',
    danger: 'var(--dsw-alias-state-error-primary)',
    fill: 'var(--dsw-alias-fill-tsp-secondary)',
  };
  return m[1].replace(/\$\{T\.(\w+)\}/g, (_, k) => T[k] ?? '');
}

// ── h() 树 → HTML ────────────────────────────────────────────────────────
const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function styleToCss(style) {
  if (!style || typeof style !== 'object') return '';
  return Object.entries(style).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`).join(';');
}

function attrsOf(props) {
  const out = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'children' || k === 'key' || v === undefined || v === null) continue;
    if (k === 'style') { const s = styleToCss(v); if (s) out.push(`style="${esc(s)}"`); continue; }
    if (k === 'className') { out.push(`class="${esc(v)}"`); continue; }
    if (/^on[A-Z]/.test(k)) continue; // 事件不要
    if (k === 'value' || k === 'defaultValue') { out.push(`value="${esc(v)}"`); continue; }
    if (typeof v === 'boolean') { if (v) out.push(k); continue; }
    if (typeof v === 'string' || typeof v === 'number') out.push(`${k}="${esc(v)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function toHtml(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  const { tag, props = {}, children = [] } = node;
  const inner = children.map(toHtml).join('');
  if (VOID.has(tag)) return `<${tag}${attrsOf(props)}>`;
  return `<${tag}${attrsOf(props)}>${inner}</${tag}>`;
}

// ── 造点假数据（够看出布局就行）─────────────────────────────────────────
const now = Date.now();
const noop = () => {};

const sessionGroups = [{
  workspace: 'D:\\work\\project',
  workspaceLabel: '工作区',
  storeDefault: 'skip',
  readDefault: 'off',
  sessions: [
    {
      id: 'session-a141dc07', shortId: 'a141dc', title: '我想要给你搭建一个向量记忆库以便存储所有的记忆',
      events: 1631, storedEvents: 1360, storeMode: 'store', readMode: 'all',
      effStore: 'store', effRead: 'all', resolvedFrom: 'session', lastSeenAt: now,
      tags: ['obsidian', '方案'],
    },
    {
      id: 'session-1c625848', shortId: '1c6258', title: 'OpenClaw 呀，最近挺火。你想先处理哪一块',
      events: 1520, storedEvents: 0, storeMode: 'inherit', readMode: 'inherit',
      effStore: 'skip', effRead: 'off', resolvedFrom: 'workspace', lastSeenAt: now - 3600e3,
      tags: ['obsidian'],
    },
    {
      id: 'session-97cad241', shortId: '97cad2', title: '在线确认',
      events: 6, storedEvents: 6, storeMode: 'inherit', readMode: 'inherit',
      effStore: 'skip', effRead: 'off', resolvedFrom: 'global', lastSeenAt: now - 86400e3,
      tags: [],
    },
  ],
}];

const sessionOptions = [['', '全库（整体主题）'], ['session-a141dc07', '工作区 · 搭建向量记忆库'], ['session-1c625848', '工作区 · OpenClaw']];

const termsRows = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1, term: ['记忆', '插件', '关键词', '置顶', '迁移', 'obsidian', '摘要', '检索'][i], df: 40 - i * 4, muted: 0, pinned: null, degree: 300 - i * 20,
}));

const msgs = [
  { seq: 15, kind: 'user', text: 'The approval policy changed from "ask" to "never"' },
  { seq: 16, kind: 'user', text: '我想要给你搭建一个向量记忆库以便存储所有的记忆，有没有什么方案' },
  { seq: 17, kind: 'assistant', text: '我建议三层结构：关键词 → 摘要 → 原文。这样可以先粗召回再展开原话。' },
  { seq: 18, kind: 'tool-result', text: '== 恢复后 ==\n  bundles 项数: 16' },
];

const recallRows = [
  {
    id: 19, ts: now, trigger: 'auto', query: '新开一个tab',
    hits: [
      { id: 5060, score: 0.49, title: '开工。先做数据层：标签表 + 读策略支持标签。（续 1）', sessionTitle: '工作区 · 向量记忆库' },
      { id: 5049, score: 0.42, title: '我想要给你搭建一个向量记忆库以便存储所有的记忆', sessionTitle: '工作区 · 向量记忆库' },
    ],
    injected: 1, elapsedMs: 5, sessionTitle: '工作区 · 测试',
  },
  {
    id: 18, ts: now - 300e3, trigger: 'auto', query: '我怎么验证我发消息联想到了之前的东西',
    hits: [{ id: 5039, score: 0.77, title: '继续。先打包，再装进一个全新的临时 profile', sessionTitle: '工作区 · 打包测试' }],
    injected: 1, elapsedMs: 12, sessionTitle: '工作区 · 测试',
  },
  { id: 17, ts: now - 600e3, trigger: 'auto', query: 'onmatch吧', hits: [], injected: 0, elapsedMs: 1, sessionTitle: '工作区 · 测试' },
];

// ── 渲染 ────────────────────────────────────────────────────────────────
const tabs = loadTabs();
const css = extractCss();
mkdirSync(OUT, { recursive: true });

const PAGES = {
  'overview.html': toHtml(tabs.Overview({
    data: {
      dataDir: 'D:\\work\\project\\.dsh\\session-vault',
      sessions: 12, events: 3204, summaries: 486, activeTerms: 1382, edges: 4120,
      sizeMB: 18.6, latestEventAt: now, recalls: 37,
      lastScan: { ms: 82, newEvents: 46 },
      switches: [{ name: 'autoHint', on: true }],
      byKind: [
        { kind: 'tool-result', n: 1204 }, { kind: 'tool-call', n: 1108 },
        { kind: 'user', n: 402 }, { kind: 'assistant', n: 380 },
        { kind: 'title', n: 96 }, { kind: 'compaction-summary', n: 14 },
      ],
    },
    busy: false, onScan: noop, onToggle: noop, scanProgress: null,
  })),
  'sessions.html': toHtml(tabs.SessionsTab({
    data: { groups: sessionGroups, summary: { workspaces: 1, total: 3, storing: 1, reading: 2 }, allTags: [{ tag: 'obsidian', sessions: 2 }, { tag: '方案', sessions: 1 }] },
    busy: false, onChange: noop, expanded: {}, onExpand: noop,
    tagEdit: null, onTagEdit: noop, onAddTag: noop, onRemoveTag: noop,
  })),
  'terms.html': toHtml(tabs.TermsTab({
    data: {
      rows: termsRows,
      sessionId: '',
      words: { total: 348, byLen: { 2: 310, 3: 23, 4: 15 }, epoch: 1 },
    },
    busy: false, q: '', script: 'all', wordLen: 0,
    sessionId: '', sessionOptions, onSearch: noop, onSearchInput: noop,
    onPatch: noop, onMuteAll: noop, onScript: noop, onSession: noop, onWordLen: noop,
  })),
  'pins.html': toHtml(tabs.PinTab({
    pins: [{ id: 1, title: 'Obsidian 库位置', note: '库路径', mode: 'onMatch', chars: 62 }],
    sessionOptions: [['', '（选一个会话）'], ['session-a141dc07', '工作区 · 搭建向量记忆库']],
    sessionId: 'session-a141dc07',
    msgs, sums: [{ id: 7, title: '搭记忆库', chars: 120, body: '用户要做向量记忆库' }],
    source: 'messages', msgsOnly: true,
    sel: { from: 16, to: 17 }, title: '记忆库方案', mode: 'onMatch', busy: false,
    onPickSession: noop, onPickMsg: noop, onPickSummary: noop, onSource: noop,
    onToggleMsgsOnly: noop, onTitle: noop, onMode: noop, onSave: noop, onDelete: noop, onPatch: noop,
  })),
  'recalls.html': toHtml(tabs.RecallTab({
    rows: recallRows, busy: false, sessionOptions: [['', '全部会话'], ['session-a141dc07', '工作区 · 测试']],
    sessionId: '', onlyInjected: false, onSession: noop, onToggleInjected: noop, onRefresh: noop,
  })),
  'surfcore.html': toHtml(tabs.SurfcoreTab({
    data: {
      ok: true,
      mode: 'mirror',
      characterName: '示例角色',
      characterId: 'char-mvtzbn3r',
      card: {
        total: 325,
        updatedAt: '2026-11-25T22:19:21.739Z',
        byKind: { owner: 220, event: 98, promise: 6, firstMeet: 1 },
        stats: {
          forgotten: 14, decayed: 12, ingested: 339,
          lastDecayAt: '2026-11-25T20:04:14.894Z',
        },
      },
      mirror: { total: 339, inCard: 325, forgotten: 14, syncedAt: now, empty: false },
    },
    rows: {
      total: 3,
      rows: [
        {
          id: 'mem_9a5ec04ae4c710', inCard: true, kind: 'firstMeet', title: '最早和主人说话',
          text: '鱼在吗', tags: ['owner', 'first', 'qq'], importance: 100,
          importanceReasons: ['主人私聊', '直接对你说的', '第一次 / 最早'],
          sensitive: false, private: true, pinned: true, anchor: true, clarity: 'vivid',
          recallCount: 11, decaySteps: 0, speaker: '主人', platform: 'qq',
          createdAt: '2026-10-30T07:59:30.187Z',
        },
        {
          id: 'mem_a1b2c3', inCard: true, kind: 'owner', title: '和主人：以后我说的群都是这个群',
          text: '以后我说的群都是这个群', tags: ['owner'], importance: 58,
          importanceReasons: ['主人私聊'], sensitive: false, private: false, pinned: false,
          clarity: 'vivid', recallCount: 4, decaySteps: 0, speaker: '主人', platform: 'qq',
          createdAt: '2026-11-20T10:00:00.000Z',
        },
        {
          id: 'mem_forgotten1', inCard: false, kind: 'event', title: 'B站动态：人，进来',
          text: '人，进来', tags: [], importance: 1, importanceReasons: ['信息量低'],
          sensitive: false, private: false, pinned: false, clarity: 'faded',
          recallCount: 0, decaySteps: 3, speaker: '', platform: 'bili',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    },
    busy: false, q: '', kind: '', onlyForgotten: false,
    openIds: { 'mem_9a5ec04ae4c710': true },
    revealed: {},
    kindOptions: [['', '全部类型'], ['owner', 'owner（220）'], ['event', 'event（98）']],
    onToggle: noop, onReveal: noop, onSearch: noop, onClearSearch: noop, onSearchInput: noop,
    onKind: noop, onToggleForgotten: noop, onMode: noop, onSync: noop, onRefresh: noop, onClear: noop,
  })),
};

const vars = `
:root{
  --dsw-alias-label-primary:#1c1f23; --dsw-alias-label-secondary:#4a5057;
  --dsw-alias-label-tertiary:#6b7280; --dsw-alias-label-caption:#9aa1a9;
  --dsw-alias-bg-layer-2:#ffffff; --dsw-alias-border-l2:#e3e6ea; --dsw-alias-border-l3:#eef0f3;
  --dsw-alias-fill-tsp-secondary:rgba(0,0,0,.04);
  --dsw-alias-interactive-bg-hover:rgba(0,0,0,.06);
  --dsw-alias-state-business-primary:#4b7bec; --dsw-alias-state-error-primary:#e05c5c;
  --dsw-alias-settings-card-fill:#ffffff; --dsw-alias-settings-card-stroke:#e3e6ea;
}
body{margin:0;padding:16px;background:#f5f6f8;font-family:"Microsoft YaHei",system-ui,sans-serif}
`;

for (const [name, body] of Object.entries(PAGES)) {
  writeFileSync(join(OUT, name), `<!doctype html><meta charset="utf-8"><style>${vars}${css}</style><div class="sv-root">${body}</div>`, 'utf8');
  console.log(`  ${name}  ${Math.round(Buffer.byteLength(body) / 1024)} KB`);
}
console.log(`\n输出 → ${OUT}`);
