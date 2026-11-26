#!/usr/bin/env node
/**
 * 从 app.asar 里查官方插件 API 定义（不依赖网络）。
 *
 * 用途：确认 `agent/inbox/claimed`、`systemPrompt.section`、`ctx.slots.register`
 * 这些接口的官方形状，而不是照抄第三方插件的用法。
 *
 * 用法：node scripts/asar-grep.js "关键词1" "关键词2" ...
 */

import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';

const ASAR = process.env.DSH_ASAR;
if (!ASAR) {
  console.error('请先用环境变量 DSH_ASAR 指向 app.asar 的绝对路径，例如：');
  console.error('  DSH_ASAR="/path/to/resources/app.asar" node scripts/asar-grep.js "关键词"');
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
  const tree = JSON.parse(s);
  return { fd, base: 16 + jsonLen, tree };
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

const keywords = process.argv.slice(2);
if (keywords.length === 0) {
  console.error('用法: node scripts/asar-grep.js <关键词...>');
  process.exit(1);
}

// 只关心体积小、可能是文档/类型/源码入口的文件
const MAX = 400 * 1024;
const cands = all.filter((f) => f.size > 0 && f.size < MAX && /\.(js|mjs|cjs|ts|md|json)$/.test(f.path));
console.log(`asar 共 ${all.length} 个文件，可检索 ${cands.length} 个\n`);

let scanned = 0;
let hits = 0;
const outLines = [];

for (const f of cands) {
  let buf;
  try {
    buf = Buffer.alloc(f.size);
    readSync(fd, buf, 0, f.size, base + f.offset);
  } catch {
    continue;
  }
  const text = buf.toString('utf8');
  scanned += 1;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const kw of keywords) {
      if (lines[i].includes(kw)) {
        const snippet = lines[i].trim().slice(0, 220);
        outLines.push(`[${f.path}:${i + 1}] ${snippet}`);
        hits += 1;
        break;
      }
    }
    if (outLines.length > 4000) break;
  }
  if (outLines.length > 4000) break;
}

closeSync(fd);

if (outLines.length) {
  console.log(outLines.join('\n'));
  writeFileSync('asar-grep-result.txt', outLines.join('\n'), 'utf8');
  console.log(`\n--- 共 ${hits} 处命中，已存 asar-grep-result.txt ---`);
} else {
  console.log('没有命中。');
}
