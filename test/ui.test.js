import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * 用假的 React 真渲染客户端 bundle 里的各个 tab。
 *
 * 为什么需要：单测能查静态字符串（`style:` 不能是字符串、不能用 exports），
 * 但抓不到"只有渲染时才炸"的错误。真实踩过两次：
 *   · `style: 'margin:0'` 传字符串 → 整个 tab 崩
 *   · 把 `{value,label}` 传给只认 `[值,标签]` 元组的 Sel → "not iterable"，整块崩
 *
 * 这里把 React 换成最小实现：函数组件直接调用，宿主元素返回普通对象。
 * 顺带**禁止 tab 里用 hooks** —— 它们是被当普通函数调用的，
 * 用 useState 会破坏 hooks 顺序（运维页崩过一次）。
 *
 * @returns {{ tabs: Record<string, Function>, mod: any }}
 */
function loadClientBundle() {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  let captured = null;
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load: (opts) => { captured = opts; } },
      confirm: () => false,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }),
  };
  runInContext(src, createContext(sandbox));
  assert.ok(captured, '客户端 bundle 应调用 __ModuleLoader__.load');

  const forbidden = (name) => () => {
    throw new Error(`tab 组件里不能用 ${name}：它们是被当普通函数调用的，hooks 会破坏顺序`);
  };
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props ?? {}), children });
      return { type, props: props ?? {}, children };
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
  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`不应 require(${name})`);
  });
  assert.ok(mod.__tabs, '应导出 __tabs 供测试渲染');
  return { tabs: mod.__tabs, mod };
}

const FAKE_SESSIONS = {
  groups: [{
    workspace: 'D:\\ws',
    workspaceLabel: '工作区',
    storeDefault: 'skip',
    readDefault: 'off',
    sessions: [{
      id: 'session-aaaaaa', shortId: 'aaaaaa', title: '聊 obsidian', events: 10, storedEvents: 8,
      storeMode: 'inherit', readMode: 'inherit', effStore: 'skip', effRead: 'off', resolvedFrom: 'global',
      lastSeenAt: Date.now(),
    }],
  }],
  summary: {
    workspaces: 1, total: 1, storing: 0, reading: 0,
  },
};

test('客户端各个 tab 都能渲染，不抛错', () => {
  const { tabs } = loadClientBundle();
  const noop = () => {};

  // TermsTab 是最容易出事的：它带下拉 + 列表 + 输入框
  const termsOut = tabs.TermsTab({
    data: {
      rows: [{
        id: 1, term: 'obsidian', df: 49, muted: 0, pinned: null, degree: 56, sessionDf: 49,
      }],
      sessionId: '',
    },
    busy: false,
    q: '',
    script: 'all',
    sessionId: '',
    sessionOptions: [['', '全库'], ['session-aaaaaa', '工作区 · 聊 obsidian']],
    onSearch: noop,
    onSearchInput: noop,
    onPatch: noop,
    onMuteAll: noop,
    onScript: noop,
    onSession: noop,
  });
  assert.ok(Array.isArray(termsOut), 'TermsTab 应返回节点数组');
  {
    // 关键词页的列头：原来只写 `df 40` / `连 300`，缩写没人看得懂
    const t = JSON.stringify(termsOut);
    for (const head of ['关键词', '出现次数', '连接度']) {
      assert.ok(t.includes(head), `关键词页缺少列头「${head}」`);
    }
    // 单元格文本必须是纯数字；注意别用 includes('df ') 做判断 ——
    // 说明文字里的「idf 权重」也会命中，那种误报查起来很费劲。
    assert.doesNotMatch(t, /"df \d/, '不该再显示「df N」这种缩写');
    assert.doesNotMatch(t, /"连 \d/, '不该再显示「连 N」这种缩写');
  }

  const sessionsOut = tabs.SessionsTab({
    data: FAKE_SESSIONS, busy: false, onChange: noop, expanded: {}, onExpand: noop,
  });
  assert.ok(Array.isArray(sessionsOut));

  const opsOut = tabs.OpsTab({
    data: { dataDir: 'D:/x' },
    busy: false,
    ops: '',
    onMigrate: noop,
    onRebuild: noop,
    onExport: noop,
    onResetPolicies: noop,
    target: '',
    onTargetChange: noop,
  });
  assert.ok(Array.isArray(opsOut));

  const pinOut = tabs.PinTab({
    pins: [{
      id: 1, title: 'Obsidian 库位置', note: '库路径', mode: 'onMatch', chars: 40,
    }],
    sessionOptions: [['', '（选一个会话）'], ['session-aaaaaa', '工作区 · 聊 obsidian']],
    sessionId: 'session-aaaaaa',
    msgs: [{ seq: 1, kind: 'user', text: '我的库在 D:\notes' }],
    sums: [{
      id: 7, title: '搭记忆库', chars: 120, body: '用户要做向量记忆库', seq_from: 1, seq_to: 2,
    }],
    source: 'messages',
    msgsOnly: true,
    sel: { from: 1, to: 1 },
    title: '库位置',
    mode: 'onMatch',
    busy: false,
    onPickSession: noop,
    onPickMsg: noop,
    onPickSummary: noop,
    onSource: noop,
    onToggleMsgsOnly: noop,
    onTitle: noop,
    onMode: noop,
    onSave: noop,
    onDelete: noop,
    onPatch: noop,
  });
  assert.ok(Array.isArray(pinOut), 'PinTab 应返回节点数组');
  {
    const t = JSON.stringify(pinOut);
    for (const head of ['置顶内容', '字数']) {
      assert.ok(t.includes(head), `置顶页缺少列头「${head}」`);
    }
  }

  const recallOut = tabs.RecallTab({
    rows: [{
      id: 1,
      ts: Date.now(),
      trigger: 'auto',
      query: '我怎么验证联想',
      hits: [{
        id: 5039, score: 0.77, title: '先打包，再装进一个全新的临时 profile', sessionTitle: '工作区 · 测试',
      }],
      injected: 1,
      elapsedMs: 12,
      sessionTitle: '工作区 · 测试',
    }, {
      id: 2,
      ts: Date.now(),
      trigger: 'auto',
      query: 'onmatch吧',
      hits: [],
      injected: 0,
      elapsedMs: 1,
    }],
    busy: false,
    sessionOptions: [['', '全部会话'], ['s1', '工作区 · 测试']],
    sessionId: '',
    onlyInjected: false,
    onSession: noop,
    onToggleInjected: noop,
    onRefresh: noop,
  });
  assert.ok(Array.isArray(recallOut), 'RecallTab 应返回节点数组');
  // 命中列必须显示摘要标题，不能只甩一个内部 id —— 用户看不懂 #5039
  const recallText = JSON.stringify(recallOut);
  assert.ok(
    recallText.includes('先打包，再装进一个全新的临时 profile'),
    '联想记录应显示命中摘要的标题',
  );
  assert.ok(!recallText.includes('#5039'), '不该把内部 id 当主文案显示');
  // 列表必须有列头，否则分不清哪列是什么（尤其「注入」「耗时」这种数字列）
  for (const head of ['时间', '你说了什么', '联想到的摘要', '注入', '耗时']) {
    assert.ok(recallText.includes(head), `联想页缺少列头「${head}」`);
  }

  const scOut = tabs.SurfcoreTab({
    data: {
      ok: true,
      mode: 'mirror',
      characterName: '示例角色',
      characterId: 'char-x',
      card: { total: 325, updatedAt: '2026-11-25T22:19:21.739Z', byKind: { owner: 220, event: 98 }, stats: { forgotten: 14, decayed: 12, ingested: 339, lastDecayAt: '2026-11-25T20:04:14.894Z' } },
      mirror: { total: 339, inCard: 325, forgotten: 14, syncedAt: Date.now(), empty: false },
    },
    rows: {
      total: 2,
      rows: [
        { id: 'mem_1', inCard: true, kind: 'owner', title: '和主人说话', text: '鱼在吗', tags: ['owner'], importance: 100, importanceReasons: ['主人私聊'], sensitive: false, private: true, pinned: true, recallCount: 11, decaySteps: 0, clarity: 'vivid', speaker: '主人', platform: 'qq', createdAt: '2026-10-30T07:59:30.187Z' },
        { id: 'mem_2', inCard: false, kind: 'event', title: 'B站动态', text: '人，进来', tags: [], importance: 1, importanceReasons: [], sensitive: false, private: false, pinned: false, recallCount: 0, decaySteps: 2, clarity: 'faded', speaker: '', platform: 'bili', createdAt: '2026-11-01T00:00:00.000Z' },
      ],
    },
    busy: false,
    q: '',
    kind: '',
    onlyForgotten: false,
    openIds: { mem_2: true },
    revealed: {},
    kindOptions: [['', '全部类型'], ['owner', 'owner（220）']],
    onToggle: noop,
    onReveal: noop,
    onSearch: noop,
    onClearSearch: noop,
    onSearchInput: noop,
    onKind: noop,
    onToggleForgotten: noop,
    onMode: noop,
    onSync: noop,
    onRefresh: noop,
    onClear: noop,
  });
  assert.ok(Array.isArray(scOut), 'SurfcoreTab 应返回节点数组');
  assert.ok(scOut.length >= 3, 'SurfcoreTab 至少 3 张卡片');
  {
    const t = JSON.stringify(scOut);
    for (const head of ['类型', '记忆内容', '重要', '记录时间']) {
      assert.ok(t.includes(head), `记忆卡页缺少列头「${head}」`);
    }
  }

  const overviewOut = tabs.Overview({
    data: {
      sessions: 1, events: 10, summaries: 5, terms: 20, edges: 30, sizeMB: 1, dataDir: 'D:/x',
      switches: [], byKind: [],
    },
    busy: false,
    onScan: noop,
    onToggle: noop,
    scanProgress: null,
  });
  assert.ok(overviewOut, 'Overview 应返回节点');
});

test('TermsTab 的会话下拉接受 [值,标签] 元组（不能传对象）', () => {
  const { tabs } = loadClientBundle();
  const noop = () => {};
  // 传对象数组是曾经的 bug：Sel 会 `options.map(([v,label]) => …)` 解构，直接抛错
  assert.throws(
    () => tabs.TermsTab({
      data: { rows: [] },
      busy: false,
      q: '',
      script: 'all',
      sessionId: '',
      sessionOptions: [{ value: 'a', label: 'b' }],
      onSearch: noop,
      onSearchInput: noop,
      onPatch: noop,
      onMuteAll: noop,
      onScript: noop,
      onSession: noop,
    }),
    /not iterable|undefined/,
    '传对象应立刻报错，好让写错的地方暴露出来',
  );
});


import {
  groupSessions, sessionSummary, overviewPayload, parsePolicyChange,
  STORE_OPTIONS, READ_OPTIONS,
} from '../src/ui-data.js';
import { isLoopback, sameOrigin } from '../src/http.js';
import { registerRoutes, API_PREFIX } from '../src/routes.js';
import { SessionVault } from '../src/core.js';
import { materializePolicy } from '../src/policy.js';
import { insertSummary, indexSummaryTerms } from '../src/indexer.js';

// ─────────────────────────────────────────────────────────────────────────
// 纯函数层
// ─────────────────────────────────────────────────────────────────────────

test('groupSessions：按工作区分组、带默认值、按会话数排序', () => {
  const rows = [
    { id: 's1', workspace: 'A', title: '甲', event_count: 5, last_seen_at: 100, store_mode: 'inherit', read_mode: 'inherit', eff_store: 1, eff_read: 'all', resolved_from: 'global' },
    { id: 's2', workspace: 'A', title: '乙', event_count: 2, last_seen_at: 200, store_mode: 'skip', read_mode: 'own', eff_store: 0, eff_read: 'own', resolved_from: 'session' },
    { id: 's3', workspace: 'B', title: '丙', event_count: 9, last_seen_at: 50, store_mode: 'inherit', read_mode: 'inherit', eff_store: 1, eff_read: 'all', resolved_from: 'workspace' },
  ];
  const ws = [
    { workspace: 'A', store_default: 'skip', read_default: 'own' },
    { workspace: 'B', store_default: 'store', read_default: 'all' },
  ];
  const g = groupSessions(rows, ws);

  assert.equal(g.length, 2);
  assert.equal(g[0].workspace, 'A', '会话多的排前');
  assert.equal(g[0].storeDefault, 'skip');
  assert.equal(g[0].readDefault, 'own');
  assert.equal(g[0].sessions.length, 2);
  assert.equal(g[0].sessions[0].shortId, 's1'.slice(-6));
  assert.equal(g[0].sessions[1].effStore, 'skip');
  assert.equal(g[0].sessions[1].effRead, 'own');
  assert.equal(g[0].sessions[1].resolvedFrom, 'session');
  assert.equal(g[1].workspace, 'B');
});

test('groupSessions：缺工作区的会话归到「未知工作区」', () => {
  const g = groupSessions([{ id: 'x', workspace: null, title: null, event_count: 0 }], []);
  assert.equal(g.length, 1);
  assert.equal(g[0].workspace, '（未知工作区）');
  assert.equal(g[0].sessions[0].title, '（会话 x）', '无标题时用短 id 兜底');
});

test('groupSessions：DSH 生成的标题像提示词时改用摘要标题', () => {
  const g = groupSessions([{
    id: 'session-abcdef',
    workspace: 'W',
    title: 'Current runtime context. This snapshot supersedes',
    first_summary_title: '分析错误原因',
    event_count: 3,
  }], []);
  assert.equal(g[0].sessions[0].title, '分析错误原因');
});

test('groupSessions：标题和摘要标题都不可用时给出可辨识的兜底', () => {
  const g = groupSessions([{
    id: 'session-abcdef',
    workspace: 'W',
    title: '<system-reminder>',
    first_summary_title: null,
    event_count: 0,
  }], []);
  assert.equal(g[0].sessions[0].title, '（会话 abcdef）');
});

test('groupSessions：摘要标题是「第 0 轮 · 工具记录」这类垃圾时继续往下挑', () => {
  const g = groupSessions([{
    id: 'session-abcdef',
    workspace: 'W',
    title: null,
    // 用 \x1f 拼接，和 core.js#sessionTree 的 GROUP_CONCAT 一致
    summary_titles: ['第 0 轮 · 工具记录', '1111111111111111', '排查沙箱 ACL 权限'].join('\x1f'),
  }], []);
  assert.equal(g[0].sessions[0].title, '排查沙箱 ACL 权限');
});

test('groupSessions：默认工作区策略是「不存 / 不读」', () => {
  const g = groupSessions([{ id: 's1', workspace: 'W' }], []);
  assert.equal(g[0].storeDefault, 'skip', '默认必须不存');
  assert.equal(g[0].readDefault, 'off', '默认必须不读');
  assert.equal(g[0].sessions[0].effStore, 'skip');
  assert.equal(g[0].sessions[0].effRead, 'off');
});

test('sessionSummary 统计 存/读 数量', () => {
  const g = groupSessions([
    { id: 'a', workspace: 'W', eff_store: 1, eff_read: 'all' },
    { id: 'b', workspace: 'W', eff_store: 0, eff_read: 'off' },
    { id: 'c', workspace: 'W', eff_store: 1, eff_read: 'own' },
  ], []);
  const s = sessionSummary(g);
  assert.deepEqual(s, { workspaces: 1, total: 3, storing: 2, reading: 2 });
});

test('overviewPayload 换算体积与数字，缺字段不炸', () => {
  const p = overviewPayload(
    { dataDir: 'D:/m', sizeBytes: 1048576, sessions: 3, events: 10, summaries: 2, byKind: [{ kind: 'user', n: 4 }] },
    [{ name: 'autoHint', on: true, source: 'db', label: '主动联想' }],
    { lastScan: { ms: 12, newEvents: 3 } },
  );
  assert.equal(p.sizeMB, 1);
  assert.equal(p.switches[0].on, true);
  assert.equal(p.lastScan.ms, 12);
  assert.equal(p.byKind[0].kind, 'user');

  const empty = overviewPayload(null, null);
  assert.equal(empty.sizeMB, 0);
  assert.deepEqual(empty.switches, []);
});

test('parsePolicyChange：合法会话 / 工作区', () => {
  const a = parsePolicyChange({ sessionId: 's1', storeMode: 'skip', readMode: 'own' });
  assert.equal(a.ok, true);
  assert.equal(a.kind, 'session');
  assert.deepEqual(a.args, { sessionId: 's1', storeMode: 'skip', readMode: 'own' });

  const b = parsePolicyChange({ workspace: 'W', storeDefault: 'skip', readDefault: 'all' });
  assert.equal(b.ok, true);
  assert.equal(b.kind, 'workspace');
});

test('parsePolicyChange：非法值被拒（这些值会直接写库，必须校验）', () => {
  assert.equal(parsePolicyChange({ sessionId: 's', storeMode: 'nope' }).ok, false);
  assert.equal(parsePolicyChange({ sessionId: 's', readMode: 'everything' }).ok, false);
  assert.equal(parsePolicyChange({ workspace: 'W', storeDefault: 'yes' }).ok, false);
  assert.equal(parsePolicyChange({ workspace: 'W', readDefault: 'own' }).ok, true);
  assert.equal(parsePolicyChange({}).ok, false);
  assert.equal(parsePolicyChange(null).ok, false);
});

test('选项表与后端校验保持一致（防止前端给出非法值）', () => {
  for (const o of STORE_OPTIONS) {
    assert.ok(['inherit', 'store', 'skip'].includes(o.value), `STORE_OPTIONS 非法值 ${o.value}`);
  }
  for (const o of READ_OPTIONS) {
    assert.ok(['inherit', 'off', 'own', 'all'].includes(o.value), `READ_OPTIONS 非法值 ${o.value}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP 小工具
// ─────────────────────────────────────────────────────────────────────────

test('isLoopback 认 IPv4 / IPv6 / IPv4-mapped，拒绝外网地址', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.5.6.7' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.5' } }), false);
  assert.equal(isLoopback({ socket: {} }), false);
  assert.equal(isLoopback({}), false);
});

test('sameOrigin：缺 Origin 视为可信；跨站拒绝', () => {
  assert.equal(sameOrigin({ headers: {} }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:8790', host: '127.0.0.1:8790' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://evil.com', host: '127.0.0.1:8790' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'not-a-url', host: 'x' } }), false);
});

// ─────────────────────────────────────────────────────────────────────────
// 集成：起一个真 HTTP 服务，打真实路由
// ─────────────────────────────────────────────────────────────────────────

/** 建一个带少量数据的库。 */
function seedVault(dir) {
  const vault = new SessionVault({ dataDir: dir, sessionsRoot: join(dir, 'none') });
  const db = vault.open();
  const now = Date.now();

  db.prepare(
    `INSERT INTO sessions(id, workspace, workspace_label, title, created_at, last_seen_at, event_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('session-aaa111', 'D:\\ws1', 'D:\\ws1', '搭建记忆库方案', now, now, 3);

  db.prepare(
    `INSERT INTO sessions(id, workspace, workspace_label, title, created_at, last_seen_at, event_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('session-bbb222', 'D:\\ws2', 'D:\\ws2', 'Current runtime context', now, now - 1000, 1);

  const insEvent = db.prepare(
    `INSERT INTO events(session_id, workspace, seq, kind, role, turn, ts, text, meta, ukey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  insEvent.run('session-aaa111', 'D:\\ws1', 1, 'user', 'user', 1, now, '我要做向量记忆库', 'k1');
  insEvent.run('session-aaa111', 'D:\\ws1', 2, 'assistant', 'assistant', 1, now, '好的，先建库', 'k2');
  insEvent.run('session-bbb222', 'D:\\ws2', 1, 'user', 'user', 1, now, 'Current runtime context', 'k3');

  const s1 = insertSummary(db, {
    sessionId: 'session-aaa111', kind: 'turn', title: '搭建记忆库方案',
    body: '用户要做向量记忆库，助手给出方案', hash: 'h1', periodFrom: now, seqFrom: 1, seqTo: 2,
  });
  indexSummaryTerms(db, s1, '用户要做向量记忆库，助手给出方案');

  const s2 = insertSummary(db, {
    sessionId: 'session-bbb222', kind: 'turn', title: '分析错误原因',
    body: '分析错误原因并修复', hash: 'h2',
  });
  indexSummaryTerms(db, s2, '分析错误原因并修复');

  materializePolicy(db, 'session-aaa111', 'D:\\ws1');
  materializePolicy(db, 'session-bbb222', 'D:\\ws2');
  return vault;
}

/** 起服务：用假 webServer 收路由，再挂到真 http 上。 */
async function startServer(vault) {
  const routes = new Map();
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    },
    get: () => null,
  };
  const reg = registerRoutes(ctx, {
    getVault: () => vault,
    getConfig: () => ({ autoHint: true }),
    log: () => {},
    getLastScan: () => null,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    await handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    reg,
    routes,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('设置页 API：完整链路', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-ui-'));
  const vault = seedVault(dir);
  const srv = await startServer(vault);
  t.after(async () => {
    await srv.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 路由都注册上了（界面是 React 组件，不再由宿主提供 HTML 页面）
  // 0.5.0 起新增 4 条：purge-preview / words / words/discover / backup
  assert.equal(srv.reg.registered, 29, `应注册 29 条，实际 ${srv.reg.registered}`);
  assert.ok(!srv.routes.has(`${API_PREFIX}/ui`), '不再托管 UI 页面');
  assert.ok(srv.routes.has(`${API_PREFIX}/overview`));
  assert.ok(srv.routes.has(`${API_PREFIX}/terms`));
  assert.ok(srv.routes.has(`${API_PREFIX}/rebuild`));
  assert.ok(srv.routes.has(`${API_PREFIX}/migrate`));

  // 客户端组件必须存在且是 React 版本（不是 iframe）
  const clientSrc = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');
  // 加载器全局名必须实测过：
  //   · 真实 Web 外壳上是 window.__ModuleLoader__（两个下划线）
  //   · 官方模板里的 `_ModuleLoader__`（一个）照抄会 ReferenceError，
  //     而这个错误会让整个 web boot 报「entry did not activate」，应用起不来
  assert.match(clientSrc, /window\.__ModuleLoader__/, '必须优先取 window.__ModuleLoader__');
  assert.match(clientSrc, /loader\.load\(\{/, '必须通过探测到的 loader 调用 load');
  assert.match(clientSrc, /try\s*\{/, 'load 必须包在 try/catch 里，界面坏不能拖垮宿主启动');
  assert.doesNotMatch(
    clientSrc,
    /^\s*_ModuleLoader__\.load\(/m,
    '不许直接裸调 _ModuleLoader__（少一个下划线会让应用起不来）',
  );
  assert.match(clientSrc, /id: 'dsh-session-vault'/, '模块 id 必须等于包名');
  assert.match(clientSrc, /settings\.section/);
  assert.doesNotMatch(clientSrc, /createElement\('iframe'|h\('iframe'/, '不许再用 iframe');
  assert.match(clientSrc, /--dsw-alias-/, '样式必须用宿主主题 token');
  assert.doesNotMatch(clientSrc, /require\('@deepseek-ai\/dsh-client-ui/, '不许 require 宿主 UI 包');
  assert.match(clientSrc, /getDerivedStateFromError/, '必须有错误边界，否则组件一抛错整块变空白');
  // factory 必须返回命名空间；`exports.x = ...` 在 hand-written bundle 里是 ReferenceError
  assert.match(clientSrc, /return \{\s*\n\s*inject,/, 'factory 必须 return { inject, apply }');
  assert.doesNotMatch(clientSrc, /^\s*exports\.\w+\s*=/m, '手写 bundle 里没有 exports 变量');
  // 只读操作不用确认，破坏性操作必须确认 —— 否则用户点一下就执行了
  //
  // 切函数体不能用 `const X = useCallback(... )}, [` 这种正则：函数体内可能有
  // `}, '文案'), [deps]`，非贪婪会一路吃到下一个函数，断言就变成假的。
  // 这里按「到下一个同级 `const xxx = useCallback` 为止」来切。
  const bodyOf = (src, name) => {
    const start = src.indexOf(`const ${name} = useCallback`);
    if (start < 0) return '';
    const rest = src.slice(start + 1);
    const next = rest.search(/\n\s+const \w+ = useCallback|\n\s+\/\/ ──/);
    return next < 0 ? rest : rest.slice(0, next);
  };

  for (const fn of ['onPurge', 'onResetPolicies', 'onMigrate', 'onRebuild']) {
    const body = bodyOf(clientSrc, fn);
    assert.ok(body, `${fn} 的函数体没找到（改名了？）`);
    assert.match(body, /window\.confirm/, `${fn} 是破坏性操作，必须弹确认`);
  }
  // 导出是只读的，不该拿弹窗烦人
  assert.doesNotMatch(
    bodyOf(clientSrc, 'onExport'),
    /window\.confirm/,
    '导出是只读操作，不该弹确认',
  );

  // hooks 只能出现在根组件里：OpsTab 是普通函数调用，带 useState 会让运维页崩
  assert.match(clientSrc, /migrateTarget/, '迁移输入框的状态必须由根组件持有');
  assert.ok(clientSrc.includes('（${k}）'), '重名会话要加序号');

  // 三个页面的会话下拉必须走同一个生成函数：
  // 各写一遍会导致宽度不一致，而且重名会话（同一分钟批量创建的）没法区分。
  assert.match(clientSrc, /function sessionOptionList\(/, '会话下拉选项应有统一生成函数');
  assert.equal(
    (clientSrc.match(/sessionOptionList\(sessions\?\.groups/g) ?? []).length,
    3,
    '关键词 / 置顶 / 联想 三个页面都应使用 sessionOptionList',
  );

  // ── 概览 ──
  const ov = await (await fetch(`${srv.base}${API_PREFIX}/overview`)).json();
  assert.equal(ov.ok, true);
  assert.equal(ov.data.sessions, 2);
  assert.equal(ov.data.events, 3);
  assert.equal(ov.data.switches.length, 1);
  assert.equal(ov.data.switches[0].name, 'autoHint');
  assert.ok(ov.data.sizeMB >= 0);

  // ── 会话列表 ──
  const ss = await (await fetch(`${srv.base}${API_PREFIX}/sessions`)).json();
  assert.equal(ss.ok, true);
  assert.equal(ss.data.summary.total, 2);
  assert.equal(ss.data.groups.length, 2);
  const bbb = ss.data.groups.find((g) => g.workspace === 'D:\\ws2');
  assert.equal(bbb.sessions[0].title, '分析错误原因', '提示词样标题应被摘要标题替代');

  // ── 改会话策略：写入 → 回读 ──
  const put = await fetch(`${srv.base}${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-aaa111', storeMode: 'skip', readMode: 'own' }),
  });
  assert.equal(put.status, 200);
  const putJson = await put.json();
  assert.deepEqual(putJson.data.resolved, {
    store: 0, readScope: 'own', readTags: [], from: 'session',
  });

  const ss2 = await (await fetch(`${srv.base}${API_PREFIX}/sessions`)).json();
  const row = ss2.data.groups.flatMap((g) => g.sessions).find((s) => s.id === 'session-aaa111');
  assert.equal(row.storeMode, 'skip');
  assert.equal(row.effStore, 'skip');
  assert.equal(row.effRead, 'own');

  // 复原
  await fetch(`${srv.base}${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-aaa111', storeMode: 'inherit', readMode: 'inherit' }),
  });

  // ── 改工作区策略 ──
  const w = await fetch(`${srv.base}${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'D:\\ws2', storeDefault: 'skip', readDefault: 'off' }),
  });
  assert.equal(w.status, 200);
  const ss3 = await (await fetch(`${srv.base}${API_PREFIX}/sessions`)).json();
  const g2 = ss3.data.groups.find((g) => g.workspace === 'D:\\ws2');
  assert.equal(g2.storeDefault, 'skip');
  assert.equal(g2.sessions[0].effStore, 'skip');
  assert.equal(g2.sessions[0].resolvedFrom, 'workspace');

  // ── 开关 ──
  const sw = await fetch(`${srv.base}${API_PREFIX}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'autoHint', on: false }),
  });
  assert.equal(sw.status, 200);
  const ov2 = await (await fetch(`${srv.base}${API_PREFIX}/overview`)).json();
  assert.equal(ov2.data.switches[0].on, false, '开关应持久化并反映到概览');

  // clear 回到配置值
  const cl = await fetch(`${srv.base}${API_PREFIX}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'autoHint', clear: true }),
  });
  assert.equal(cl.status, 200);
  const ov3 = await (await fetch(`${srv.base}${API_PREFIX}/overview`)).json();
  assert.equal(ov3.data.switches[0].on, true);
  assert.equal(ov3.data.switches[0].source, 'config');

  // ── 扫描 ──
  const sc = await fetch(`${srv.base}${API_PREFIX}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(sc.status, 200);
  const scJson = await sc.json();
  assert.equal(scJson.ok, true);
  assert.ok(typeof scJson.data.ms === 'number');
});

test('设置页 API：关键词 / 重建 / 导出 / 迁移', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-ui3-'));
  const vault = seedVault(dir);
  const srv = await startServer(vault);
  const target = mkdtempSync(join(tmpdir(), 'session-vault-mig-'));
  rmSync(target, { recursive: true, force: true }); // 迁移要求目标不存在或为空

  t.after(async () => {
    await srv.close();
    try { vault.close(); } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  const post = (path, body) => fetch(`${srv.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

  // ── 关键词列表 ──
  const tl = await (await fetch(`${srv.base}${API_PREFIX}/terms?limit=10`)).json();
  assert.equal(tl.ok, true);
  assert.ok(Array.isArray(tl.data.rows));
  assert.ok(tl.data.rows.length > 0, '种子数据应产生关键词');
  assert.ok(tl.data.rows[0].degree >= 0);

  // 搜索
  const found = await (await fetch(`${srv.base}${API_PREFIX}/terms?q=${encodeURIComponent('记忆')}`)).json();
  assert.ok(found.data.rows.every((r) => r.term.includes('记忆')), '搜索应只返回匹配项');

  // ── 屏蔽 / 加权 ──
  const term = tl.data.rows[0].term;
  const m1 = await post(`${API_PREFIX}/term`, { term, muted: true });
  assert.equal(m1.status, 200);
  let after = await (await fetch(`${srv.base}${API_PREFIX}/terms?limit=200`)).json();
  assert.equal(after.data.rows.find((r) => r.term === term).muted, 1);

  const m2 = await post(`${API_PREFIX}/term`, { term, muted: false, pinned: 2.5 });
  assert.equal(m2.status, 200);
  after = await (await fetch(`${srv.base}${API_PREFIX}/terms?limit=200`)).json();
  const row = after.data.rows.find((r) => r.term === term);
  assert.equal(row.muted, 0);
  assert.equal(row.pinned, 2.5);

  // pinned = -1 清除
  await post(`${API_PREFIX}/term`, { term, pinned: -1 });
  after = await (await fetch(`${srv.base}${API_PREFIX}/terms?limit=200`)).json();
  assert.equal(after.data.rows.find((r) => r.term === term).pinned, null);

  // 未知关键词 → 404
  assert.equal((await post(`${API_PREFIX}/term`, { term: '不存在的词xyz', muted: true })).status, 404);
  // 缺参数 → 400
  assert.equal((await post(`${API_PREFIX}/term`, {})).status, 400);
  assert.equal((await post(`${API_PREFIX}/term`, { term, pinned: 'abc' })).status, 400);
  assert.equal((await post(`${API_PREFIX}/term`, { term })).status, 400);

  // ── 重建索引（不能弄丢原文与摘要）──
  const before = vault.stats();
  const rb = await (await post(`${API_PREFIX}/rebuild`)).json();
  assert.equal(rb.ok, true);
  assert.ok(rb.data.summaries >= 2);
  assert.ok(rb.data.terms > 0);
  const afterRb = vault.stats();
  assert.equal(afterRb.events, before.events, '重建索引不能动 events');
  assert.equal(afterRb.summaries, before.summaries, '重建索引不能动 summaries');
  assert.ok(afterRb.activeTerms > 0, '重建后词库应恢复');

  // ── 导出 ──
  const ex = await (await post(`${API_PREFIX}/export`)).json();
  assert.equal(ex.ok, true);
  assert.ok(ex.data.file.includes('export-'));
  assert.equal(ex.data.sessions, 2);
  assert.ok(ex.data.events >= 3);
  assert.ok(ex.data.bytes > 0);

  // ── 迁移 ──
  // 没有 confirm 必须拒绝
  const noConfirm = await post(`${API_PREFIX}/migrate`, { to: target });
  assert.equal(noConfirm.status, 400);
  // 目标等于当前目录 → 400
  assert.equal((await post(`${API_PREFIX}/migrate`, { to: vault.dataDir, confirm: true })).status, 400);
  // 缺 to → 400
  assert.equal((await post(`${API_PREFIX}/migrate`, { confirm: true })).status, 400);

  const mig = await post(`${API_PREFIX}/migrate`, { to: target, confirm: true });
  assert.equal(mig.status, 200);
  const migJson = await mig.json();
  assert.equal(migJson.data.ok, true);
  assert.equal(migJson.data.dataDir, target);
  assert.equal(migJson.data.needsConfigUpdate, true, '必须提示配置要同步改');

  // 迁移后新库可用，数据没丢
  const ov = await (await fetch(`${srv.base}${API_PREFIX}/overview`)).json();
  assert.equal(ov.data.sessions, 2);
  assert.equal(ov.data.events, 3);
  assert.equal(ov.data.dataDir, target);
});

test('设置页 API：错误与安全分支', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-ui2-'));
  const vault = seedVault(dir);
  const srv = await startServer(vault);
  t.after(async () => {
    await srv.close();
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 方法不对 → 405
  // 注意：写方法若不带 JSON content-type，会先被 415 拦下（安全校验优先于语义校验），
  // 所以要测 405 必须带上 JSON 头，让它走到 handler 里。
  const wrongMethod = await fetch(`${srv.base}${API_PREFIX}/policy`, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  const wrongMethod2 = await fetch(`${srv.base}${API_PREFIX}/overview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(wrongMethod2.status, 405);

  // 写方法不带 JSON → 415
  const noCt = await fetch(`${srv.base}${API_PREFIX}/overview`, { method: 'POST', body: '{}' });
  assert.equal(noCt.status, 415);

  // content-type 不是 JSON → 415（挡住表单跨站提交）
  const formPost = await fetch(`${srv.base}${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'sessionId=x&storeMode=skip',
  });
  assert.equal(formPost.status, 415);

  // 跨站 Origin → 403
  const crossSite = await fetch(`${srv.base}${API_PREFIX}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'autoHint', on: false }),
  });
  assert.equal(crossSite.status, 403);

  // 非法策略值 → 400
  const bad = await fetch(`${srv.base}${API_PREFIX}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-aaa111', storeMode: 'whatever' }),
  });
  assert.equal(bad.status, 400);

  // 缺 name → 400
  const badSwitch = await fetch(`${srv.base}${API_PREFIX}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(badSwitch.status, 400);

  // 未知开关 → 400（而不是悄悄成功）
  const unknownSwitch = await fetch(`${srv.base}${API_PREFIX}/switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'noSuchSwitch', on: true }),
  });
  assert.equal(unknownSwitch.status, 400);

  // 未注册的路径 → 404（由外层 server 处理，确认真的没注册）
  assert.equal(srv.routes.has(`${API_PREFIX}/nope`), false);
});

test('设置页 API：没有 webServer 时静默跳过，不抛错', () => {
  const reg = registerRoutes({ get: () => null }, {
    getVault: () => null,
    getConfig: () => ({}),
    log: () => {},
    getLastScan: () => null,
  });
  assert.equal(reg.registered, 0);
  assert.equal(reg.reason, 'no-webServer');
});

test('设置页 API：库未就绪时返回 503 而不是崩', async (t) => {
  // 造一个 register 能用的 ctx，但 getVault 返回 null
  const routes = new Map();
  const ctx = {
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } },
    get: () => null,
  };
  registerRoutes(ctx, {
    getVault: () => null,
    getConfig: () => ({}),
    log: () => {},
    getLastScan: () => null,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes.get(url.pathname);
    if (handler) await handler(req, res);
    else res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/overview`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /未就绪/);

  // 所有 API 都应该是 503，而不是崩掉或返回 200
  for (const p of ['/sessions', '/terms']) {
    const r = await fetch(`http://127.0.0.1:${port}${API_PREFIX}${p}`);
    assert.equal(r.status, 503, `${p} 应返回 503`);
  }
});
