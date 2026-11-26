#!/usr/bin/env node
/**
 * 冒烟测试：用真实 DSH 会话目录跑一遍导入 + 检索 + 展开。
 *
 * 用法：
 *   node scripts/smoke.js [--data <dir>] [--sessions <dir>] [--query "..."...]
 *
 * 默认数据目录是临时目录，不会污染正式库。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SessionVault } from '../src/core.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function args(name) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const dataDir = arg('data', join(tmpdir(), `session-vault-smoke-${Date.now()}`));
const sessionsRoot = arg('sessions', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions'));
const queries = args('query');
const cleanup = !arg('data');

console.log('数据目录:', dataDir);
console.log('会话目录:', sessionsRoot);
console.log('');

const vault = new SessionVault({
  dataDir,
  sessionsRoot,
  log: (m) => console.log('  ·', m),
  config: {
    storeReasoning: false,
    storeSystem: false,
    storeToolCall: true,
    storeToolResult: true,
    spoolEnabled: false,
    summaryMaxChars: 1200,
  },
});

const t0 = Date.now();
const scan = vault.scan();
console.log(`扫描完成 ${scan.ms} ms：`);
console.log(`  文件 ${scan.files} · 事件 +${scan.newEvents} · 摘要 +${scan.newSummaries} · 会话 ${scan.sessions}`);
if (scan.skippedByPolicy) console.log(`  按策略跳过 ${scan.skippedByPolicy} 条`);
console.log('');

const stats = vault.stats();
console.log('库统计：');
console.log(`  会话 ${stats.sessions} · 事件 ${stats.events} · 摘要 ${stats.summaries}（压缩 ${stats.compactionSummaries}）`);
console.log(`  关键词 ${stats.activeTerms}/${stats.terms} · 共现边 ${stats.edges}`);
console.log(`  体积 ${(stats.sizeBytes / 1048576).toFixed(2)} MB`);
console.log('  事件类型：', stats.byKind.map((k) => `${k.kind}=${k.n}`).join(' '));
console.log('');

const qs = queries.length ? queries : ['ACL 权限报错', '向量库 方案', 'fatal not a git repository', '记忆卡 衰减'];
for (const q of qs) {
  const r = vault.recall(q, { limit: 3, log: false });
  console.log(`【${q}】 命中 ${r.hits.length} 条 · seed=${r.seedTerms.slice(0, 6).join(',')} · ${r.stats.ms}ms`);
  for (const h of r.hits) {
    console.log(`   #${h.id} ${h.score} · ${h.title} · ${h.kind}`);
  }
  if (r.hits.length === 0 && r.fallbackEvents?.length) {
    console.log(`   兜底原文检索 ${r.fallbackEvents.length} 条`);
  }
  console.log('');
}

// 展开第一条命中的原文
const first = vault.recall(qs[0], { limit: 1, log: false });
if (first.hits.length) {
  const { summary, events } = vault.expand(first.hits[0].id, { maxChars: 800 });
  console.log(`展开 #${summary.id}「${summary.title}」 → ${events.length} 条原文：`);
  for (const e of events.slice(0, 3)) {
    console.log(`   [${e.role ?? e.kind}] ${String(e.text).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  console.log('');
}

// 策略三级解析自测
const sid = vault.sessions(1)[0]?.id;
if (sid) {
  console.log('策略解析自测：');
  console.log('  默认 →', JSON.stringify(vault.policyOf(sid)));
  vault.setSession({ sessionId: sid, storeMode: 'skip', readMode: 'own' });
  console.log('  会话级 skip/own →', JSON.stringify(vault.policyOf(sid)));
  vault.setSession({ sessionId: sid, storeMode: 'inherit', readMode: 'inherit' });
  console.log('  回退继承 →', JSON.stringify(vault.policyOf(sid)));
  console.log('');
}

vault.close();
if (cleanup) rmSync(dataDir, { recursive: true, force: true });
console.log(`总耗时 ${Date.now() - t0} ms`);
