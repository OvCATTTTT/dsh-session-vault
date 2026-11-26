# session-vault-bridge —— surfcore 侧适配扩展

把 surfcore 记忆卡的全量归档投递给 [dsh-session-vault](../../README.md)。

**这是一个可选扩展。** 没装 surfcore 的人不需要它；装了 surfcore 的人也可以选择不开。

## 为什么是扩展而不是内置

| | 内置进 dsh-session-vault | 做成扩展（本方案） |
|---|---|---|
| 没装 surfcore 的用户 | 被迫带一个用不到的依赖 | 完全不知道它存在 |
| 开关 | 得在 session-vault 里加判断 | surfcore 自己的扩展页，默认关 |
| 坏掉的影响面 | 拖累整个记忆库 | 只影响 QQ 侧投递 |

## 安装

1. 把整个 `session-vault-bridge/` 目录拷到 `~/.dsh/surfcore/extensions/session-vault-bridge/`
2. 打开 surfcore 设置窗口 →「扩展」页 → 找到「记忆库投递」→ 打开
3. 确认 `dsh-session-vault` 已装且数据目录一致

## 数据怎么走

```
surfcore memory-card-full.jsonl
        │  本扩展按字节偏移增量读取
        │  归一化成 spool 行（带 hash）
        ▼
<session-vault>/inbox/qq.jsonl          ← append-only
        │  dsh-session-vault 按自己的水位消费
        ▼
<session-vault>/qq.db                   ← 与 dsh.db 完全分开
```

`qq.db` 和 `dsh.db` 是两个文件，删一个不影响另一个。

## 数据目录

本扩展默认投递到 `<HOME>/.dsh/session-vault/inbox/`。如果 dsh-session-vault 配了别的
`dataDir`，有三种方式告诉本扩展：

1. surfcore 扩展配置里设 `session-vaultDataDir`
2. 环境变量 `SESSION_VAULT_DATA_DIR`
3. 直接改 `resolveInbox()` 里的默认值

## 路由（诊断用）

| 路由 | 作用 |
|---|---|
| `GET /dsh-surfcore/ext/session-vault-bridge/status` | 看源文件路径、偏移、已投递条数 |
| `POST /dsh-surfcore/ext/session-vault-bridge/flush` | 立即增量投递一次 |

## 已知限制

- **字段名靠归一化兜底。** surfcore 记忆记录的字段名可能随版本变化，`normalizeRecord()`
  会依次尝试 `text / content / body / summary / note` 等。如果某个版本都对不上，
  投递会是 0 条 —— 用 `status` 路由确认。
- **只投递已脱敏内容。** 本扩展不做二次脱敏，也不读取任何私信文件；隐私策略由
  surfcore 维护。
- **不做删除同步。** 记忆卡里的条目被压缩掉的，在投递箱里仍然保留（这是刻意的：
  dsh-session-vault 的定位是"无遗忘归档"）。
