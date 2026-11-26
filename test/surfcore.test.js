/**
 * surfcore 缺失 / 损坏 / 权限不足时，插件必须**安静降级**，不能报错。
 *
 * 这些用例是锁死行为用的：用户没装 surfcore 是很常见的情况，
 * 任何一个方法抛异常都会让设置页或工具调用炸掉。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SessionVault } from '../src/core.js';
import { insertSummary, indexSummaryTerms } from '../src/indexer.js';
import { discover, overview, readCard, readFull, clearCache } from '../src/surfcore.js';
import {
  mirrorSync, mirrorList, mirrorForgotten, mirrorInfo, mirrorClear,
} from '../src/surfcore-store.js';

function makeVault(t, { dshHome = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sv-nosc-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const v = new SessionVault({
    dataDir,
    sessionsRoot: join(dir, 'sessions'),
    dshHome: dshHome ?? join(dir, 'dshhome-empty'),
    log: () => {},
  });
  v.open();
  t.after(() => {
    try { v.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    clearCache();
  });
  return { v, dir };
}

test('没装 surfcore：discover 返回 not-ok，两个读函数都不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-sc-miss-'));
  const home = join(dir, 'dsh');
  mkdirSync(home, { recursive: true });
  clearCache();

  const p = discover(home);
  assert.equal(p.ok, false, '没有 surfcore 目录时应 ok=false');
  assert.ok(typeof p.reason === 'string' && p.reason.length > 0, '要给一个原因');

  const card = readCard(p);
  assert.equal(card.ok, false);
  assert.deepEqual(card.records, []);

  const full = readFull(p);
  assert.equal(full.ok, false);
  assert.deepEqual(full.records, []);

  const ov = overview(home);
  assert.equal(ov.ok, false);
  assert.equal(ov.enabled, false);
  assert.ok(ov.reason);

  rmSync(dir, { recursive: true, force: true });
});

test('没装 surfcore：SessionVault 的 surfcore 方法全部不抛异常', (t) => {
  const { v } = makeVault(t);

  // 概览
  const ov = v.surfcoreOverview();
  assert.equal(ov.ok, false);
  assert.equal(ov.mode, 'live');
  assert.deepEqual(ov.mirror, { total: 0, inCard: 0, forgotten: 0, syncedAt: 0, empty: true });

  // 列表
  const rows = v.surfcoreRecords({ limit: 10 });
  assert.equal(rows.ok, false);
  assert.equal(rows.total, 0);
  assert.deepEqual(rows.rows, []);

  // 遗忘
  const forgot = v.surfcoreForgotten({ limit: 10 });
  assert.equal(forgot.ok, false);
  assert.equal(forgot.total, 0);

  // 同步
  const sync = v.surfcoreSync();
  assert.equal(sync.ok, false);
  assert.ok(sync.reason);

  // 清空镜像（空表也要能用）
  assert.deepEqual(v.surfcoreClear(), { cleared: 0 });

  // 切 mirror：同步失败但不抛，模式照样记住
  const sw = v.setSurfcoreMode('mirror');
  assert.equal(sw.mode, 'mirror');
  assert.equal(sw.sync.ok, false);
  assert.equal(v.surfcoreMode(), 'mirror');

  // 镜像模式下查空表
  const m = v.surfcoreRecords({ limit: 10 });
  assert.equal(m.mode, 'mirror');
  assert.equal(m.total, 0);
});

test('surfcore 目录在、但主卡是坏 JSON：不抛，报读取失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-sc-bad-'));
  const home = join(dir, 'dsh');
  const mem = join(home, 'surfcore', 'characters', 'char-bad1', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(home, 'surfcore', 'characters', 'current.json'), '{"id":"char-bad1"}', 'utf8');
  // 写一半的 JSON —— surfcore 正在写的时候就是这个样子
  writeFileSync(join(mem, 'memory-card.json'), '{"version":1,"records":[{"id":"mem_1"', 'utf8');
  clearCache();

  const p = discover(home);
  assert.equal(p.ok, true, '文件存在就算找到了');

  const card = readCard(p);
  assert.equal(card.ok, false, '解析失败要报 ok=false，不能抛');
  assert.deepEqual(card.records, []);

  // 概览也不能抛
  const ov = overview(home);
  assert.equal(ov.ok, false);
  assert.equal(ov.enabled, true, 'surfcore 是装了的，只是这份卡读不出来');

  rmSync(dir, { recursive: true, force: true });
  clearCache();
});

test('全量档案是坏行：跳过坏行，好的照读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-sc-partial-'));
  const home = join(dir, 'dsh');
  const mem = join(home, 'surfcore', 'characters', 'char-p1', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(home, 'surfcore', 'characters', 'current.json'), '{"id":"char-p1"}', 'utf8');
  writeFileSync(join(mem, 'memory-card.json'), JSON.stringify({
    version: 1,
    records: [{ id: 'mem_a', kind: 'owner', title: '在主卡里', text: 'x' }],
  }), 'utf8');
  writeFileSync(join(mem, 'memory-card-full.jsonl'), [
    JSON.stringify({ id: 'mem_a', kind: 'owner', title: '在主卡里', text: 'x' }),
    '{"id":"mem_broken"', // 坏行
    JSON.stringify({ id: 'mem_c', kind: 'event', title: '只在档案里', text: 'y' }),
  ].join('\n'), 'utf8');
  clearCache();

  const p = discover(home);
  assert.equal(p.ok, true);

  const card = readCard(p);
  assert.equal(card.records.length, 1);

  const full = readFull(p);
  assert.equal(full.ok, true);
  assert.equal(full.records.length, 2, '两条好行都要读到，坏行跳过');

  const ov = overview(home);
  assert.equal(ov.ok, true);
  assert.equal(ov.card.total, 1);

  rmSync(dir, { recursive: true, force: true });
  clearCache();
});

test('dshHome 为 null/空串时不抛', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-sc-nohome-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const v = new SessionVault({
    dataDir, sessionsRoot: join(dir, 's'), dshHome: null, log: () => {},
  });
  v.open();
  t.after(() => {
    try { v.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    clearCache();
  });

  const ov = v.surfcoreOverview();
  assert.equal(ov.ok, false);
  assert.equal(v.surfcoreRecords({ limit: 5 }).ok, false);
  assert.equal(v.surfcoreForgotten({ limit: 5 }).ok, false);
});

test('镜像相关函数在空库/无 surfcore 时都不抛', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-sc-mir-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const v = new SessionVault({
    dataDir, sessionsRoot: join(dir, 's'), dshHome: join(dir, 'empty'), log: () => {},
  });
  v.open();
  t.after(() => {
    try { v.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
    clearCache();
  });
  const db = v.open();

  assert.deepEqual(mirrorInfo(db), { total: 0, inCard: 0, forgotten: 0, syncedAt: 0, empty: true });
  assert.deepEqual(mirrorList(db, { limit: 5 }), { total: 0, limit: 5, offset: 0, rows: [] });
  assert.deepEqual(mirrorForgotten(db, { limit: 5 }), { total: 0, limit: 5, offset: 0, rows: [] });
  assert.deepEqual(mirrorClear(db), { cleared: 0 });
  const sync = mirrorSync(db, join(dir, 'empty'));
  assert.equal(sync.ok, false);
  assert.ok(sync.reason);
});

test('surfcore 的数据不参与关键词联想', (t) => {
  const { v } = makeVault(t);
  const db = v.open();

  // 先造一个"有内容"的记忆库，否则 0:0 的对比没有说服力
  const sid = insertSummary(db, {
    sessionId: 's-dsh', kind: 'turn', title: '正常的 DSH 会话', body: 'ACL 权限 沙箱', hash: 'h1',
  });
  indexSummaryTerms(db, sid, 'ACL 权限 沙箱 报错');

  const before = v.terms({ limit: 1000 });
  const beforeNames = new Set((before.rows ?? before).map((x) => x.term ?? x));
  assert.ok(beforeNames.size > 0, '前置条件：关键词库应当非空');

  // 造一份 surfcore 数据，镜像进去
  const home = v.dshHome;
  const mem = join(home, 'surfcore', 'characters', 'char-z1', 'memory');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(home, 'surfcore', 'characters', 'current.json'), '{"id":"char-z1"}', 'utf8');
  writeFileSync(join(mem, 'memory-card.json'), JSON.stringify({
    version: 1,
    records: [{
      id: 'mem_unicorn',
      kind: 'owner',
      title: '只属于 surfcore 的独角兽词',
      text: '独角兽 这个短语只应该出现在记忆卡里',
      importance: 50,
    }],
  }), 'utf8');
  clearCache();

  const sync = v.surfcoreSync();
  assert.equal(sync.ok, true, '同步要成功');
  assert.equal(sync.total, 1);

  // 镜像进库了
  assert.equal(mirrorInfo(db).total, 1);

  // 但关键词库一个字都没多
  const after = v.terms({ limit: 1000 });
  const afterNames = new Set((after.rows ?? after).map((x) => x.term ?? x));
  assert.equal(afterNames.has('独角兽'), false, 'surfcore 的内容不许进关键词库');
  assert.deepEqual([...afterNames].sort(), [...beforeNames].sort(), '关键词集合必须完全不变');

  // 摘要表只有原来那一条
  const sums = db.prepare('SELECT COUNT(*) AS n FROM summaries').get().n;
  assert.equal(Number(sums), 1, 'surfcore 的记录不能进 summaries');

  // events 表还是空的
  const evs = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  assert.equal(Number(evs), 0, 'surfcore 的记录不能进 events');

  // 倒排表里也不许有 surfcore 的词
  const inv = db.prepare(
    `SELECT COUNT(*) AS n FROM terms_inv ti
     JOIN terms t ON t.id = ti.term
     WHERE t.term IN ('独角兽','短语','记忆卡')`,
  ).get().n;
  assert.equal(Number(inv), 0, 'terms_inv 里不能有 surfcore 的词');

  // 最后：真实联想链路跑一遍。
  // 注意 recall(query, opts) 第一个参数是查询字符串，默认 readScope='off' 会直接返回空，
  // 所以必须显式传 readScope，否则断言永远是假阳性。
  const hit = v.recall('ACL 权限', { readScope: 'all', sessionId: 's-dsh', log: false });
  assert.ok(String(hit.text ?? '').length > 0, '前置条件：DSH 自己的内容应当能被联想召回');

  const miss = v.recall('独角兽', { readScope: 'all', sessionId: 's-dsh', log: false });
  assert.equal(String(miss.text ?? '').includes('独角兽'), false, '联想提示里不能出现 surfcore 的内容');
  assert.equal(miss.hits.length, 0, 'surfcore 的词不该命中任何摘要');
});
