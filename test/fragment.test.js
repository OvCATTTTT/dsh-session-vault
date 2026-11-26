/**
 * 过程性碎片的判定规则。
 *
 * 背景：一轮对话里助手先说「现在开始应用补丁：」，再调工具、最后给结论。
 * 工具调用会切出新的 turn，于是那句 14 字的预告被单独生成一条摘要，
 * 而且能被检索到 —— 纯噪声。
 *
 * 规则刻意保守，因为踩过两次误伤的坑：
 *   1. `[用户] 你可以检索到记忆库这个项目吗`（19 字）—— 真实提问，不能过滤
 *   2. 没有角色标签的裸文本 —— 判断不了角色，必须保留
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isProceduralFragment } from '../src/extract.js';

test('过程预告语：短 + 助手 + 冒号结尾 → 判碎片', () => {
  assert.equal(isProceduralFragment('[助手] 现在开始应用补丁：'), true);
  assert.equal(isProceduralFragment('[助手] 现在把分段压缩接进加工流程：'), true);
  assert.equal(isProceduralFragment('[助手] 接下来我要看一下索引结构：'), true);
  assert.equal(isProceduralFragment('[助手] 让我先确认一下宿主 API：'), true);
});

test('极短的助手消息 → 判碎片', () => {
  assert.equal(isProceduralFragment('[助手] 在的在的～测试收到'), true);
  assert.equal(isProceduralFragment('[助手] 改好了。'), true);
});

test('有用户发言的一律保留（踩过误伤的坑）', () => {
  // 这条只有 19 字，但它是真实提问
  assert.equal(isProceduralFragment('[用户] 你可以检索到记忆库这个项目吗'), false);
  assert.equal(isProceduralFragment('[用户] 新增一条要做的，将之前的东西整理进版本描述'), false);
  // 用户 + 助手混合也保留
  assert.equal(isProceduralFragment('[用户] 好\n[助手] 现在开始改：'), false);
});

test('没有角色标签的裸文本 → 保留（判断不了角色）', () => {
  assert.equal(isProceduralFragment('客服 系统 延期 方案'), false);
  assert.equal(isProceduralFragment('这是一条老数据，没有角色前缀'), false);
});

test('长且有实质内容的助手消息 → 保留', () => {
  const long = `[助手] 删了：D:\\DSH\\whale-memory\\1-人格特征\\_备份\\（9 个文件）。${'还剩一个旧版目录要确认。'.repeat(12)}`;
  assert.ok(long.length > 120);
  assert.equal(isProceduralFragment(long), false);
});

test('空内容 → 判碎片', () => {
  assert.equal(isProceduralFragment(''), true);
  assert.equal(isProceduralFragment('   '), true);
  assert.equal(isProceduralFragment(null), true);
  assert.equal(isProceduralFragment(undefined), true);
});

test('超过 120 字的预告语不判碎片（信息量够，宁留勿删）', () => {
  const body = `[助手] 现在开始应用补丁：${'这一步要改三个文件，分别是索引、检索和路由。'.repeat(10)}`;
  assert.ok(body.replace(/\[助手\]/g, '').trim().length > 120);
  assert.equal(isProceduralFragment(body), false);
});
