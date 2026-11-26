/**
 * 数据目录自动探测（src/datadir.js）。
 *
 * 这些测试全用注入的假 exists/statfs，不碰真实磁盘 ——
 * 否则测试结果会取决于跑测试的机器有几个盘。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import {
  candidateDataDirs, pickDataDir, resolveDataDir,
  MIN_FREE_BYTES, EXTERNAL_DRIVES, VAULT_DIRNAME, VAULT_SUBDIR,
} from '../src/datadir.js';
import { normalizeConfig, defaults } from '../src/config.js';

const GB = 1024 ** 3;

/** 造一个「只有这些盘存在、各自剩多少」的假环境。 */
function fakeFs({ drives = {}, dshHome = 'C:\\Users\\x\\.dsh' } = {}) {
  return {
    dshHome,
    exists: (p) => {
      if (/^[A-Z]:\\$/.test(p)) return Object.hasOwn(drives, p[0]);
      return false;
    },
    statfs: (p) => {
      const d = p[0];
      if (!Object.hasOwn(drives, d)) throw new Error('ENOENT');
      const free = drives[d];
      if (free === 'throw') throw new Error('EACCES');
      return { bavail: Math.floor(free / 4096), bsize: 4096 };
    },
  };
}

test('候选列表：非系统盘在前，DSH_HOME 兜底且永远在最后', () => {
  const list = candidateDataDirs('C:\\Users\\x\\.dsh');
  assert.equal(list.at(-1).kind, 'home');
  assert.equal(list.at(-1).dir, join('C:\\Users\\x\\.dsh', VAULT_SUBDIR));
  // 系统盘 C 不在外部候选里
  for (const c of list.slice(0, -1)) {
    assert.notEqual(c.drive, 'C:');
    assert.equal(c.dir, `${c.drive}\\${VAULT_DIRNAME}\\${VAULT_SUBDIR}`);
  }
  assert.equal(list.length, EXTERNAL_DRIVES.length + 1);
});

test('D 盘够大 → 选 D 盘（这次的情况）', () => {
  const env = fakeFs({ drives: { C: 66 * GB, D: 71.5 * GB } });
  const r = pickDataDir(env.dshHome, env);
  assert.equal(r.kind, 'external');
  assert.equal(r.drive, 'D:');
  assert.equal(r.dir, 'D:\\DSH_vault\\session-vault');
  assert.ok(r.freeBytes > MIN_FREE_BYTES);
  assert.match(r.reason, /D:/);
});

test('D 盘空间不够 → 换 E 盘', () => {
  const env = fakeFs({ drives: { C: 66 * GB, D: 1 * GB, E: 50 * GB } });
  const r = pickDataDir(env.dshHome, env);
  assert.equal(r.drive, 'E:');
});

test('一个非系统盘都没有 → 回退 DSH_HOME', () => {
  const env = fakeFs({ drives: { C: 66 * GB } });
  const r = pickDataDir(env.dshHome, env);
  assert.equal(r.kind, 'home');
  assert.equal(r.dir, join('C:\\Users\\x\\.dsh', VAULT_SUBDIR));
  assert.match(r.reason, /没有可用的非系统盘/);
});

test('statfs 抛错（网络盘/权限）→ 跳过继续找', () => {
  const env = fakeFs({ drives: { C: 66 * GB, D: 'throw', E: 50 * GB } });
  const r = pickDataDir(env.dshHome, env);
  assert.equal(r.drive, 'E:', 'D 盘 statfs 失败要跳过，不能整个放弃');
});

test('所有外部盘都失败 → 回退，不抛', () => {
  const env = fakeFs({ drives: { C: 66 * GB, D: 'throw', E: 'throw', F: 'throw', G: 'throw' } });
  const r = pickDataDir(env.dshHome, env);
  assert.equal(r.kind, 'home');
  assert.ok(r.dir.length > 0);
});

test('minFree 可调：阈值放低后小盘也能选上', () => {
  const env = fakeFs({ drives: { C: 66 * GB, D: 1.5 * GB } });
  assert.equal(pickDataDir(env.dshHome, env).kind, 'home', '默认 2 GB 门槛下不够');
  const r = pickDataDir(env.dshHome, { ...env, minFree: 1 * GB });
  assert.equal(r.drive, 'D:', '门槛降到 1 GB 就该选 D');
});

test('结果永远是绝对路径，不会返回空', () => {
  for (const drives of [{}, { C: 66 * GB }, { D: 0 }]) {
    const r = pickDataDir('C:\\h', fakeFs({ drives }));
    assert.ok(typeof r.dir === 'string' && r.dir.length > 0);
    assert.match(r.dir, /^[A-Z]:\\/, `应当是绝对路径，实际 ${r.dir}`);
  }
});

// ── 解析优先级（含 0.4.10 那个真实 bug 的回归）──────────────────────────

const NO_PICK = (home) => ({ dir: `${home}\\session-vault`, reason: '假探测：回退' });

test('显式配置最高优先，压过指针和探测', () => {
  const r = resolveDataDir({
    dshHome: 'C:\\h',
    rawDataDir: 'E:\\mine\\vault',
    pointer: 'D:\\DSH_vault\\session-vault',
    pick: NO_PICK,
  });
  assert.equal(r.dir, 'E:\\mine\\vault');
  assert.equal(r.source, 'config');
});

test('没填配置 → 用位置指针，不重新探测', () => {
  const r = resolveDataDir({
    dshHome: 'C:\\h',
    rawDataDir: '',
    pointer: 'D:\\DSH_vault\\session-vault',
    pick: NO_PICK,
  });
  assert.equal(r.dir, 'D:\\DSH_vault\\session-vault');
  assert.equal(r.source, 'pointer');
});

test('配置和指针都空 → 才去探测', () => {
  let called = 0;
  const r = resolveDataDir({
    dshHome: 'C:\\h',
    rawDataDir: '',
    pointer: null,
    pick: (home) => { called += 1; return { dir: `${home}\\auto`, reason: '假探测' }; },
  });
  assert.equal(r.source, 'auto');
  assert.equal(r.dir, 'C:\\h\\auto');
  assert.equal(called, 1);
});

test('空白字符串当没填（不会被当成路径）', () => {
  for (const blank of ['', '   ', '\t\n', null, undefined]) {
    const r = resolveDataDir({
      dshHome: 'C:\\h', rawDataDir: blank, pointer: 'D:\\p', pick: NO_PICK,
    });
    assert.equal(r.dir, 'D:\\p', `rawDataDir=${JSON.stringify(blank)} 应视为未指定`);
  }
});

// ★ 这条是整个 bug 的回归锁：
// normalizeConfig 会把 defaults() 的 dataDir（C 盘）填进 cfg，
// 早期版本拿 cfg.dataDir 判断，就永远走"用户指定了"分支，指针被无视。
test('回归：defaults 填进 cfg 的 dataDir 绝不能盖掉位置指针', () => {
  const env = { dshHome: 'C:\\Users\\x\\.dsh' };

  // 先确认前提成立：defaults 确实填了一个非空的 C 盘路径
  const base = defaults(env);
  assert.ok(base.dataDir, 'defaults() 不该返回空 dataDir（这是设计如此，所以才危险）');
  assert.match(base.dataDir, /^C:\\/, 'defaults 应该指向 DSH_HOME');

  const cfg = normalizeConfig({}, env);
  assert.ok(cfg.dataDir, 'normalizeConfig 后 cfg.dataDir 必非空 —— 这正是坑所在');

  // 正确做法：看 rawDataDir（用户原样填的 = 空），而不是 cfg.dataDir
  const r = resolveDataDir({
    dshHome: env.dshHome,
    rawDataDir: '', // 用户什么都没填
    pointer: 'D:\\DSH_vault\\session-vault',
    pick: NO_PICK,
  });
  assert.equal(r.source, 'pointer', '没填配置时必须走指针，不能被 defaults 的 C 盘顶掉');
  assert.equal(r.dir, 'D:\\DSH_vault\\session-vault');

  // 反证：如果错看 cfg.dataDir，就会得到 C 盘
  assert.notEqual(r.dir, cfg.dataDir, '这正是用户遇到的症状：重启后还在 C 盘');
});
