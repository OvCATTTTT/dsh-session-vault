# spool 投递协议

`dsh-session-vault` 的核心**不知道**任何外部聊天源的存在。它只做一件事：定期读取
`<dataDir>/inbox/*.jsonl`，把新行消费进记忆库。

所以「接入 QQ」「接入微信」「接入贴吧」都不是改 core，而是**写一个往 inbox 追加
JSON 行的东西**。这就是解耦的全部。

```
<dataDir>/
  dsh.db             DSH 会话记忆（core 自己采）
  qq.db              QQ 聊天记忆（spool 投递）
  inbox/
    qq.jsonl         ← 适配器写这里
    wechat.jsonl     ← 也可以有别的
```

## 一行一个 JSON

```json
{"v":1,"source":"surfcore-qq","channel":"private:10001","ts":1795309228944,"kind":"message","text":"在吗","meta":{"isOwner":true},"hash":"a3f9c2…"}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 消息正文。为空的行会被丢弃。 |
| `source` | 建议 | 来源标识，如 `surfcore-qq`。会拼进 session_id：`<source>:<channel>`。 |
| `channel` | 建议 | 会话标识，如 `private:10001`、`group:10002`。 |
| `ts` | 建议 | 毫秒时间戳。缺省用消费时刻。 |
| `kind` | 否 | 取值范围自定，默认 `message`。可作为过滤字段。 |
| `meta` | 否 | 任意 JSON，原样存进 `events.meta`。 |
| `hash` | 建议 | **幂等键**。同 hash 只入库一次。缺省用 `sha256(source|channel|ts|text)`。 |

## 三条硬约定

1. **只追加（append-only）。** 适配器只 `appendFile`，永远不改已有内容。
2. **消费水位。** core 按字节偏移记录消费到哪（存在 `meta` 表里，键 `spool:<文件名>`）。
3. **只消费完整行。** core 只读到最后一个 `\n`，写了一半的行留到下次。

满足这三条，即使任一侧崩溃重启，也不会丢消息、不会重复入库。

## 写入示例（Node）

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const inbox = 'D:/DSH/session-vault/inbox';
mkdirSync(inbox, { recursive: true });

function push({ source, channel, ts, kind = 'message', text, meta }) {
  if (!text?.trim()) return;
  const hash = createHash('sha256')
    .update(`${source}|${channel}|${ts}|${text}`)
    .digest('hex').slice(0, 32);
  const line = JSON.stringify({ v: 1, source, channel, ts, kind, text, meta, hash });
  appendFileSync(`${inbox}/${source}.jsonl`, `${line}\n`, 'utf8');
}

push({ source: 'my-chat', channel: 'group:123', ts: Date.now(), text: '你好' });
```

## 隐私

core 不做二次脱敏 —— **脱敏是投递方的责任**。如果你的数据源有隐私策略
（比如 surfcore 会剔除主人私聊、过滤私信文件），请在写入 spool 之前完成过滤。

`qq.db` 与 `dsh.db` 是分开的文件，清空或删除其中一个不影响另一个。
