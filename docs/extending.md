# 扩展接口

`dsh-session-vault` 留了三个层次的扩展点，按"接入成本从低到高"排序。

## 一、投递箱（最低成本，不用写代码进核心）

任何外部数据源都可以往 `<dataDir>/inbox/<source>.jsonl` 追加 JSON 行，core 会自动
消费。协议见 [spool.md](spool.md)。

**适用**：接 QQ / 微信 / 贴吧 / 任何聊天记录；导入旧档案。

---

## 二、钩子（往流程里插入逻辑）

```js
import { on, HOOK } from 'dsh-session-vault/core';

const off = on(HOOK.INGEST_BEFORE_INSERT, (payload) => {
  payload.row.text = payload.row.text.replace(/138\d{8}/g, '[手机号]');
});

off(); // 取消注册
```

### 语义

- **同步执行**，在热路径里调用，处理器要快（建议 < 1 ms）
- 可以**原地修改** `payload` 的字段，改动立即生效
- 返回 `false` 表示「丢弃这一条」（会转成 `payload.drop = true`）
- **任何处理器抛错都只被记录然后跳过** —— 第三方钩子坏了不会影响检索和入库

### 全部钩子

| 常量 | 字符串值 | 何时触发 | 能改什么 |
|---|---|---|---|
| `HOOK.INGEST_BEFORE_INSERT` | `ingest:beforeInsert` | 每条事件入库前 | `payload.row.text`；`drop=true` 丢弃 |
| `HOOK.INGEST_AFTER_IMPORT` | `ingest:afterImport` | 一个会话文件导入完 | 只读统计对象 |
| `HOOK.SUMMARY_BEFORE_INSERT` | `summary:beforeInsert` | 每条摘要入库前 | `payload.title` / `payload.body`；`drop=true` 丢弃 |
| `HOOK.RECALL_BEFORE_QUERY` | `recall:beforeQuery` | 每次检索开始前 | `payload.query`（做同义扩展、纠错、脱敏） |
| `HOOK.RECALL_AFTER_GATE` | `recall:afterGate` | 检索出结果后 | `payload.hits`（增删/重排） |
| `HOOK.HINT_BEFORE_RENDER` | `hint:beforeRender` | 注入提示前 | `payload.text`（自定义提示措辞） |
| `HOOK.SWITCH_CHANGED` | `switch:changed` | 开关变化时 | 只读 |

拼错钩子名会**直接抛错**，不会静默失效。

### 典型用法

**入库脱敏**

```js
on(HOOK.INGEST_BEFORE_INSERT, ({ row }) => {
  row.text = row.text.replace(/\b1[3-9]\d{9}\b/g, '[手机号]');
});
```

**噪声过滤**（某些工具的输出不值得记）

```js
on(HOOK.INGEST_BEFORE_INSERT, ({ row }) => {
  if (row.kind === 'tool-result' && row.text.startsWith('Get-ChildItem')) return false;
});
```

**接 LLM 生成更自然的摘要**（异步时先缓存，钩子是同步的）

```js
const cache = new Map();
on(HOOK.SUMMARY_BEFORE_INSERT, ({ body }) => {
  const better = cache.get(body.slice(0, 80));
  if (better) return { body: better };
});
```

**同义扩展**（提升召回）

```js
on(HOOK.RECALL_BEFORE_QUERY, (p) => {
  if (p.query.includes('权限')) p.query += ' ACL 沙箱 拒绝写入';
});
```

---

## 三、排序器（改变结果顺序）

```js
import { registerRanker } from 'dsh-session-vault/core';

registerRanker(({ db, query, seedTerms, total }) => {
  // 返回 Map<summaryId, 加分>，加分叠加到 0~1 的分数上
  return new Map([[42, 0.2]]);
});
```

- 每次门控调用一次，**必须同步返回**
- 加分可以正也可以负（`score` 最终 clamp 在 0~1）
- 分数并列时**用加分做次级排序**，所以即使多条都是满分，排序器仍然能决定顺序
- 抛错会被忽略（当作没有这个排序器）

---

## 四、运行期开关

```js
// 关掉主动联想（不再每轮注入提示），立即生效、重启后保留
vault.setSwitch('autoHint', false);

vault.switchState('autoHint');   // { on: false, source: 'db' }
vault.clearSwitch('autoHint');   // 回到配置默认
```

优先级：**数据库里的显式设置 > 插件配置 > 内置默认值**。

对话里也可以直接说，模型会调 `memory_switch` 工具。

开关存在数据库的 `meta` 表（键 `flag:<name>`），所以**迁移数据目录时会一起走**。

新增开关只需在 `src/core.js` 的 `SWITCHES` 里加一行。

---

## 五、`SessionVault` 类（脱离 DSH 使用）

```js
import { SessionVault } from 'dsh-session-vault/core';

const v = new SessionVault({ dataDir: './mem', sessionsRoot: '~/.dsh/sessions' });
v.open();
v.scan();
v.recall('很久之前那件事');
v.expand(summaryId);
v.stats();
v.sessions();
v.setSession({ sessionId, storeMode: 'skip' });
v.migrate('./new-mem');
```

`src/core.js` 及其依赖**不 import 任何 `@deepseek-ai/*`**，所以可以在任何 Node ≥24
程序里用。

---

## 不要这样做

- **不要在钩子里做几次 SQL 查询** —— 它在每轮门控的同步路径上
- **不要依赖钩子执行顺序** —— 同一钩子的多个处理器顺序未定义
- **不要在钩子里改数据库 schema** —— 迁移逻辑不认外部改动
