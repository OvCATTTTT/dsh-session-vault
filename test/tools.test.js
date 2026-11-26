/**
 * 工具层的冒烟测试：用一个假 ctx 把所有工具注册一遍，
 * 确认没有 surfcore 时也不会抛，且 memory_surfcore 的开关逻辑对。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionVault } from '../src/core.js';
import { registerTools } from '../src/tools.js';
import { clearCache } from '../src/surfcore.js';

/** 最小的假 ctx：只收工具定义，不跑宿主那套。 */
function makeCtx() {
  const tools = new Map();
  return {
    tools: {
      register(def) { tools.set(def.name, def); },
    },
    tools_推出: tools,
    list: () => [...tools.keys()],
    call: async (name, args) => {
      const def = tools.get(name);
      assert.ok(def, `工具 ${name} 没注册`);
      return def.execute(args ?? {});
    },
  };
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sv-tools-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const vault = new SessionVault({
    dataDir,
    sessionsRoot: join(dir, 'sessions'),
    dshHome: join(dir, 'dsh-home'),
    log: () => {},
  });
  vault.open();
  const ctx = makeCtx();
  registerTools(ctx, { getVault: () => vault, getConfig: () => vault.config });
  t.after(() => {
    try { vault.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    clearCache();
  });
  return { vault, ctx, dir };
}

test('没装 surfcore：所有工具都能注册，memory_surfcore 不抛', async (t) => {
  const { ctx } = setup(t);
  const names = ctx.list();
  assert.ok(names.includes('memory_surfcore'), '要有 memory_surfcore 工具');
  assert.equal(names.length, 14, `应为 14 个工具，实际 ${names.length}`);

  const r = await ctx.call('memory_surfcore', {});
  assert.ok(typeof r.summary === 'string');
  assert.equal(r.total, 0);
  assert.match(r.summary, /没有找到 surfcore/);
});

test('memory_surfcore 能查到已同步的记录，且带只读说明', async (t) => {
  const { vault, ctx } = setup(t);
  // 造一份 surfcore 数据
  const mem = join(vault.dshHome, 'surfcore', 'characters', 'char-t1', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(vault.dshHome, 'surfcore', 'characters', 'current.json'),
    '{"id":"char-t1","name":"测试角色"}', 'utf8');
  writeFileSync(join(mem, 'memory-card.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-11-26T00:00:00.000Z',
    stats: { forgotten: 0 },
    records: [
      { id: 'mem_1', kind: 'owner', title: '主人说不吃香菜', text: '我不吃香菜', importance: 80, pinned: true, createdAt: '2026-11-20T10:00:00.000Z' },
      { id: 'mem_2', kind: 'event', title: 'B站动态', text: '发了一条动态', importance: 5, createdAt: '2026-11-21T10:00:00.000Z' },
    ],
  }), 'utf8');
  clearCache();

  // 先同步（live 模式也能直接查）
  const r = await ctx.call('memory_surfcore', { q: '香菜' });
  assert.equal(r.total, 1, '搜「香菜」应命中 1 条');
  assert.match(r.summary, /只读/);
  assert.match(r.summary, /不吃香菜/);

  // sync=true 时先同步
  const s = await ctx.call('memory_surfcore', { sync: true, limit: 10 });
  assert.equal(s.total, 2, '同步后应能查到两条');
});

test('memory_surfcore 描述里明确禁止代替 memory_recall', async (t) => {
  const { ctx } = setup(t);
  const tools = ctx.tools_推出;
  const def = tools.get('memory_surfcore');
  assert.match(def.description, /只读/);
  assert.match(def.description, /不要用它，用 memory_recall|用 memory_recall/);
  assert.match(def.description, /不参与自动联想/);
});

test('其他工具在没装 surfcore 时行为不变', async (t) => {
  const { ctx } = setup(t);
  const stats = await ctx.call('memory_stats', {});
  assert.match(stats.summary, /会话 0/);
  const sessions = await ctx.call('memory_sessions', {});
  assert.ok(typeof sessions.summary === 'string');
});
