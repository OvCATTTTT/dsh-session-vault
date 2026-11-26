#!/usr/bin/env node
/**
 * 检索耗时基准。
 *
 * 注意：这里**直接调用真实的 gate() / spread()**，不重写一遍检索流程 ——
 * 早先的版本自己复制了一份管线，导致优化后数字不变（基准测的不是真代码）。
 *
 * 用法：
 *   node scripts/bench.js --data <已建好的库目录> [--repeat 5]
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { terms as tokenize } from '../src/ngram.js';
import { gate, spread, termWeight, invalidateRecallCache } from '../src/recall.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg('data');
if (!dataDir) {
  console.error('需要 --data <库目录>');
  process.exit(1);
}
const repeat = Number(arg('repeat', '5')) || 5;

const db = new DatabaseSync(join(dataDir, 'dsh.db'), { readOnly: true });
const total = db.prepare('SELECT COUNT(*) AS n FROM summaries').get().n;
const edges = db.prepare('SELECT COUNT(*) AS n FROM term_edges').get().n;
const termsCount = db.prepare('SELECT COUNT(*) AS n FROM terms').get().n;
console.log(`摘要 ${total} 条 · 关键词 ${termsCount} · 共现边 ${edges}\n`);

const queries = [
  'IPv6 NODE_OPTIONS 超时',
  'billion-context 压缩',
  '人格卡 权限等级',
  'surfcore 扩展 投递',
  'ollama 嵌入模型',
  '主人 偏好 简短',
];

const findTerm = db.prepare('SELECT id, term, df, muted FROM terms WHERE term = ?');

/** 取耗时中位数（比单次最小值更能代表真实体感）。 */
function median(fn) {
  const samples = [];
  let last;
  for (let i = 0; i < repeat; i += 1) {
    invalidateRecallCache(); // 每次重新算，否则测到的是缓存
    const t = performance.now();
    last = fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[Math.floor(samples.length / 2)], out: last };
}

function buildSeeds(q) {
  const seeds = [];
  for (const t of tokenize(q)) {
    const row = findTerm.get(t);
    if (!row || row.muted) continue;
    if (row.df > 3 && row.df > total * 0.6) continue;
    seeds.push({ id: row.id, w: termWeight(row.df, total, null), term: row.term });
  }
  return seeds;
}

console.log(
  '查询'.padEnd(26),
  '整条gate'.padStart(9),
  '其中扩散'.padStart(9),
  '扩散词'.padStart(7),
  '命中'.padStart(5),
  'seed',
);
console.log('-'.repeat(96));

let worst = 0;
let sum = 0;
for (const q of queries) {
  const g = median(() => gate(db, q, { limit: 3, threshold: 0.35 }));
  const seeds = buildSeeds(q);
  const s = median(() => spread(db, seeds.map(({ id, w }) => ({ id, w })), { depth: 2, jump: 0.4 }));

  worst = Math.max(worst, g.ms);
  sum += g.ms;
  console.log(
    q.padEnd(24),
    `${g.ms.toFixed(1)}ms`.padStart(9),
    `${s.ms.toFixed(1)}ms`.padStart(9),
    String(s.out?.size ?? 0).padStart(7),
    String(g.out.hits.length).padStart(5),
    `  ${seeds.map((x) => x.term).join(',')}`,
  );
}

console.log(`\n平均 ${(sum / queries.length).toFixed(1)}ms · 最慢 ${worst.toFixed(1)}ms`);

// 只看扩散的裸开销（不含倒排与详情查询）
const seeds0 = buildSeeds(queries[0]);
const bare = median(() => spread(db, seeds0.map(({ id, w }) => ({ id, w })), { depth: 2, jump: 0.4 }));
console.log(`扩散单独耗时（深度2）：${bare.ms.toFixed(1)}ms，产出 ${bare.out.size} 个词`);

db.close();
