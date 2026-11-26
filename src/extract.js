/**
 * 把 DSH 会话事件记录抽取成可入库的行。
 *
 * 原则：**只丢掉没有可读文本的遥测事件**（stream 分块、job/registered、
 * llm/retry、delivery-accepted ……）。凡是带文本的记录一律保留，这样
 * 「无遗忘」在数据层是成立的；被丢掉的数量会单独计数，可审计。
 */

/** 事件里可能承载文本的字段（按类型走不同路径，这里只做兜底）。 */
function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content : [];
}

/**
 * @param {object} rec 一条 session.v4 记录
 * @returns {{
 *   session?: { id: string, cwd?: string, createdAt?: number },
 *   title?: string,
 *   rows: Array<{ kind: string, role: string|null, turn: number|null, seq: number|null, ts: number, text: string, meta: string|null }>,
 *   summary: { title: string, body: string, seqFrom: number|null, seqTo: number|null, compactionId: string|null } | null
 * }}
 */
export function extract(rec) {
  const out = { session: undefined, title: undefined, rows: [], summary: null };
  if (!rec || typeof rec !== 'object') return out;

  const type = rec.type;
  const data = rec.data ?? {};
  const ts = Number(rec.time ?? 0) || 0;
  const seq = Number.isFinite(rec.seq) ? Number(rec.seq) : null;
  const turn = Number.isFinite(data.turn) ? Number(data.turn) : null;

  const push = (kind, role, text, meta) => {
    const value = typeof text === 'string' ? text : '';
    if (!value.trim()) return;
    out.rows.push({
      kind,
      role,
      turn,
      seq,
      ts,
      text: value,
      meta: meta ? JSON.stringify(meta) : null,
    });
  };

  switch (type) {
    case 'session': {
      out.session = {
        id: rec.id,
        cwd: rec.cwd,
        createdAt: Number(rec.createdAt ?? 0) || 0,
      };
      break;
    }

    case 'user/message': {
      for (const b of blocksOf(data)) {
        if (b?.type === 'text') push('user', 'user', b.text);
      }
      break;
    }

    case 'assistant/message': {
      for (const b of blocksOf(data.message)) {
        if (b?.type === 'text') push('assistant', 'assistant', b.text);
        else if (b?.type === 'reasoning') push('reasoning', 'assistant', b.text);
        else if (b?.type === 'tool-call') {
          push('tool-call', 'assistant', b.arguments, { name: b.name, callId: b.id });
        }
      }
      break;
    }

    case 'tool/result': {
      const msg = data.message;
      const meta = { callId: msg?.toolCallId, isError: msg?.isError === true };
      for (const b of blocksOf(msg)) {
        if (b?.type === 'text') push('tool-result', 'tool', b.text, meta);
      }
      break;
    }

    case 'system/message': {
      for (const b of blocksOf(data.message)) {
        if (b?.type === 'text') push('system', 'system', b.text);
      }
      break;
    }

    case 'developer/message': {
      const list = blocksOf(data).length ? blocksOf(data) : blocksOf(data.message);
      for (const b of list) {
        if (b?.type === 'text') push('developer', 'developer', b.text);
      }
      break;
    }

    case 'compaction/summary': {
      const parts = [];
      for (const b of Array.isArray(data.summary) ? data.summary : []) {
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
      const body = parts.join('\n\n').trim();
      if (body) {
        push('compaction-summary', 'summary', body, { compactionId: data.compactionId });
        out.summary = {
          title: firstLine(body),
          body,
          seqFrom: seq,
          seqTo: seq,
          compactionId: data.compactionId ?? null,
        };
      }
      break;
    }

    case 'session/title': {
      if (typeof data.title === 'string' && data.title.trim()) {
        out.title = data.title.trim();
        push('title', null, out.title);
      }
      break;
    }

    default:
      // 遥测事件（step/start、job/*、llm/retry、stream ……）没有可读文本，跳过
      break;
  }

  return out;
}

/**
 * 取正文第一行合适的内容作标题。
 *
 * 会跳过：空行、只有 markdown 符号的行（`---`、`###`）、以及**乱码行**
 * （控制台输出在 GBK/UTF-8 之间转坏时会出现，例如 `câ` 这种）。
 *
 * @param {string} body
 * @param {number} [max=80]
 * @returns {string}
 */
export function firstLine(body, max = 80) {
  const lines = String(body ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (!line) continue;
    if (/^[-=*_~\s·—#]+$/.test(line)) continue;          // 纯符号
    if (line.length < 4) continue;                        // 太短（"好"、"---"）
    if (looksGarbled(line)) continue;                     // 乱码
    const text = line.replace(/\s+/g, ' ');
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return '';
}

/**
 * 粗判一段文本是不是「注入的提示词」而不是用户真说的话。
 *
 * 为什么需要：很多会话每轮的第一条 user/message 其实是注入的人设卡或系统指令
 * （`［统一人设卡 · …］`、`--- 类型: …`、`你是一个…`、`只回复…`、`【当前时间】…`）。
 * 拿它当标题会让几十条摘要看起来一模一样，检索结果也没法区分。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikePrompt(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  // XML 标签块（`<system-reminder>…`）也是框架注入，不是用户说的话
  if (s.startsWith('<')) return true;
  // 中文注入块
  if (/^(［|\[|---\s*类型|类型[:：]|#{1,2}\s*人格卡|你是一个|你是一|你是|只回复|请回复|请只|【当前时间】|统一人设卡)/.test(s)) {
    return true;
  }
  // 英文注入块（DSH 的 runtime context / 系统提示会以英文出现在第一条 user 里）
  return /^(Current runtime context|This snapshot supersedes|You are an?\b|Tokens prefixed|Available skills|Available tools|System prompt|# System|Working directory:|Session ID:|Approval prompts|Time sampled|system-reminder|The approval policy|A skill is a|Skills are loaded)/i
    .test(s);
}

/**
 * 粗判一行是否像乱码。
 * 正常中文/英文/数字/常见标点的字符占比应该很高。
 *
 * @param {string} line
 * @returns {boolean}
 */
export function looksGarbled(line) {
  const s = String(line);
  if (!s) return true;
  let bad = 0;
  for (const ch of s) {
    const ok = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\w\s.,:;!?'"()\[\]{}\-_/\\|@#$%^&*+=<>`~·—…“”‘’]/.test(ch);
    if (!ok) bad += 1;
  }
  return bad / s.length > 0.2;
}

/** 该事件类型是否属于「无文本遥测」。用于统计丢弃量。 */
export function isTextlessEvent(type) {
  return ![
    'session',
    'user/message',
    'assistant/message',
    'tool/result',
    'system/message',
    'developer/message',
    'compaction/summary',
    'session/title',
  ].includes(type);
}
