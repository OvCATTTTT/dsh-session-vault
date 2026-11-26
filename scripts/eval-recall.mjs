#!/usr/bin/env node
/**
 * 联想质量评估：拿人工标注的基准跑一遍当前检索，出准确率。
 *
 * 用法：
 *   node scripts/eval-recall.mjs              # 跑基准，出指标
 *   node scripts/eval-recall.mjs --verbose    # 逐条列出，方便看哪条退化
 *
 * 为什么要这个：改检索逻辑（阈值、降权、分词、词表）之后，
 * 「感觉好点了」不算数。这个脚本给一个可比的数字。
 *
 * 基准在 test/fixtures/recall-baseline.json，是人工逐条判过的。
 * 判定标准写在那份文件的 note 里。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionVault } from '../src/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, '..', 'test', 'fixtures', 'recall-baseline.json');
const verbose = process.argv.includes('--verbose');

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const label = new Map();
for (const s of baseline.sample) {
  for (const h of s.hits) label.set(`${s.query}\u0000${h.id}`, h);
}

// 路径必须由环境变量给，不写默认值 —— 这个仓库是公开的，
// 源码里不该出现任何人的本机目录结构。
const dataDir = process.env.VAULT_DATA_DIR;
const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
if (!dataDir) {
  console.error(
    '需要环境变量 VAULT_DATA_DIR 指向记忆库目录，例如：\n'
    + '  $env:VAULT_DATA_DIR = "<你的记忆库目录>"\n'
    + '  $env:DSH_HOME = "<你的 ~/.dsh 目录>"   # 可选，默认 %USERPROFILE%\\.dsh\n'
    + '  node scripts/eval-recall.mjs',
  );
  process.exit(1);
}
const vault = new SessionVault({
  dataDir,
  sessionsRoot: join(dshHome, 'sessions'),
  dshHome,
  log: () => {},
});
vault.open();

let top1Rel = 0;
let top1Total = 0;
let hitRel = 0;
let hitTotal = 0;
let top1Changed = 0;
let unknownCount = 0;
const lines = [];

for (const sample of baseline.sample) {
  const expected = new Map(sample.hits.map((h) => [h.id, h]));
  const r = vault.recall(sample.query, { readScope: 'all', limit: 3, log: false });
  const hits = r.hits ?? [];

  if (sample.hits.length === 0) continue;

  // top1：当前第一条在基准里被标成什么
  const first = hits[0];
  if (first) {
    top1Total += 1;
    const l = expected.get(first.id) ?? label.get(`${sample.query}\u0000${first.id}`);
    if (!l) unknownCount += 1;
    else if (l.relevant) top1Rel += 1;
    if (sample.hits[0] && first.id !== sample.hits[0].id) top1Changed += 1;
  }

  // 总体：当前 top3 里，基准标为 relevant 的有多少
  for (const h of hits) {
    hitTotal += 1;
    const l = expected.get(h.id) ?? label.get(`${sample.query}\u0000${h.id}`);
    if (l?.relevant) hitRel += 1;
  }

  if (verbose) {
    const q = sample.query.replace(/\n/g, ' / ').slice(0, 40);
    const mark = (id) => {
      const l = expected.get(id) ?? label.get(`${sample.query}\u0000${id}`);
      if (!l) return '?';
      return l.relevant ? '✓' : '✗';
    };
    lines.push(`${mark(hits[0]?.id)} ${q.padEnd(42)} → ${hits.slice(0, 3).map((h) => `#${h.id}${mark(h.id)}`).join(' ')}`);
  }
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

console.log('联想质量评估（基准 ' + baseline.sample.filter((s) => s.hits.length > 0).length + ' 条）');
console.log('─'.repeat(56));
console.log(`top1 相关率     ${pct(top1Rel, top1Total).padStart(7)}   (${top1Rel}/${top1Total})`);
console.log(`top3 命中相关率  ${pct(hitRel, hitTotal).padStart(7)}   (${hitRel}/${hitTotal})`);
console.log(`top1 与标注不同   ${String(top1Changed).padStart(7)}   (改了检索逻辑后这个会变)`);
if (unknownCount) {
  console.log(`未标注的新命中   ${String(unknownCount).padStart(7)}   (基准里没有，需要人工再看)`);
}

if (verbose) {
  console.log('\n逐条（✓ 相关 / ✗ 不相关 / ? 未标注）：');
  for (const l of lines) console.log('  ' + l);
}

vault.close();
