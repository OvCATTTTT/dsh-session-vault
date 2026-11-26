import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { SessionVault } from '../src/core.js';

/**
 * 造一个合成的 DSH 会话文件（多帧 zstd，一行一帧 —— 和真实格式一致）。
 *
 * @param {string} root sessions 根目录
 * @param {string} id 会话 id
 * @param {number} turns 轮数
 * @param {object} [opts]
 */
function writeSession(root, id, turns, opts = {}) {
  const { cwd = 'D:\\ws', title = `会话 ${id}` } = opts;
  const now = Date.now();
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, cwd, createdAt: now }),
    JSON.stringify({ type: 'session/title', seq: 1, time: now, data: { title } }),
  ];
  let seq = 2;
  for (let t = 1; t <= turns; t += 1) {
    lines.push(JSON.stringify({
      type: 'user/message',
      seq: (seq += 1),
      time: now + t,
      data: { content: [{ type: 'text', text: `第${t}轮：用户说项目延期了，要看看方案` }] },
    }));
    lines.push(JSON.stringify({
      type: 'assistant/message',
      seq: (seq += 1),
      time: now + t,
      data: { turn: t, message: { content: [{ type: 'text', text: `第${t}轮回答：先把延期原因写下来` }] } },
    }));
    lines.push(JSON.stringify({ type: 'step/start', seq: (seq += 1), time: now + t, data: { turn: t, step: 1 } }));
  }

  const file = join(root, `session-${id}`, 'session.v4.jsonl.zstd');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`, 'utf8')))));
  return file;
}

function makeWorld(sessionCount = 20, turns = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-scan-'));
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < sessionCount; i += 1) writeSession(sessions, `s${i}`, turns);
  const vault = new SessionVault({ dataDir: join(dir, 'db'), sessionsRoot: sessions });
  // 产品默认是「不存 / 不读」（见 src/policy.js）。这些测试关心的是导入流程本身，
  // 所以显式把全局默认打开，等价于用户自己把所有会话的「存」都开了。
  // 「默认确实关着」这件事由 core.test.js 单独断言。
  vault.open();
  vault.setGlobal({ defaultStore: 'store', defaultRead: 'all' });
  return {
    dir,
    sessions,
    vault,
    cleanup: () => {
      try { vault.close(); } catch { /* 忽略 */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('scanAsync 逐文件上报进度，结束后状态归零', async () => {
  const w = makeWorld(6, 2);
  try {
    const progress = [];
    const r = await w.vault.scanAsync({ onProgress: (p) => progress.push({ ...p }) });

    assert.equal(r.files, 6);
    assert.equal(progress.length, 6, '每个文件回调一次');
    assert.equal(progress[0].done, 1);
    assert.equal(progress[5].done, 6);
    assert.equal(progress[0].total, 6);
    assert.ok(progress[5].newEvents >= 6, '累计事件数应递增');
    assert.equal(progress[5].phase, 'import');

    assert.equal(w.vault.scanProgress.running, false);
    assert.equal(w.vault.scanProgress.phase, 'done');
    assert.equal(w.vault.scanning, false);
  } finally {
    w.cleanup();
  }
});

test('scanAsync 期间事件循环仍在转（这是它存在的理由）', async () => {
  const w = makeWorld(20, 3);
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      await w.vault.scanAsync();
    } finally {
      clearInterval(timer);
    }
    // 同步版 scan() 期间定时器一次都不会触发；异步版必须能 tick
    assert.ok(ticks > 0, `扫描期间事件循环应仍在转，实际 ticks=${ticks}`);
  } finally {
    w.cleanup();
  }
});

test('scanAsync 是增量且幂等的：第二次新增 0', async () => {
  const w = makeWorld(4, 2);
  try {
    const a = await w.vault.scanAsync();
    assert.ok(a.newEvents > 0);
    assert.ok(a.newSummaries > 0);

    const b = await w.vault.scanAsync();
    assert.equal(b.newEvents, 0, '第二次不应重复入库');
    assert.equal(b.newSummaries, 0);

    const stats = w.vault.stats();
    assert.equal(stats.events, a.newEvents);
  } finally {
    w.cleanup();
  }
});

test('scanAsync 并发调用不会重复导入（共用同一个 Promise）', async () => {
  const w = makeWorld(8, 2);
  try {
    const [a, b] = await Promise.all([w.vault.scanAsync(), w.vault.scanAsync()]);
    assert.equal(a, b, '并发调用应拿到同一个结果对象');

    const again = await w.vault.scanAsync();
    assert.equal(again.newEvents, 0, '并发跑完后库应已是最新');
  } finally {
    w.cleanup();
  }
});

test('scanAsync 支持 shouldStop 提前停止', async () => {
  const w = makeWorld(10, 1);
  try {
    let seen = 0;
    const r = await w.vault.scanAsync({
      onProgress: () => { seen += 1; },
      shouldStop: () => seen >= 3,
    });
    assert.equal(seen, 3, '应在第 3 个文件后停下');
    assert.equal(r.files, 10, '报告的仍是总文件数');
    assert.ok(r.newEvents > 0);
  } finally {
    w.cleanup();
  }
});

test('scanAsync 尊重 store=skip：整批丢弃但水位推进', async () => {
  const w = makeWorld(3, 2);
  try {
    await w.vault.scanAsync();
    const before = w.vault.stats();
    assert.ok(before.events > 0);

    // 把**全局默认**改成不存 —— 这样新会话会继承 skip
    w.vault.setGlobal({ defaultStore: 'skip' });
    writeSession(w.sessions, 'skipped', 2);

    const r = await w.vault.scanAsync();
    const after = w.vault.stats();

    assert.equal(after.events, before.events, 'store=skip 的会话不应入库');
    assert.ok(r.skippedByPolicy > 0, '应报告被策略跳过的条数');

    // 水位推进了：再扫不会重复计入
    const again = await w.vault.scanAsync();
    assert.equal(again.skippedByPolicy, 0, '水位推进后不应重复跳过同一批');
  } finally {
    w.cleanup();
  }
});

test('scanAsync 在没有会话目录时安全返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-vault-empty-'));
  try {
    const v = new SessionVault({ dataDir: join(dir, 'db'), sessionsRoot: join(dir, 'nope') });
    const r = await v.scanAsync();
    assert.equal(r.files, 0);
    assert.equal(r.newEvents, 0);
    assert.equal(v.scanProgress.running, false);
    v.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反复开关 store 不会重复入库（5 轮来回切）', async () => {
  const w = makeWorld(4, 2);
  try {
    await w.vault.scanAsync();
    const base = w.vault.stats();
    assert.ok(base.events > 0);

    const ids = w.vault.sessions().map((s) => s.id);
    for (let round = 0; round < 5; round += 1) {
      const mode = round % 2 === 0 ? 'skip' : 'store';
      for (const id of ids) w.vault.setSession({ sessionId: id, storeMode: mode });
      await w.vault.scanAsync();
    }

    // 最后一次是 store（round 4 → even → skip）… 无论停在哪一边，计数都不能变
    const after = w.vault.stats();
    assert.equal(after.events, base.events, '事件数不能变');
    assert.equal(after.summaries, base.summaries, '摘要数不能变');
    assert.equal(after.terms, base.terms, '关键词数不能变（df 不能被重复累加）');
    assert.equal(after.edges, base.edges, '共现边不能变（hits 不能被重复累加）');
  } finally {
    w.cleanup();
  }
});

test('反复开关 read 完全不影响数据（只影响检索范围）', async () => {
  const w = makeWorld(3, 2);
  try {
    await w.vault.scanAsync();
    const base = w.vault.stats();
    const ids = w.vault.sessions().map((s) => s.id);

    for (let round = 0; round < 4; round += 1) {
      const mode = ['off', 'own', 'all', 'inherit'][round];
      for (const id of ids) w.vault.setSession({ sessionId: id, readMode: mode });
      await w.vault.scanAsync();
    }

    const after = w.vault.stats();
    assert.equal(after.events, base.events);
    assert.equal(after.summaries, base.summaries);
    assert.equal(after.terms, base.terms);
    assert.equal(after.edges, base.edges);

    // read=off 时确实读不到
    const id0 = ids[0];
    w.vault.setSession({ sessionId: id0, readMode: 'off' });
    assert.equal(w.vault.policyOf(id0).readScope, 'off');
    const blocked = w.vault.recall('项目延期', { sessionId: id0, readScope: 'off', log: false });
    assert.deepEqual(blocked.hits, []);
  } finally {
    w.cleanup();
  }
});

test('连续扫描 10 次不会累加（幂等性压力测试）', async () => {
  const w = makeWorld(3, 2);
  try {
    await w.vault.scanAsync();
    const base = w.vault.stats();

    for (let i = 0; i < 10; i += 1) await w.vault.scanAsync();

    const after = w.vault.stats();
    assert.equal(after.events, base.events);
    assert.equal(after.summaries, base.summaries);
    assert.equal(after.terms, base.terms);
    assert.equal(after.edges, base.edges);
  } finally {
    w.cleanup();
  }
});

test('已知语义：skip 期间的记录，事后改成 store 不会补录', async () => {
  const w = makeWorld(1, 1);
  try {
    // 先设全局 skip，把这一轮"跳过"
    w.vault.setGlobal({ defaultStore: 'skip' });
    const skipRun = await w.vault.scanAsync();
    assert.equal(skipRun.newEvents, 0);
    assert.ok(skipRun.skippedByPolicy > 0, '应记录被跳过');
    assert.equal(w.vault.stats().events, 0);

    // 事后改成 store 再扫：水位已经推进，不会回头补
    w.vault.setGlobal({ defaultStore: 'store' });
    const after = await w.vault.scanAsync();
    assert.equal(after.newEvents, 0, '水位已推进，不补录');
    assert.equal(w.vault.stats().events, 0, '这是当前设计的已知行为');
  } finally {
    w.cleanup();
  }
});

test('追加新内容后：只导入新增部分，不重复旧内容', async () => {
  const w = makeWorld(2, 1);
  try {
    const first = await w.vault.scanAsync();
    const base = w.vault.stats();
    assert.ok(first.newEvents > 0);

    // 往已有的会话文件里追加一轮
    const file = join(w.sessions, 'session-s0', 'session.v4.jsonl.zstd');
    const now = Date.now();
    const extra = [
      { type: 'user/message', seq: 900, time: now, data: { content: [{ type: 'text', text: '追问：那延期到什么时候' }] } },
      { type: 'assistant/message', seq: 901, time: now, data: { turn: 99, message: { content: [{ type: 'text', text: '回答：下个月底' }] } } },
    ];
    const old = readFileSync(file);
    writeFileSync(file, Buffer.concat([
      old,
      ...extra.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8'))),
    ]));

    const second = await w.vault.scanAsync();
    assert.equal(second.newEvents, 2, '只应导入新增的 2 条');
    assert.ok(second.newSummaries >= 1);

    const after = w.vault.stats();
    assert.equal(after.events, base.events + 2);
  } finally {
    w.cleanup();
  }
});

test('一次性提示：取过就没了，不会每轮重复', () => {
  const w = makeWorld(1, 1);
  try {
    assert.equal(w.vault.peekNotice(), '');
    w.vault.setNotice('首次导入完成');
    assert.equal(w.vault.peekNotice(), '首次导入完成');
    assert.equal(w.vault.takeNotice(), '首次导入完成');
    assert.equal(w.vault.takeNotice(), '', '第二次应为空');
    w.vault.setNotice('   ');
    assert.equal(w.vault.peekNotice(), '', '空白提示应被忽略');
  } finally {
    w.cleanup();
  }
});

test('首次使用：空库 + 已有会话 → 自动导入并生成摘要', async () => {
  const w = makeWorld(5, 3);
  try {
    // 模拟「刚装好插件、库是空的」
    assert.equal(w.vault.stats().events, 0);
    const r = await w.vault.scanAsync();

    assert.ok(r.newEvents >= 15, `应导入全部事件，实际 ${r.newEvents}`);
    assert.ok(r.newSummaries >= 15, `应生成摘要，实际 ${r.newSummaries}`);

    const stats = w.vault.stats();
    assert.ok(stats.sessions >= 5);
    assert.ok(stats.activeTerms > 0, '应建立关键词库');
    assert.ok(stats.edges > 0, '应建立共现边');

    // 导入完立刻能检索
    // 默认不读，这里显式指定作用域（工具层会按会话策略传入）
    const hit = w.vault.recall('项目延期 方案', { limit: 3, log: false, readScope: 'all' });
    assert.ok(hit.hits.length > 0, '导入后应能检索到内容');
  } finally {
    w.cleanup();
  }
});
