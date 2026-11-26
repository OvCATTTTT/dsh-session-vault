import test from 'node:test';
import assert from 'node:assert/strict';
import { terms, seg, DEFAULT_STOPWORDS } from '../src/ngram.js';

test('中文切成 bigram，两字查询也能命中', () => {
  const t = terms('张三上周提过那个项目要延期');
  assert.ok(t.includes('项目'), '应包含「项目」');
  assert.ok(t.includes('延期'));
  assert.ok(!t.includes('张三上周提过那个项目要延期'), '不应保留整句');
});

test('两字词单独成 term', () => {
  assert.deepEqual(terms('火锅'), ['火锅']);
});

test('单字成串时保留单字', () => {
  assert.deepEqual(terms('火'), ['火']);
});

test('ASCII 词转小写且不切分', () => {
  const t = terms('SetNamedSecurityInfoW failed');
  assert.ok(t.includes('setnamedsecurityinfow'));
  assert.ok(t.includes('failed'));
});

test('技术符号保留在 ASCII 词里', () => {
  const t = terms('运行 bge-m3 和 ./x.mjs');
  assert.ok(t.includes('bge-m3'));
  // token 必须以字母开头，所以 `./x.mjs` 会被切成 `x.mjs`
  assert.ok(t.includes('x.mjs'));
});

test('停用词默认被过滤', () => {
  const t = terms('这个问题可以');
  assert.ok(DEFAULT_STOPWORDS.has('这个'));
  assert.ok(!t.includes('这个'));
  assert.ok(!t.includes('可以'));
});

test('keepStopwords=true 时保留', () => {
  const t = terms('这个', { keepStopwords: true });
  assert.ok(t.includes('这个'));
});

test('去重且保持首次出现顺序', () => {
  // "项目项目" 的 bigram 是 项目/目项/项目/目项，去重后剩两个
  assert.deepEqual(terms('项目项目'), ['项目', '目项']);
  assert.deepEqual(terms('ACL acl'), ['acl']);
});

test('空输入返回空数组', () => {
  assert.deepEqual(terms(''), []);
  assert.deepEqual(terms(null), []);
});

test('seg 用空格连接，可直接喂给 FTS5', () => {
  assert.equal(seg('项目延期'), '项目 目延 延期');
});

test('挖词时把复合标识符归一化，不能整条丢掉', () => {
  // 真实踩过的坑：一个聊 Obsidian 的会话里这个词有四种写法，
  // 早期规则只认裸词，把另外三种（带点/带下划线/在路径里）全扔了，
  // 结果 54 条摘要只有 19 条进词库，用户以为关键词里根本没有它。
  const got = terms(
    'obsidian_data 和 obsidian.md 还有 D:\\notes\\base1_test 以及 Obsidian',
    { mining: true },
  );
  assert.ok(got.includes('obsidian'), `应切出 obsidian，实际：${got.join(' ')}`);
  assert.equal(got.filter((t) => t === 'obsidian').length, 1, '去重后只留一个');
  // 路径段里的项目名也要留下
  assert.ok(got.includes('base1'), '路径最后一段应保留');
  // 但整条路径本身不能当词
  assert.ok(!got.some((t) => t.includes('\\')), '不应保留整条路径');
});

test('挖词时丢掉跨词边界的 bigram 碎片', () => {
  const got = terms('我自己的鱼的工 作区里的东西', { mining: true });
  for (const frag of ['的鱼', '鱼的', '的工', '里的']) {
    assert.ok(!got.includes(frag), `不该出现碎片「${frag}」`);
  }
});
