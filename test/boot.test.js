/**
 * 入口冒烟测试：把插件入口真的跑起来。
 *
 * 为什么需要这个：`node --check` 只验语法，抓不到「用了但没 import」的标识符。
 * 0.4.11 就栽在这上面 —— `index.js` 里调了 `resolveDataDir()` 却没 import，
 * 语法完全正确，打包安装也成功，但 `apply()` 一执行就 ReferenceError，
 * 插件自我禁用（设计如此，不阻塞 DSH），结果设置页所有接口 404，而表面一切正常。
 *
 * 做法：造 `@deepseek-ai/*` 的桩模块，复制 src 到临时目录，真正 import 并调用 apply()。
 * 这样任何「模块级 / apply 级」的运行时错误都会在测试里炸出来。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const SRC = join(import.meta.dirname, '..', 'src');

/** 万能链式桩：z.string().description().default() 这类都能接住。 */
function chainStub() {
  const fn = () => chainStub();
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === 'default') return () => chainStub();
      if (prop === 'then') return undefined; // 别被当成 Promise
      return chainStub();
    },
    apply: () => chainStub(),
  });
}

/**
 * 在临时目录里搭一个能 import 我们插件的最小环境。
 */
function makeSandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sv-boot-'));
  const pluginsDir = join(dir, 'node_modules', '@deepseek-ai');

  // ① 桩：schemastery（Config 定义要用）
  const mk = (name, code) => {
    const d = join(pluginsDir, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({
      name: `@deepseek-ai/${name}`, version: '0.0.0', type: 'module', main: 'index.js',
    }), 'utf8');
    writeFileSync(join(d, 'index.js'), code, 'utf8');
  };

  mk('schemastery', `
const s = () => new Proxy(() => s(), {
  get: (_t, p) => (p === 'then' ? undefined : s()),
  apply: () => s(),
});
export default { string: s, number: s, boolean: s, array: s, dict: s, object: s, union: s, const: s, any: s };
`);

  // ② 桩：dsh-home-paths（指向沙箱里的假 DSH_HOME）
  mk('dsh-home-paths', `
export function resolveDshHome() { return ${JSON.stringify(join(dir, 'dshhome'))}; }
export default { resolveDshHome };
`);

  // ③ 桩：dsh-tools（defineTool / text）
  mk('dsh-tools', `
export function defineTool(def) { return def; }
export function text(s) { return { type: 'text', value: String(s) }; }
export const toolResult = (v) => v;
export default { defineTool, text };
`);

  // ④ 复制 src（连同相对 import 一起）
  cpSync(SRC, join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dshhome'), { recursive: true });

  t.after(() => {
    // apply() 打开的 SQLite 句柄可能还占着文件，Windows 下会 EPERM。
    // 临时目录清理失败不影响结论，别让它把测试搞红。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 留给系统清 */
    }
  });
  return { dir, dshhome: join(dir, 'dshhome') };
}

/** 最小可用的假 ctx。 */
function makeCtx() {
  const tools = new Map();
  const routes = [];
  const sections = [];
  const handlers = [];
  const ctx = {
    _tools: tools,
    _routes: routes,
    _sections: sections,
    _handlers: handlers,
    tools: { register: (d) => tools.set(d.name, d) },
    webServer: { register: (r) => routes.push(r) },
    systemPrompt: { section: (s) => sections.push(s) },
    on: (evt, fn) => handlers.push({ evt, fn }),
    effect: (fn) => { try { fn(); } catch { /* 效果失败不该影响测试 */ } },
    get: () => null,
    locale: () => (k) => k,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  // 关键：inject 要把「带 webServer 的 ctx」交给回调。
  // 早期给 {} 会让 registerRoutes 拿到空的 webServer，直接返回 registered: 0，
  // 看起来像"路由没注册"，其实是桩写错了。
  ctx.inject = (_deps, cb) => { try { cb?.(ctx); } catch { /* ignore */ } };
  return ctx;
}

test('入口能 import，且导出 name / inject / Config / apply', async (t) => {
  const { dir } = makeSandbox(t);
  const mod = await import(`file:///${join(dir, 'src', 'index.js').replace(/\\/g, '/')}`);

  assert.equal(typeof mod.apply, 'function', '必须导出 apply');
  assert.equal(typeof mod.name, 'string');
  assert.ok(Array.isArray(mod.inject));
  assert.ok(mod.Config, '必须导出 Config（DSH 靠它读配置项）');
});

/**
 * 核心用例：真的调 apply()。
 * 0.4.11 那个 ReferenceError 会被这一条直接抓出来。
 */
test('apply() 能跑完，并把工具和路由都注册上', async (t) => {
  const { dir, dshhome } = makeSandbox(t);
  const mod = await import(`file:///${join(dir, 'src', 'index.js').replace(/\\/g, '/')}`);

  const ctx = makeCtx();
  // 数据目录显式指到沙箱，别碰真实库；enabled 关掉后台扫描
  const cfg = {
    dataDir: join(dir, 'vault'),
    sessionsRoot: join(dir, 'sessions'),
    enabled: true,
    autoScan: false,
  };

  await mod.apply(ctx, cfg);

  const toolNames = [...ctx._tools.keys()];
  assert.ok(toolNames.includes('memory_recall'), `工具没注册上：${toolNames.join(',') || '(空)'}`);
  assert.equal(toolNames.length, 14, `应为 14 个工具，实际 ${toolNames.length}`);

  assert.ok(ctx._routes.length >= 20, `路由太少：${ctx._routes.length}`);
  const paths = ctx._routes.map((r) => r.path ?? r.url ?? '');
  assert.ok(paths.some((p) => String(p).includes('/overview')), '缺少 /overview 路由');
  assert.ok(paths.some((p) => String(p).includes('/surfcore')), '缺少 /surfcore 路由');

  assert.ok(ctx._sections.length >= 2, '系统提示 section 应至少注册 2 段');
  assert.ok(ctx._handlers.length >= 1, '应注册 inbox 钩子');
});

test('apply() 在任何配置下都不抛（空对象 / 全 false / 缺字段）', async (t) => {
  const { dir } = makeSandbox(t);
  const mod = await import(`file:///${join(dir, 'src', 'index.js').replace(/\\/g, '/')}`);

  for (const cfg of [
    {},
    { enabled: false },
    { dataDir: join(dir, 'v'), sessionsRoot: join(dir, 's'), enabled: true, autoScan: false },
  ]) {
    const ctx = makeCtx();
    await assert.doesNotReject(
      () => Promise.resolve(mod.apply(ctx, cfg)),
      `配置 ${JSON.stringify(cfg)} 下 apply 不该抛`,
    );
  }
});

/**
 * 这一条防「打包漏文件」：入口 import 的每个本地模块都必须真的在 src 里。
 */
test('src 里所有相对 import 的目标文件都存在', () => {
  const problems = [];
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const m of src.matchAll(/from\s+'\.\/([\w.-]+)'/g)) {
      const target = m[1];
      const exists = readdirSync(SRC).includes(target)
        || readdirSync(SRC).includes(`${target}.js`);
      if (!exists) problems.push(`${f} -> ${target}`);
    }
  }
  assert.deepEqual(problems, [], `本地 import 指向了不存在的文件：${problems.join(', ')}`);
});
