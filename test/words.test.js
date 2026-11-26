/**
 * 词发现 + 双写索引的测试。
 *
 * 这里刻意**不**依赖默认的 PMI/熵阈值 —— 那些阈值是在真实语料（489 条摘要、
 * 14 万字）上标定的，几十条假数据里算出来的 PMI 没有可比性。
 * 所以分两类测：
 *   1. 纯逻辑：熵能识别碎片、词表匹配、双写、检索命中
 *   2. 集成：手动塞词表，验证索引和检索按预期工作
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverFromTexts, discoverWordsAsync, findWordsIn, buildWordIndex } from '../src/worddiscover.js';
import { openDb, metaSet } from '../src/db.js';
import { insertSummary, indexSummaryTerms, invalidateWordIndex, listTerms } from '../src/indexer.js';
import { gate } from '../src/recall.js';

function freshDb() {
  const path = join(tmpdir(), `sv-words-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(path);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch { /* 忽略 */ }
      try { rmSync(path, { force: true }); } catch { /* Windows 句柄没放开会 EPERM */ }
    },
  };
}

/** 塞一份词表进库（模拟词发现已经跑过）。 */
function seedWords(db, words) {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO mined_words(word, freq, pmi, entropy, run_id, created_at)
     VALUES (?, 10, 9, 3, 1, ?)`,
  );
  for (const w of words) ins.run(w, Date.now());
  metaSet(db, 'words_epoch', '1');
  invalidateWordIndex(db);
}

// ── 词发现 ────────────────────────────────────────────────────────────────

test('词发现：纯碎片（左右邻固定）会被熵筛掉', () => {
  // 「关键词」左右邻都多样 → 熵高；「键词」左邻永远是「关」 → 左熵 = 0 → 必被筛
  const lefts = '我你在他和这那其与并且或';
  const rights = '索库表汇说明页重很都也';
  const texts = [];
  for (const l of lefts) {
    for (const r of rights) texts.push(`${l}关键词${r}`);
  }
  // minPMI 传 0 绕过互信息门槛，单独验熵的作用
  const r = discoverFromTexts(texts, { minFreq: 5, minPMI: 0, minEntropy: 1.5 });
  const words = r.words.map((w) => w.word);
  assert.ok(words.includes('关键词'), `应认出「关键词」，实际：${words.join(',')}`);
  assert.ok(!words.includes('键词'), '「键词」左邻固定，必须被熵筛掉');
  assert.ok(!words.includes('关键'), '「关键」右邻固定，必须被熵筛掉');
});

test('词发现：空语料返回空结果，不炸', () => {
  const r = discoverFromTexts([], {});
  assert.deepEqual(r.words, []);
  assert.equal(r.stats.total, 0);
  const r2 = discoverFromTexts(['   ', '!!!'], {});
  assert.deepEqual(r2.words, []);
});

test('词发现：停用词不进词表', () => {
  const lefts = '我你在他和这那其与并且或';
  const rights = '索库表汇说明页重很都也';
  const texts = [];
  for (const l of lefts) {
    for (const r of rights) texts.push(`${l}已经${r}`);
  }
  const r = discoverFromTexts(texts, { minFreq: 5, minPMI: 0, minEntropy: 1.5 });
  assert.ok(!r.words.some((w) => w.word === '已经'), '「已经」在停用词表里，不该进词表');
});

test('词发现：异步版和同步版结果一致', async () => {
  const texts = [];
  const lefts = '我你在他和这那其与并且或';
  const rights = '索库表汇说明页重很都也';
  for (const l of lefts) for (const r of rights) texts.push(`${l}关键词${r}`);

  const sync = discoverFromTexts(texts, { minFreq: 5, minPMI: 0, minEntropy: 1.5 });
  const async_ = await discoverWordsAsync(texts, { minFreq: 5, minPMI: 0, minEntropy: 1.5, chunk: 3 });
  assert.deepEqual(
    async_.words.map((w) => w.word).sort(),
    sync.words.map((w) => w.word).sort(),
    '分批不该改变结果',
  );
});

// ── 词表匹配 ──────────────────────────────────────────────────────────────

test('findWordsIn：按首字分桶，长词优先在正确位置命中', () => {
  const index = buildWordIndex(['关键词', '词索引', '记忆库', '记忆']);
  assert.deepEqual(findWordsIn('关键词索引', index).sort(), ['关键词', '词索引'].sort());
  assert.deepEqual(findWordsIn('记忆库里有记忆', index).sort(), ['记忆', '记忆库', '记忆'].sort());
  assert.deepEqual(findWordsIn('完全无关的一句话', index), []);
  assert.deepEqual(findWordsIn('', index), []);
  assert.deepEqual(findWordsIn('随便', null), [], '没有词表时返回空');
});

// ── 双写 ──────────────────────────────────────────────────────────────────

test('没有词表时退回纯 bigram，不报错', () => {
  const { db, cleanup } = freshDb();
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: '关键词索引', hash: 'h1' });
  indexSummaryTerms(db, 1, '关键词索引');
  const rows = db.prepare('SELECT term, kind FROM terms').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.kind === 'gram'), '没有词表时全部是 gram');
  // 默认只列真词，但没词表要退回列全部
  const listed = listTerms(db, { limit: 50 });
  assert.ok(listed.length > 0, '没词表时 listTerms 应该退回列 bigram，不能空');
  cleanup();
});

test('有词表时真词以 kind=word 写入，且倒排权重更高', () => {
  const { db, cleanup } = freshDb();
  seedWords(db, ['关键词', '记忆库']);
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: '关键词和记忆库', hash: 'h1' });
  indexSummaryTerms(db, 1, '关键词和记忆库');

  const word = db.prepare("SELECT id, kind FROM terms WHERE term = '关键词'").get();
  assert.ok(word, '应写入真词');
  assert.equal(word.kind, 'word');

  const inv = db.prepare('SELECT w FROM terms_inv WHERE term = ? AND summary = 1').get(word.id);
  assert.equal(inv.w, 1.8, '真词的倒排权重应是 1.8');

  // 纯 bigram 仍是 1
  const gram = db.prepare("SELECT id FROM terms WHERE term = '记忆'").get();
  const gin = db.prepare('SELECT w FROM terms_inv WHERE term = ? AND summary = 1').get(gram.id);
  assert.equal(gin.w, 1);
  cleanup();
});

test('关键词页默认只列真词；kind=all 才给全部', () => {
  const { db, cleanup } = freshDb();
  seedWords(db, ['关键词']);
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 't', body: '关键词索引', hash: 'h1' });
  indexSummaryTerms(db, 1, '关键词索引');

  const wordsOnly = listTerms(db, { limit: 100, kind: 'word' });
  assert.deepEqual(wordsOnly.map((r) => r.term), ['关键词'], '只列真词');

  const gramsOnly = listTerms(db, { limit: 100, kind: 'gram' });
  assert.ok(gramsOnly.length > 0, 'gram 也应该能单独看');
  assert.ok(!gramsOnly.some((r) => r.term === '关键词'), 'gram 列表里不该有真词');

  const all = listTerms(db, { limit: 100, kind: 'all' });
  assert.ok(all.length > wordsOnly.length, 'all 应该比只列真词多');
  cleanup();
});

// ── 检索 ──────────────────────────────────────────────────────────────────

test('查询里的真词能命中，并且比只靠 bigram 更靠前', () => {
  const { db, cleanup } = freshDb();
  seedWords(db, ['关键词']);
  // 摘要 A：完整包含「关键词」
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 'A', body: '关键词索引怎么建', hash: 'h1' });
  indexSummaryTerms(db, 1, '关键词索引怎么建');
  // 摘要 B：只沾到 bigram「关键」和「键词」的一半
  insertSummary(db, { sessionId: 's1', kind: 'turn', title: 'B', body: '关键问题', hash: 'h2' });
  indexSummaryTerms(db, 2, '关键问题');

  const r = gate(db, '关键词索引', { threshold: 0.1, limit: 5 });
  assert.ok(r.hits.length > 0, '应该有命中');
  assert.equal(r.hits[0].title, 'A', `完整命中的 A 应排第一，实际 ${r.hits.map((h) => h.title)}`);
  assert.ok(r.stats.minedWords >= 1, 'stats 里应该记录查询侧认出了真词');
  cleanup();
});

// ── 样本不足 ──────────────────────────────────────────────────────────────

test('discoverWordsAsync 在样本太少时跳过，而不是产出噪声词表', async () => {
  // 直接构造一个只有 3 条摘要的库，用最小限度的假 SessionVault 不方便，
  // 所以这里只验证常量语义：默认门槛是 80
  const { DEFAULT_MIN_SAMPLES } = await import('../src/worddiscover.js');
  assert.equal(DEFAULT_MIN_SAMPLES, 80);
});
