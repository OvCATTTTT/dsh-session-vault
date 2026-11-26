#!/usr/bin/env node
/**
 * 从 app.asar 里列目录 / 导出单个文件。
 *
 * 用法：
 *   node scripts/asar-dump.js --list "dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills"
 *   node scripts/asar-dump.js --dump "path/in/asar.md"
 */

import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ASAR = process.env.DSH_ASAR;
if (!ASAR) {
  console.error('请先用环境变量 DSH_ASAR 指向 app.asar 的绝对路径，例如：');
  console.error('  DSH_ASAR="/path/to/resources/app.asar" node scripts/asar-dump.js --list "dsh/..."');
  process.exit(1);
}

function parseHeader() {
  const fd = openSync(ASAR, 'r');
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(4);
  const hdr = Buffer.alloc(jsonLen);
  readSync(fd, hdr, 0, jsonLen, 16);
  let s = hdr.toString('utf8');
  s = s.slice(0, s.lastIndexOf('}') + 1);
  return { fd, base: 16 + jsonLen, tree: JSON.parse(s) };
}

function walk(node, path, out) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = path ? `${path}/${name}` : name;
    if (v.files) walk(v, p, out);
    else out.push({ path: p, size: Number(v.size), offset: Number(v.offset) });
  }
}

const { fd, base, tree } = parseHeader();
const all = [];
walk(tree, '', all);

const mode = process.argv[2];
const arg = process.argv[3] ?? '';

if (mode === '--list') {
  const hits = all.filter((f) => f.path.startsWith(arg)).sort((a, b) => a.path.localeCompare(b.path));
  for (const f of hits) console.log(`${String(f.size).padStart(9)}  ${f.path}`);
  console.log(`\n共 ${hits.length} 个`);
} else if (mode === '--dump') {
  const f = all.find((x) => x.path === arg);
  if (!f) {
    console.error('找不到:', arg);
    process.exit(1);
  }
  const buf = Buffer.alloc(f.size);
  readSync(fd, buf, 0, f.size, base + f.offset);
  const outDir = join(process.cwd(), 'asar-dump');
  const out = join(outDir, arg.replace(/[\\/]/g, '__'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log(`已导出 → ${out}（${f.size} 字节）`);
} else {
  console.error('用法: --list <前缀> | --dump <完整路径>');
}

closeSync(fd);
