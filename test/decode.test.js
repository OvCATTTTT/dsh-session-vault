import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { frameOffsets, decodeFrom, parseLines, ZSTD_MAGIC } from '../src/decode.js';
import { extract, firstLine, looksGarbled, isTextlessEvent, looksLikePrompt } from '../src/extract.js';

test('多帧 zstd 能全部解码（这是 DSH 会话日志的真实形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-decode-'));
  const file = join(dir, 'session.v4.jsonl.zstd');
  const lines = [
    JSON.stringify({ type: 'session', id: 's1', version: 4, cwd: 'D:\\ws' }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '在' }] } } }),
  ];
  // 模拟 DSH：一行一个 frame
  writeFileSync(file, Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`, 'utf8')))));

  const offsets = frameOffsets(readFileSync(file));
  assert.equal(offsets.length, 3, '应有 3 个独立 frame');

  const r = decodeFrom(file, 0);
  assert.equal(r.frames, 3);
  assert.equal(r.truncated, false);
  const recs = parseLines(r.text);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].type, 'session');

  rmSync(dir, { recursive: true, force: true });
});

test('增量：水位之后不再重复解码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-decode2-'));
  const file = join(dir, 'a.jsonl.zstd');
  const f1 = zstdCompressSync(Buffer.from('{"type":"session","id":"s"}\n', 'utf8'));
  writeFileSync(file, f1);

  const first = decodeFrom(file, 0);
  assert.equal(first.frames, 1);
  assert.ok(first.bytesDone > 0);

  const again = decodeFrom(file, first.bytesDone);
  assert.equal(again.text, '', '水位之后的第一次应为空');
  assert.equal(again.frames, 0);

  // 追加新帧后，只解出新内容
  const f2 = zstdCompressSync(Buffer.from('{"type":"user/message"}\n', 'utf8'));
  writeFileSync(file, Buffer.concat([f1, f2]));
  const phase2 = decodeFrom(file, first.bytesDone);
  assert.equal(phase2.frames, 1);
  assert.ok(phase2.text.includes('user/message'));

  rmSync(dir, { recursive: true, force: true });
});

test('尾部不完整的帧不推进水位、不产生半个记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-decode3-'));
  const file = join(dir, 'b.jsonl.zstd');
  const good = zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8'));
  const bad = Buffer.concat([ZSTD_MAGIC, Buffer.from([0, 0, 0])]); // 假 frame
  writeFileSync(file, Buffer.concat([good, bad]));

  const r = decodeFrom(file, 0);
  assert.equal(r.frames, 1, '只应解出完整的那个帧');
  assert.equal(r.truncated, true, '应报告尾部被截断');
  assert.equal(r.bytesDone, good.length, '水位停在坏帧之前');

  rmSync(dir, { recursive: true, force: true });
});

test('extract 取出用户/助手/工具文本，跳过遥测', () => {
  const u = extract({ type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: '  ' }] } });
  assert.equal(u.rows.length, 0, '空白文本不入库');

  const a = extract({
    type: 'assistant/message',
    seq: 2,
    time: 20,
    data: { turn: 1, message: { content: [{ type: 'text', text: '答' }, { type: 'reasoning', text: '想' }] } },
  });
  assert.deepEqual(a.rows.map((r) => r.kind), ['assistant', 'reasoning']);

  const t = extract({
    type: 'tool/result',
    seq: 3,
    time: 30,
    data: { turn: 1, message: { role: 'tool', isError: true, toolCallId: 'c1', content: [{ type: 'text', text: '报错' }] } },
  });
  assert.equal(t.rows[0].kind, 'tool-result');
  assert.equal(t.rows[0].meta, JSON.stringify({ callId: 'c1', isError: true }));

  const tel = extract({ type: 'job/registered', seq: 4, time: 40, data: {} });
  assert.equal(tel.rows.length, 0);
  assert.equal(isTextlessEvent('job/registered'), true);
  assert.equal(isTextlessEvent('user/message'), false);
});

test('compaction/summary 能产出摘要', () => {
  const r = extract({
    type: 'compaction/summary',
    seq: 9,
    time: 90,
    data: { compactionId: 'c1', summary: [{ type: 'text', text: '## 要点\n- 甲\n- 乙' }] },
  });
  assert.ok(r.summary);
  assert.equal(r.summary.compactionId, 'c1');
  assert.equal(r.rows[0].kind, 'compaction-summary');
});

test('标题跳过纯符号、过短和乱码行', () => {
  assert.equal(firstLine('---\n###\n真正的标题'), '真正的标题');
  assert.equal(firstLine('好\n这句才是标题'), '这句才是标题');
  assert.equal(firstLine(''), '');
  assert.equal(looksGarbled('正常的一行中文'), false);
  assert.equal(looksGarbled('câ\u0001\u0002\u0003'), true);
});

test('能识别「注入的提示词」而不是用户真说的话', () => {
  // 这些在真实数据里会变成每轮的第一条 user/message，必须跳过，
  // 否则几十条摘要标题一模一样，检索结果无法区分。
  assert.equal(looksLikePrompt('［统一人设卡 · QQ 和 B站是同一个人］'), true);
  assert.equal(looksLikePrompt('--- 类型: 人格卡 编号: 1'), true);
  assert.equal(looksLikePrompt('你是一个群聊黑话学习器。'), true);
  assert.equal(looksLikePrompt('只回复四个字：链路正常。'), true);
  assert.equal(looksLikePrompt('【当前时间】2026/10/30 16:09:29'), true);
  assert.equal(looksLikePrompt('# 人格卡 1 · 大大的鱼'), true);

  assert.equal(looksLikePrompt('帮我看看这个报错'), false);
  assert.equal(looksLikePrompt('为什么推送失败了'), false);
  assert.equal(looksLikePrompt(''), false);

  // 英文注入块同样要跳过（DSH 的 runtime context 就是英文的）
  assert.equal(looksLikePrompt('Current runtime context. This snapshot supersedes earlier ones'), true);
  assert.equal(looksLikePrompt('You are an AI agent powered by DeepSeek Harness.'), true);
  assert.equal(looksLikePrompt('Tokens prefixed with @ are paths'), true);
});

test('能识别「注入的提示词」而不是用户真说的话', () => {
  // 这些在真实数据里都会成为每轮的第一条 user/message，必须跳过
  assert.equal(looksLikePrompt('［统一人设卡 · QQ 和 B站是同一个人］'), true);
  assert.equal(looksLikePrompt('--- 类型: 人格卡 编号: 1'), true);
  assert.equal(looksLikePrompt('你是一个群聊黑话学习器。'), true);
  assert.equal(looksLikePrompt('只回复四个字：链路正常。'), true);
  assert.equal(looksLikePrompt('【当前时间】2026/10/30 16:09:29'), true);
  assert.equal(looksLikePrompt('# 人格卡 1 · 大大的鱼'), true);

  // 用户真说的不该被判成提示词
  assert.equal(looksLikePrompt('帮我看看这个报错'), false);
  assert.equal(looksLikePrompt('为什么推送失败了'), false);
  assert.equal(looksLikePrompt(''), false);
});
