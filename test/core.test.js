import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/db.js';
import {
  resolvePolicy, materializePolicy, effectivePolicy,
  setSessionPolicy, setWorkspacePolicy, setGlobalPolicy, upsertSession,
  addSessionTag, listSessionTags, sessionIdsByTags,
} from '../src/policy.js';
import { edgeWeight, insertSummary, indexSummaryTerms, pruneTerms, contentHash, pickEdgeTerms, listTerms } from '../src/indexer.js';
import { gate, openSummary, renderHint, termWeight, searchEvents, hubFactor } from '../src/recall.js';
import { migrateDataDir, tableCounts, integrityOk } from '../src/migrate.js';
import { normalizeConfig, defaults } from '../src/config.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-test-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir, cleanup: () => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// ── 策略：三级解析 ─────────────────────────────────────────────────────────
test('默认不存不读：新装插件不许自己决定记什么、能查什么', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  const r = resolvePolicy(db, 's1', 'W1');
  assert.equal(r.store, 0, '默认必须是不存');
  assert.equal(r.readScope, 'off', '默认必须是不读');
  assert.equal(r.from, 'global');
  cleanup();
});

test('显式打开后默认值被尊重', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  setGlobalPolicy(db, { defaultStore: 'store', defaultRead: 'own' });
  const r = resolvePolicy(db, 's1', 'W1');
  assert.equal(r.store, 1);
  assert.equal(r.readScope, 'own');
  cleanup();
});

test('工作区默认覆盖全局，会话显式覆盖工作区', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  upsertSession(db, { id: 's2', workspace: 'W1' });

  setGlobalPolicy(db, { defaultStore: 'store', defaultRead: 'all' });
  setWorkspacePolicy(db, { workspace: 'W1', storeDefault: 'skip', readDefault: 'own' });

  const ws = resolvePolicy(db, 's2', 'W1');
  assert.equal(ws.store, 0, '工作区 skip 应生效');
  assert.equal(ws.readScope, 'own');
  assert.equal(ws.from, 'workspace');

  setSessionPolicy(db, { sessionId: 's1', storeMode: 'store', readMode: 'off' });
  const own = resolvePolicy(db, 's1', 'W1');
  assert.equal(own.store, 1);
  assert.equal(own.readScope, 'off');
  assert.equal(own.from, 'session');
  cleanup();
});

test('store 与 read 互相独立：skip + all 是合法组合', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  setSessionPolicy(db, { sessionId: 's1', storeMode: 'skip', readMode: 'all' });
  const eff = effectivePolicy(db, 's1');
  assert.equal(eff.store, 0);
  assert.equal(eff.readScope, 'all');
  cleanup();
});

test('只改工作区的「读」不会顺带把「存」重置掉', () => {
  // 真实踩过的 bug：早期 setWorkspacePolicy 无条件写两列，
  // 只调 readDefault 时 storeDefault 是 undefined，被 normalize 成默认值写进库，
  // 用户的「存」就莫名其妙被改了。
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });

  setWorkspacePolicy(db, { workspace: 'W1', storeDefault: 'store', readDefault: 'off' });
  assert.equal(effectivePolicy(db, 's1').store, 1);
  assert.equal(effectivePolicy(db, 's1').readScope, 'off');

  // 只改读
  const r = setWorkspacePolicy(db, { workspace: 'W1', readDefault: 'all' });
  assert.equal(r.storeDefault, 'store', '返回值里存应保持 store');
  assert.equal(r.readDefault, 'all');
  assert.equal(effectivePolicy(db, 's1').store, 1, '「存」不能被顺带改掉');
  assert.equal(effectivePolicy(db, 's1').readScope, 'all');

  // 只改存
  setWorkspacePolicy(db, { workspace: 'W1', storeDefault: 'skip' });
  assert.equal(effectivePolicy(db, 's1').store, 0);
  assert.equal(effectivePolicy(db, 's1').readScope, 'all', '「读」也不能被顺带改掉');
  cleanup();
});

test('单独开关某个会话的存与读互不影响', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  upsertSession(db, { id: 's2', workspace: 'W1' });
  // effectivePolicy 只读物化表，先把两个会话都物化一份
  materializePolicy(db, 's1', 'W1');
  materializePolicy(db, 's2', 'W1');

  // 只开 s1 的存
  setSessionPolicy(db, { sessionId: 's1', storeMode: 'store' });
  assert.equal(effectivePolicy(db, 's1').store, 1);
  assert.equal(effectivePolicy(db, 's1').readScope, 'off', '开存不该顺手开读');
  assert.equal(effectivePolicy(db, 's2').store, 0, '不应影响别的会话');

  // 只开 s1 的读
  setSessionPolicy(db, { sessionId: 's1', readMode: 'own' });
  assert.equal(effectivePolicy(db, 's1').store, 1, '读不该影响存');
  assert.equal(effectivePolicy(db, 's1').readScope, 'own');
  assert.equal(effectivePolicy(db, 's2').readScope, 'off');

  // s2 全开，s1 关掉存
  setSessionPolicy(db, { sessionId: 's2', storeMode: 'store', readMode: 'all' });
  setSessionPolicy(db, { sessionId: 's1', storeMode: 'skip' });
  assert.equal(effectivePolicy(db, 's1').store, 0);
  assert.equal(effectivePolicy(db, 's1').readScope, 'own');
  assert.equal(effectivePolicy(db, 's2').store, 1);
  assert.equal(effectivePolicy(db, 's2').readScope, 'all');
  cleanup();
});

test('改回 inherit 会退回上一级', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  setWorkspacePolicy(db, { workspace: 'W1', storeDefault: 'skip', readDefault: 'own' });
  setSessionPolicy(db, { sessionId: 's1', storeMode: 'store', readMode: 'all' });
  assert.equal(effectivePolicy(db, 's1').store, 1);

  setSessionPolicy(db, { sessionId: 's1', storeMode: 'inherit', readMode: 'inherit' });
  const eff = effectivePolicy(db, 's1');
  assert.equal(eff.store, 0);
  assert.equal(eff.readScope, 'own');
  assert.equal(eff.from, 'workspace');
  cleanup();
});

test('物化表会被重算', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  materializePolicy(db, 's1', 'W1');
  setGlobalPolicy(db, { defaultRead: 'off' });
  assert.equal(effectivePolicy(db, 's1').readScope, 'off', '改全局后物化值应更新');
  cleanup();
});

// ── 索引：权重、幂等、剪枝 ────────────────────────────────────────────────
test('边权重用饱和函数，收敛到 1 且单调递增', () => {
  assert.equal(edgeWeight(0), 0);
  assert.ok(edgeWeight(1) < edgeWeight(5));
  assert.ok(edgeWeight(5) < edgeWeight(20));
  assert.ok(edgeWeight(1000) <= 1);
  assert.ok(edgeWeight(20) > 0.95, '20 次共现应接近 1');
});

test('idf：df 越小权重越高；pinned 覆盖', () => {
  assert.ok(termWeight(1, 100, null) > termWeight(50, 100, null));
  assert.equal(termWeight(1, 100, 3.5), 3.5);
});

test('摘要幂等：同 hash 不重复插入', () => {
  const { db, cleanup } = freshDb();
  const hash = contentHash('turn', 's1', '1');
  const id1 = insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: '项目延期', hash });
  const id2 = insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: '项目延期', hash });
  assert.ok(id1);
  assert.equal(id2, null, '重复 hash 应被拒');
  cleanup();
});

test('共现边幂等累计：重复索引同一摘要不会重复加 hits', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: 'h1' });
  indexSummaryTerms(db, 1, 'ACL 权限 ACL 权限');
  const before = db.prepare('SELECT COALESCE(SUM(hits),0) n FROM term_edges').get().n;
  indexSummaryTerms(db, 1, 'ACL 权限 ACL 权限');
  const after = db.prepare('SELECT COALESCE(SUM(hits),0) n FROM term_edges').get().n;
  assert.equal(after, before * 2, '同一条摘要被索引两次时 hits 会累加（上层靠 hash 挡重复）');
  cleanup();
});

test('剪枝删掉 df 过低的词及其边与倒排（语料足够大时）', () => {
  const { db, cleanup } = freshDb();

  // 造 25 条摘要：公共词 df 很高，另有一条只出现一次的词
  for (let i = 0; i < 25; i += 1) {
    insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: `h${i}` });
    indexSummaryTerms(db, i + 1, '常规 ACL 项目');
  }
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: 'hx' });
  indexSummaryTerms(db, 26, '只出现一次的词');

  const totalBefore = db.prepare('SELECT COUNT(*) n FROM terms').get().n;
  const r = pruneTerms(db, { minDf: 2 });
  const totalAfter = db.prepare('SELECT COUNT(*) n FROM terms').get().n;

  assert.ok(r.removed > 0);
  assert.ok(totalAfter < totalBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM terms WHERE df < 2').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM terms WHERE term = 'acl'").get().n, 1, '高频词应保留');
  cleanup();
});

test('按会话看关键词：只统计该会话的摘要', () => {
  // 为什么要这个：全库榜对"某个会话在聊什么"没有意义。
  // 真实案例：一个会话有 49 条摘要提到 obsidian，但全库 4257 条里只占 1%，
  // 全库排名一千多名，用户以为关键词根本没抓到。
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 'sA', workspace: 'W1' });
  upsertSession(db, { id: 'sB', workspace: 'W1' });

  for (let i = 0; i < 5; i += 1) {
    const id = insertSummary(db, {
      sessionId: 'sA', kind: 'turn', title: `a${i}`, body: `obsidian 笔记 同步 ${i}`, hash: `ha${i}`,
    });
    indexSummaryTerms(db, id, `obsidian 笔记 同步 ${i}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const id = insertSummary(db, {
      sessionId: 'sB', kind: 'turn', title: `b${i}`, body: `数据库 迁移 回滚 ${i}`, hash: `hb${i}`,
    });
    indexSummaryTerms(db, id, `数据库 迁移 回滚 ${i}`);
  }

  const a = listTerms(db, { sessionId: 'sA', limit: 100, includeMuted: true });
  assert.ok(a.some((r) => r.term === 'obsidian'), `sA 应能看到 obsidian，实际：${a.map((r) => r.term).join(',')}`);
  assert.ok(!a.some((r) => r.term === '迁移'), 'sA 不该出现只属于 sB 的词');

  const b = listTerms(db, { sessionId: 'sB', limit: 100, includeMuted: true });
  assert.ok(!b.some((r) => r.term === 'obsidian'), 'sB 不该看到 obsidian');
  assert.ok(b.some((r) => r.term === '迁移'));
  cleanup();
});

test('剪枝在小语料上不把词库清空（df 阈值此时没有统计意义）', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: 'h1' });
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: 'h2' });
  indexSummaryTerms(db, 1, '只出现一次的词');
  indexSummaryTerms(db, 2, '常规 ACL 项目');

  const before = db.prepare('SELECT COUNT(*) n FROM terms').get().n;
  pruneTerms(db, { minDf: 2 }); // 只有 2 条摘要 → 自动退化成 minDf=1
  const after = db.prepare('SELECT COUNT(*) n FROM terms').get().n;

  assert.equal(after, before, '小语料不应剪掉任何词');
  assert.ok(after > 0);
  cleanup();
});

test('建边用的词优先取 ASCII', () => {
  const picked = pickEdgeTerms(['项目', 'acl', '延期', 'bge-m3'], 3);
  assert.ok(picked.includes('acl'));
  assert.ok(picked.includes('bge-m3'));
  assert.ok(!picked.includes('延期') || picked.length === 3);
});

// ── 检索 ──────────────────────────────────────────────────────────────────
test('门控：只命中一个常见词不会过阈值；命中多个才会', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '弱命中', body: '权限', hash: 'h1' });
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '强命中', body: 'ACL 权限 报错', hash: 'h2' });
  indexSummaryTerms(db, 1, '权限');
  indexSummaryTerms(db, 2, 'ACL 权限 报错');

  const r = gate(db, 'ACL 权限 报错', { threshold: 0.35, limit: 5 });
  assert.ok(r.hits.length >= 1);
  assert.equal(r.hits[0].title, '强命中', '应优先命中覆盖更多查询词的摘要');
  assert.ok(!r.hits.some((h) => h.title === '弱命中'), '只命中一个词的不应出现在结果里');
  cleanup();
});

test('hub 降权：同样命中，长摘要的分数被压低', () => {
  const { db, cleanup } = freshDb();
  // 两条摘要都覆盖同样的词，唯一区别是正文长度
  const shortBody = '记忆库 方案';
  const longBody = `记忆库 方案 ${'这个问题我们讨论过很多次'.repeat(60)}`;
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '短的', body: shortBody, hash: 'h1' });
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '长的', body: longBody, hash: 'h2' });
  indexSummaryTerms(db, 1, shortBody);
  indexSummaryTerms(db, 2, longBody);

  const r = gate(db, '记忆库 方案', { threshold: 0.05, limit: 5 });
  const short = r.hits.find((h) => h.title === '短的');
  const long = r.hits.find((h) => h.title === '长的');
  assert.ok(short && long, '两条都应被召回（阈值调低排除干扰）');
  assert.ok(long.score < short.score, `长摘要应被降权：短=${short.score} 长=${long.score}`);
  assert.ok(long.score < 1, '长摘要不该被 clamp 到满分');
  cleanup();
});

test('hubFactor：短摘要不罚，越长越狠，且单调', () => {
  assert.equal(hubFactor(0), 1, '没有长度信息时不降权');
  assert.equal(hubFactor(100), 1, '300 字以内不罚');
  assert.equal(hubFactor(300), 1, '边界值不罚');
  assert.ok(hubFactor(301) < 1, '刚过边界就开始轻微降权');
  assert.ok(hubFactor(600) > 0.7 && hubFactor(600) < 1, `600 字应在 0.7~1 之间，实际 ${hubFactor(600)}`);
  assert.ok(hubFactor(3000) < hubFactor(600), '更长的罚更狠');
  // 单调递减（抽样验证）
  let prev = 1;
  for (const len of [300, 500, 800, 1500, 3000, 8000]) {
    const f = hubFactor(len);
    assert.ok(f <= prev + 1e-9, `长度 ${len} 的系数不该比更短的大`);
    prev = f;
  }
});
test('read_scope=own 只返回本会话的摘要', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 'a', kind: 'turn', title: 'A 的方案', body: '向量库 方案', hash: 'h1' });
  insertSummary(db, { sessionId: 'b', kind: 'turn', title: 'B 的方案', body: '向量库 方案', hash: 'h2' });
  indexSummaryTerms(db, 1, '向量库 方案');
  indexSummaryTerms(db, 2, '向量库 方案');

  const all = gate(db, '向量库 方案', { threshold: 0.2, limit: 5 });
  assert.ok(all.hits.length >= 1);

  const own = gate(db, '向量库 方案', { threshold: 0.2, limit: 5, sessionId: 'a' });
  assert.ok(own.hits.every((h) => h.sessionId === 'a'));
  cleanup();
});

test('重复内容在结果里被折叠', () => {
  const { db, cleanup } = freshDb();
  const body = '这段完全一样的内容会出现在多个会话里';
  insertSummary(db, { sessionId: 'a', kind: 'turn', title: '同标题', body, hash: 'h1' });
  insertSummary(db, { sessionId: 'b', kind: 'turn', title: '同标题', body, hash: 'h2' });
  indexSummaryTerms(db, 1, body);
  indexSummaryTerms(db, 2, body);
  const r = gate(db, body, { threshold: 0.2, limit: 5 });
  assert.equal(r.hits.length, 1, '同标题同正文应只留一条');
  cleanup();
});

test('openSummary 按 seq 区间取回原文', () => {
  const { db, cleanup } = freshDb();
  const ins = db.prepare(
    'INSERT INTO events(session_id, seq, kind, text, ukey) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run('s1', 1, 'user', '第一句', 'k1');
  ins.run('s1', 2, 'assistant', '第二句', 'k2');
  ins.run('s1', 3, 'user', '第三句', 'k3');
  insertSummary(db, {
    sessionId: 's1', kind: 'turn', title: 't', body: 'b', hash: 'h1', seqFrom: 1, seqTo: 2,
  });
  const { events } = openSummary(db, 1);
  assert.deepEqual(events.map((e) => e.text), ['第一句', '第二句']);
  cleanup();
});

test('提示渲染只给标题和 id，不给正文', () => {
  const txt = renderHint([{ id: 7, title: '某标题', score: 0.8, periodFrom: 0 }]);
  assert.ok(txt.includes('#7'));
  assert.ok(txt.includes('某标题'));
  assert.ok(txt.includes('memory_open'));
});

// ── 迁移 ──────────────────────────────────────────────────────────────────
test('迁移复制并校验，失败时不动旧目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-mig-'));
  const from = join(dir, 'old');
  const to = join(dir, 'new');
  const db = openDb(join(from, 'dsh.db'));
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('k', 'v');
  db.close();

  const before = tableCounts(join(from, 'dsh.db'));
  const r = migrateDataDir({ from, to });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(integrityOk(join(to, 'dsh.db')));
  assert.deepEqual(tableCounts(join(to, 'dsh.db')), before);
  assert.ok(tableCounts(join(from, 'dsh.db')), '旧目录应保留');

  // 目标非空应拒绝
  const r2 = migrateDataDir({ from, to });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'target-not-empty');

  rmSync(dir, { recursive: true, force: true });
});

test('迁移源不存在时返回失败而不是抛错', () => {
  const r = migrateDataDir({ from: 'D:\\definitely-not-exists-xyz', to: 'D:\\tmp-xyz' });
  assert.equal(r.ok, false);
});

// ── 配置归一化 ────────────────────────────────────────────────────────────
test('非法配置一律退回默认值，绝不抛错', () => {
  const base = defaults({ dshHome: 'H' });
  const c = normalizeConfig({
    hintThreshold: 99,
    hintMaxItems: -3,
    spreadDepth: 'abc',
    storeUser: false,
    termMinDf: null,
  }, { dshHome: 'H' });

  assert.ok(c.hintThreshold <= 0.95);
  assert.ok(c.hintMaxItems >= 1);
  assert.equal(c.spreadDepth, base.spreadDepth);
  assert.equal(c.storeUser, false, '显式 false 应保留');
  assert.equal(c.termMinDf, base.termMinDf);
});

test('空 dataDir 回退到 dshHome/session-vault', () => {
  const c = normalizeConfig({ dataDir: '' }, { dshHome: 'H' });
  assert.ok(c.dataDir.endsWith('session-vault'));
});

test('分会话策略字典：保留合法映射，丢弃非法形状', () => {
  const c = normalizeConfig({
    sessionStore: { 'session-abc': 'skip', 'session-def': 'store', bad: 123 },
    sessionRead: { 'session-abc': 'own' },
    workspaceStore: ['不是对象'],
    workspaceRead: null,
  }, { dshHome: 'H' });

  assert.equal(c.sessionStore['session-abc'], 'skip');
  assert.equal(c.sessionStore['session-def'], 'store');
  assert.equal(c.sessionStore.bad, '123', '数字会被转成字符串');
  assert.equal(c.sessionRead['session-abc'], 'own');
  assert.deepEqual(c.workspaceStore, {}, '数组应被丢弃');
  assert.deepEqual(c.workspaceRead, {}, 'null 应变成空对象');
});

test('配置字典能落到策略表（模拟设置页同步）', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  upsertSession(db, { id: 's2', workspace: 'W1' });

  // 模拟 index.js 的 syncPolicyFromConfig()
  setWorkspacePolicy(db, { workspace: 'W1', storeDefault: 'skip', readDefault: 'own' });
  setSessionPolicy(db, { sessionId: 's2', storeMode: 'store', readMode: 'all' });

  assert.equal(effectivePolicy(db, 's1').store, 0, 's1 继承工作区: 不存');
  assert.equal(effectivePolicy(db, 's1').readScope, 'own');
  assert.equal(effectivePolicy(db, 's2').store, 1, 's2 显式覆盖: 存');
  assert.equal(effectivePolicy(db, 's2').readScope, 'all');
  cleanup();
});

test('惰性扩散：查询词已够命中时不扩散', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: '目标', body: 'ACL 权限 报错 沙箱', hash: 'h1' });
  indexSummaryTerms(db, 1, 'ACL 权限 报错 沙箱');

  const r = gate(db, 'ACL 权限 报错', { limit: 1, threshold: 0.35 });
  assert.equal(r.hits.length, 1);
  assert.equal(r.stats.spread, 0, '第一遍就够，不应触发扩散');
  assert.equal(r.stats.lazy, true);
  cleanup();
});

test('标签：打标签、按标签展开会话、tags 读策略生效', () => {
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  upsertSession(db, { id: 's2', workspace: 'W1' });

  addSessionTag(db, 's1', 'obsidian');
  addSessionTag(db, 's2', 'obsidian');
  addSessionTag(db, 's2', '笔记');
  assert.deepEqual(listSessionTags(db, 's2'), ['obsidian', '笔记'].sort());
  assert.deepEqual(sessionIdsByTags(db, ['obsidian']).sort(), ['s1', 's2']);
  assert.deepEqual(sessionIdsByTags(db, ['笔记']), ['s2']);
  assert.deepEqual(sessionIdsByTags(db, ['不存在']), []);

  // 读策略用标签：readScope 必须是 'tags' 而不是被 normalize 成 off
  setSessionPolicy(db, { sessionId: 's1', readMode: 'tags:obsidian' });
  const eff = effectivePolicy(db, 's1');
  assert.equal(eff.readScope, 'tags', '「按标签读」不能被当成 off');
  assert.deepEqual(eff.readTags, ['obsidian']);
  cleanup();
});

test('全文检索不会因为查询里的 FTS 语法字符而崩', () => {
  // FTS5 的 MATCH 是查询语法：`whale-memory` 的连字符会被当成 NOT，
  // 直接报 "no such column: memory"。所以每个词都要转义成字符串字面量。
  const { db, cleanup } = freshDb();
  upsertSession(db, { id: 's1', workspace: 'W1' });
  const id = insertSummary(db, {
    sessionId: 's1', kind: 'turn', title: 't', body: '记忆库在 whale-memory 目录', hash: 'h1',
  });
  indexSummaryTerms(db, id, '记忆库在 whale-memory 目录');
  db.prepare(
    `INSERT INTO events(session_id, workspace, seq, kind, role, turn, ts, text, meta, ukey)
     VALUES ('s1','W1',1,'user','user',1,?,? ,NULL,'u1')`,
  ).run(Date.now(), '记忆库在 whale-memory 目录');
  const evId = Number(db.prepare('SELECT id FROM events WHERE ukey = ?').get('u1').id);
  db.prepare('INSERT INTO events_fts(rowid, seg) VALUES (?, ?)').run(evId, 'whale memory 记忆');

  for (const q of ['whale-memory', 'a/b', 'x*y', 'NOT', '路径/转义']) {
    assert.doesNotThrow(() => searchEvents(db, q, { limit: 3 }), `查询「${q}」不该抛错`);
  }
  const hits = searchEvents(db, 'whale-memory', { limit: 3 });
  assert.ok(hits.length > 0, '带连字符的查询应该还能命中');
  cleanup();
});
