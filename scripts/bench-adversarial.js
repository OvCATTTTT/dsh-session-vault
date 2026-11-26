#!/usr/bin/env node
/**
 * 最坏情况检索延迟测试。
 *
 * bench.js 测的是"正常查询"，但真正决定每轮门控能否安全同步执行的是**最坏情况**：
 * 查询词全是常见词、完全没出现过、或者是一整句长中文。
 *
 * 用法：node scripts/bench-adversarial.js --data <库目录>
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { gate, invalidateRecallCache } from '../src/recall.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg('data');
if (!dataDir) {
  console.error('需要 --data <库目录>');
  process.exit(1);
}

const db = new DatabaseSync(join(dataDir, 'dsh.db'), { readOnly: true });

const cases = [
  ['正常低频词', 'IPv6 NODE_OPTIONS 超时'],
  ['只有常见词', '这个 问题 可以'],
  ['完全没出现过', '量子纠缠 波函数 坍缩'],
  ['单字', '火'],
  ['长句混合', '我记得很久之前你说过那个关于记忆库的事情是不是有个方案来着'],
  ['只要 ASCII', 'dsh plugin add'],
  ['空查询', ''],
];

let worst = 0;
for (const [label, q] of cases) {
  const samples = [];
  let out;
  for (let i = 0; i < 5; i += 1) {
    invalidateRecallCache();
    const t = performance.now();
    out = gate(db, q, { limit: 3, threshold: 0.35 });
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const ms = samples[Math.floor(samples.length / 2)];
  worst = Math.max(worst, ms);
  console.log(
    `${label.padEnd(12)} ${ms.toFixed(1).padStart(6)}ms  命中${String(out.hits.length).padStart(2)}`
    + `  扩散${String(out.stats.spread ?? 0).padStart(4)}词  惰性=${out.stats.lazy ? '是' : '否'}  | ${q.slice(0, 28)}`,
  );
}

console.log(`\n最坏情况：${worst.toFixed(1)}ms`);

db.close();
