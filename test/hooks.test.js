import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOOK, on, emit, registerRanker, collectBoosts, listHooks, clearHooks } from '../src/hooks.js';
import { openDb } from '../src/db.js';
import { insertSummary, indexSummaryTerms } from '../src/indexer.js';
import { gate, invalidateRecallCache } from '../src/recall.js';
import { SessionVault, SWITCHES } from '../src/core.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-hook-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir, cleanup: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test.beforeEach(() => clearHooks());
test.afterEach(() => clearHooks());

// ── 钩子基础设施 ──────────────────────────────────────────────────────────
test('注册与触发，可原地修改 payload', () => {
  const off = on(HOOK.RECALL_BEFORE_QUERY, (p) => { p.query = '改写后'; });
  const out = emit(HOOK.RECALL_BEFORE_QUERY, { query: '原句' });
  assert.equal(out.query, '改写后');
  off();
  assert.equal(emit(HOOK.RECALL_BEFORE_QUERY, { query: '原句' }).query, '原句', 'off 之后不再生效');
});

test('未知钩子名直接抛错（避免拼错静默失效）', () => {
  assert.throws(() => on('recall:no-such-hook', () => {}), /未知钩子/);
});

test('单个钩子抛错不影响其它钩子与主流程', () => {
  let called = 0;
  on(HOOK.RECALL_AFTER_GATE, () => { throw new Error('boom'); });
  on(HOOK.RECALL_AFTER_GATE, () => { called += 1; });
  const out = emit(HOOK.RECALL_AFTER_GATE, { hits: [] });
  assert.equal(called, 1, '后面的钩子仍然执行');
  assert.deepEqual(out.hits, []);
});

test('返回 false 表示丢弃，统一转成 payload.drop', () => {
  on(HOOK.INGEST_BEFORE_INSERT, () => false);
  const p = emit(HOOK.INGEST_BEFORE_INSERT, { row: { text: 'x' } });
  assert.equal(p.drop, true);
});

test('listHooks 能反映注册情况', () => {
  on(HOOK.HINT_BEFORE_RENDER, () => {});
  registerRanker(() => new Map());
  const s = listHooks();
  assert.equal(s.hooks[HOOK.HINT_BEFORE_RENDER], 1);
  assert.equal(s.rankers, 1);
});

// ── 排序器 ────────────────────────────────────────────────────────────────
test('排序器加成会叠加，非法值被忽略', () => {
  registerRanker(() => new Map([[1, 0.2]]));
  registerRanker(() => new Map([[1, 0.1], [2, Number.NaN]]));
  const boost = collectBoosts({ db: null, query: 'q', seedTerms: [], total: 0 });
  assert.ok(Math.abs(boost.get(1) - 0.3) < 1e-9);
  assert.equal(boost.has(2), false, 'NaN 应被丢弃');
});

test('排序器抛错时当作不存在', () => {
  registerRanker(() => { throw new Error('bad'); });
  registerRanker(() => new Map([[7, 0.5]]));
  const boost = collectBoosts({ db: null, query: 'q', seedTerms: [], total: 0 });
  assert.equal(boost.get(7), 0.5);
});

test('排序器真的能改变检索排序', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '甲', body: '向量库 方案 设计', hash: 'h1' });
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '乙', body: '向量库 方案 设计', hash: 'h2' });
  indexSummaryTerms(db, 1, '向量库 方案 设计');
  indexSummaryTerms(db, 2, '向量库 方案 设计');

  invalidateRecallCache();
  const before = gate(db, '向量库 方案 设计', { limit: 2, threshold: 0.2 });
  assert.ok(before.hits.length === 2);

  // 把 id=2 顶到最前
  registerRanker(() => new Map([[2, 0.9]]));
  invalidateRecallCache();
  const after = gate(db, '向量库 方案 设计', { limit: 2, threshold: 0.2 });
  assert.equal(after.hits[0].id, 2, '排序器应把 #2 提到第一');
  cleanup();
});

test('recall:beforeQuery 可以改写查询并影响结果', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '目标', body: 'ACL 权限 沙箱', hash: 'h1' });
  indexSummaryTerms(db, 1, 'ACL 权限 沙箱');

  invalidateRecallCache();
  const miss = gate(db, '完全不相关的词', { limit: 1, threshold: 0.3 });
  assert.equal(miss.hits.length, 0);

  on(HOOK.RECALL_BEFORE_QUERY, (p) => { p.query = 'ACL 权限 沙箱'; });
  invalidateRecallCache();
  const hit = gate(db, '完全不相关的词', { limit: 1, threshold: 0.3 });
  assert.equal(hit.hits.length, 1, '改写后应命中');
  cleanup();
});

// ── 运行期开关 ────────────────────────────────────────────────────────────
test('开关：默认值 / 显式设置 / 清除 / 持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-sw-'));
  const v = new SessionVault({ dataDir: join(dir, 'mem'), sessionsRoot: join(dir, 'sessions') });
  v.open();

  assert.equal(v.switchState('autoHint', true).on, true);
  assert.equal(v.switchState('autoHint', true).source, 'config');

  v.setSwitch('autoHint', false);
  const off = v.switchState('autoHint', true);
  assert.equal(off.on, false);
  assert.equal(off.source, 'db', '数据库里的设置优先级高于配置');

  v.close();

  // 重开后仍在（持久化到 meta 表）
  const v2 = new SessionVault({ dataDir: join(dir, 'mem'), sessionsRoot: join(dir, 'sessions') });
  v2.open();
  assert.equal(v2.switchState('autoHint', true).on, false, '重启后保留');
  assert.equal(v2.switchState('autoHint', true).source, 'db');

  v2.clearSwitch('autoHint');
  assert.equal(v2.switchState('autoHint', true).on, true, '清除后回到配置值');
  assert.equal(v2.switchState('autoHint', true).source, 'config');

  v2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('未知开关抛错并给出可用清单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-sw2-'));
  const v = new SessionVault({ dataDir: dir, sessionsRoot: dir });
  v.open();
  assert.throws(() => v.switchState('nope'), /未知开关/);
  assert.ok(Object.keys(SWITCHES).includes('autoHint'));
  v.close();
  rmSync(dir, { recursive: true, force: true });
});

test('allSwitches 列出全部开关状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-sw3-'));
  const v = new SessionVault({ dataDir: dir, sessionsRoot: dir });
  v.open();
  const list = v.allSwitches({ autoHint: false });
  const auto = list.find((s) => s.name === 'autoHint');
  assert.equal(auto.on, false, '应读配置里的值');
  assert.ok(auto.label.includes('主动联想'));
  v.close();
  rmSync(dir, { recursive: true, force: true });
});
