/**
 * 按标签读（read_scope = tags）的测试。
 *
 * 背景：这个功能曾经是**半截**的。
 *   · 界面上能建标签、能选中「标签：xxx」，库里也存对了 eff_read='tags'
 *   · 但 `parsePolicyChange` 的校验只放行四档，请求直接 400（选不上）
 *   · 就算绕过校验存进去了，`core.recall` 只处理了 off / own，
 *     `tags` 落进"不限会话"的分支 —— 等于读全库（多选没生效）
 *
 * 所以这里两头都要盯住：校验层放行，检索层真的按标签限。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, metaSet } from '../src/db.js';
import { parsePolicyChange } from '../src/ui-data.js';
import { parseTagScope, formatTagScope } from '../src/policy.js';
import { insertSummary, indexSummaryTerms } from '../src/indexer.js';
import { gate, searchEvents } from '../src/recall.js';
import { seg as ftsSeg } from '../src/ngram.js';

// ── 解析层 ────────────────────────────────────────────────────────────────

test('parseTagScope：只认 tags: 前缀，过滤非法标签名', () => {
  assert.deepEqual(parseTagScope('tags:工作区'), ['工作区']);
  assert.deepEqual(parseTagScope('tags:a,b'), ['a', 'b']);
  assert.deepEqual(parseTagScope('tags:a, b'), ['a', 'b'], '逗号后空格要 trim');
  assert.equal(parseTagScope('all'), null, '不是 tags 形式返回 null');
  assert.deepEqual(parseTagScope('tags:'), [], '空标签列表');
  // parse 只负责解析，去重是 formatTagScope 的事
  assert.deepEqual(parseTagScope('tags:a,a'), ['a', 'a']);
});

test('formatTagScope：拼回存储形式，空列表退回 off', () => {
  assert.equal(formatTagScope(['工作区']), 'tags:工作区');
  assert.equal(formatTagScope(['a', 'b']), 'tags:a,b');
  assert.equal(formatTagScope(['a', 'a']), 'tags:a', '去重');
  assert.equal(formatTagScope([]), 'off', '空列表不能产出 tags:');
});

// ── 校验层（这是"选不上"的直接原因）────────────────────────────────────────

test('parsePolicyChange：放行 tags: 形式的读模式', () => {
  for (const readMode of ['tags:工作区', 'tags:a,b', 'tags:一个很长的中文标签名']) {
    const r = parsePolicyChange({ sessionId: 's1', readMode });
    assert.equal(r.ok, true, `${readMode} 应该放行，实际：${r.error}`);
    assert.equal(r.kind, 'session');
    assert.equal(r.args.readMode, readMode);
  }
});

test('parsePolicyChange：基础四档仍然放行', () => {
  for (const readMode of ['inherit', 'off', 'own', 'all']) {
    assert.equal(parsePolicyChange({ sessionId: 's1', readMode }).ok, true, readMode);
  }
});

test('parsePolicyChange：拒绝空 tags: 和乱七八糟的值', () => {
  assert.equal(parsePolicyChange({ sessionId: 's1', readMode: 'tags:' }).ok, false, '空标签列表没意义');
  assert.equal(parsePolicyChange({ sessionId: 's1', readMode: 'bogus' }).ok, false);
  assert.equal(parsePolicyChange({ sessionId: 's1', readMode: 'tag:x' }).ok, false, '前缀写错要拒绝');
});

// ── 检索层（这是"多选没生效"的实质）────────────────────────────────────────

function freshDb() {
  const path = join(tmpdir(), `sv-tags-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch { /* 忽略 */ }
      try { rmSync(path, { force: true }); } catch { /* Windows 句柄没放开会 EPERM */ }
    },
  };
}

/** 造两条摘要，分别属于 s1 / s2，内容都含「记忆库」。 */
function seedTwoSessions(db) {
  for (const id of ['s1', 's2']) {
    db.prepare(
      `INSERT OR REPLACE INTO sessions(id, workspace, title, event_count, last_seen_at)
       VALUES (?, 'ws', ?, 1, ?)`,
    ).run(id, `会话 ${id}`, Date.now());
  }
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 's1 的摘要', body: '记忆库 方案 设计', hash: 'h1' });
  insertSummary(db, { sessionId: 's2', kind: 'turn', title: 's2 的摘要', body: '记忆库 方案 讨论', hash: 'h2' });
  indexSummaryTerms(db, 1, '记忆库 方案 设计');
  indexSummaryTerms(db, 2, '记忆库 方案 讨论');
}

test('gate：sessionIds 白名单只放行指定会话', () => {
  const { db, cleanup } = freshDb();
  seedTwoSessions(db);

  const all = gate(db, '记忆库 方案', { threshold: 0.05, limit: 10 });
  assert.equal(all.hits.length, 2, '不传白名单时两条都能命中');

  const only1 = gate(db, '记忆库 方案', { threshold: 0.05, limit: 10, sessionIds: ['s1'] });
  assert.equal(only1.hits.length, 1, '白名单只有 s1');
  assert.equal(only1.hits[0].sessionId, 's1');

  const none = gate(db, '记忆库 方案', { threshold: 0.05, limit: 10, sessionIds: [] });
  assert.equal(none.hits.length, 0, '空白名单应该一条都不给（不能退回读全库）');
  cleanup();
});

test('gate：白名单不污染缓存 —— 不同标签组合各自独立', () => {
  const { db, cleanup } = freshDb();
  seedTwoSessions(db);

  const a = gate(db, '记忆库 方案', { threshold: 0.05, limit: 10, sessionIds: ['s1'] });
  const b = gate(db, '记忆库 方案', { threshold: 0.05, limit: 10, sessionIds: ['s2'] });
  assert.equal(a.hits.length, 1);
  assert.equal(b.hits.length, 1);
  assert.equal(a.hits[0].sessionId, 's1');
  assert.equal(b.hits[0].sessionId, 's2', '第二次查询不能拿到第一次的缓存结果');
  cleanup();
});

test('searchEvents：sessionIds 白名单同样生效', () => {
  const { db, cleanup } = freshDb();
  // 事件 + FTS
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO events(session_id, seq, kind, ts, text, ukey) VALUES (?, ?, 'user', ?, ?, ?)`,
  );
  const id1 = Number(ins.run('s1', 1, now, '记忆库 方案 甲', 's1:1').lastInsertRowid);
  const id2 = Number(ins.run('s2', 1, now, '记忆库 方案 乙', 's2:1').lastInsertRowid);
  const insFts = db.prepare('INSERT INTO events_fts(rowid, seg) VALUES (?, ?)');
  // 必须用和检索同一套分词：手写 '记忆库' 在 unicode61 下是单个 token，
  // 而查询走 bigram（记忆/忆库），两边对不上就永远搜不到。
  insFts.run(id1, ftsSeg('记忆库 方案 甲'));
  insFts.run(id2, ftsSeg('记忆库 方案 乙'));

  const all = searchEvents(db, '记忆库', { limit: 10 });
  assert.ok(all.length >= 2);

  const only1 = searchEvents(db, '记忆库', { limit: 10, sessionIds: ['s1'] });
  assert.ok(only1.length >= 1);
  assert.ok(only1.every((r) => r.session_id === 's1'), '白名单外的事件不能出现');

  const none = searchEvents(db, '记忆库', { limit: 10, sessionIds: [] });
  assert.equal(none.length, 0, '空白名单一条都不给');
  cleanup();
});
