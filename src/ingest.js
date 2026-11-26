/**
 * 摄入层：发现会话、增量导入、生成摘要、消费 spool。
 *
 * 增量靠「字节水位」：`source_files.bytes_done`。会话文件是 append-only 的多帧
 * zstd，所以每次只解新帧；尾部写了一半的帧会解码失败，此时不推进水位。
 *
 * 摘要策略（v0.1，不使用 LLM）：
 *   · `compaction` —— 直接捡 DSH 自己压缩时写的高质量摘要
 *   · `turn`       —— 按「轮」把该轮文本拼成一条摘要（标题取首个用户消息首行）
 * 两类合起来构成粗召回层，覆盖全量原文，生成成本为零。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { decodeFrom, parseLines, frameOffsets } from './decode.js';
import { extract, firstLine, isTextlessEvent, looksLikePrompt } from './extract.js';
import { contentHash, insertSummary, indexSummaryTerms } from './indexer.js';
import { effectivePolicy, materializePolicy, upsertSession } from './policy.js';
import { tx, metaGet, metaSet } from './db.js';
import { seg as segment } from './ngram.js';
import { HOOK, emit } from './hooks.js';

/** 事件类型 → 配置开关名。未列出的类型一律不入库（无文本遥测）。 */
const KIND_FLAGS = {
  user: 'storeUser',
  assistant: 'storeAssistant',
  reasoning: 'storeReasoning',
  'tool-call': 'storeToolCall',
  'tool-result': 'storeToolResult',
  system: 'storeSystem',
  developer: 'storeDeveloper',
  'compaction-summary': 'storeCompactionSummary',
  title: 'always',
};

/**
 * 只解码第一个 frame，取 `session` 记录（发现阶段用，避免整文件解码）。
 * @param {string} file
 * @returns {object|null}
 */
export function peekFirstRecord(file) {
  try {
    const buf = readFileSync(file);
    const offsets = frameOffsets(buf);
    if (offsets.length === 0) return null;
    const end = offsets.length > 1 ? offsets[1] : buf.length;
    const text = zstdDecompressSync(buf.subarray(offsets[0], end)).toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 递归找出所有会话文件。
 * @param {string} root
 * @param {{ maxFiles?: number }} [opts]
 * @returns {Array<{ file: string, dir: string, size: number }>}
 */
export function findSessionFiles(root, opts = {}) {
  const { maxFiles = 20000 } = opts;
  /** @type {Array<{file:string,dir:string,size:number}>} */
  const out = [];

  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.jsonl.zstd')) {
        let size = 0;
        try {
          size = statSync(p).size;
        } catch {
          continue;
        }
        out.push({ file: p, dir, size });
      }
    }
  };

  walk(root);
  return out;
}

/**
 * 发现并登记所有会话（不解码全文）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot
 * @returns {{ discovered: number, created: number }}
 */
export function discoverSessions(db, sessionsRoot) {
  const files = findSessionFiles(sessionsRoot);
  let created = 0;
  for (const { file, dir } of files) {
    const rec = peekFirstRecord(file);
    if (!rec || rec.type !== 'session' || !rec.id) continue;
    const isNew = upsertSession(db, {
      id: rec.id,
      workspace: rec.cwd ?? null,
      workspaceLabel: rec.cwd ?? basename(dir),
      title: null,
      createdAt: rec.createdAt ?? null,
    });
    if (isNew) {
      materializePolicy(db, rec.id, rec.cwd ?? '');
      created += 1;
    }
  }
  return { discovered: files.length, created };
}

/** 某类事件是否入库。 */
function shouldStore(kind, cfg) {
  const flag = KIND_FLAGS[kind];
  if (flag === 'always') return true;
  if (!flag) return false;
  return cfg[flag] !== false;
}

/**
 * 导入一个会话文件（增量）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} file
 * @param {object} cfg
 */
export function importSessionFile(db, file, cfg) {
  const stats = {
    file,
    sessionId: null,
    newEvents: 0,
    newSummaries: 0,
    duplicates: 0,
    skippedByPolicy: 0,
    bytes: 0,
    truncated: false,
  };

  const prev = db.prepare('SELECT * FROM source_files WHERE path = ?').get(file);
  const bytesDone = prev?.bytes_done ?? 0;

  let decoded;
  try {
    decoded = decodeFrom(file, bytesDone);
  } catch {
    return stats; // 读不了就静默跳过，绝不打断对话
  }

  if (!decoded.text) {
    stats.truncated = decoded.truncated;
    return stats;
  }

  const records = parseLines(decoded.text);
  if (records.length === 0) {
    db.prepare(
      `INSERT INTO source_files(path, session_id, bytes_done, frames_done, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET bytes_done = excluded.bytes_done, updated_at = excluded.updated_at`,
    ).run(file, prev?.session_id ?? null, decoded.bytesDone, decoded.frames, Date.now());
    return stats;
  }

  // 确定 sessionId 与 workspace
  let sessionId = prev?.session_id ?? null;
  let workspace = '';
  for (const rec of records) {
    if (rec?.type === 'session' && rec.id) {
      sessionId = rec.id;
      workspace = rec.cwd ?? '';
      break;
    }
  }
  if (!sessionId) {
    const d = basename(dirname(file));
    sessionId = d.startsWith('session-') ? d : `unknown:${basename(file)}`;
  }
  stats.sessionId = sessionId;

  const texts = records.map((r) => extract(r));
  const textlessCount = records.filter((r) => isTextlessEvent(r?.type)).length;

  // 写入策略：store=0 时整批丢弃，但水位照常推进（避免下次重放）
  let policy = effectivePolicy(db, sessionId);
  if (!policy) policy = materializePolicy(db, sessionId, workspace);

  if (policy.store === 0) {
    let dropped = 0;
    for (const t of texts) dropped += t.rows.length;
    stats.skippedByPolicy = dropped;
    db.prepare(
      `INSERT INTO source_files(path, session_id, bytes_done, frames_done, records_seen, records_dropped, skipped_by_policy, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         session_id = excluded.session_id,
         bytes_done = excluded.bytes_done,
         frames_done = source_files.frames_done + excluded.frames_done,
         records_seen = source_files.records_seen + excluded.records_seen,
         records_dropped = source_files.records_dropped + excluded.records_dropped,
         skipped_by_policy = source_files.skipped_by_policy + excluded.skipped_by_policy,
         updated_at = excluded.updated_at`,
    ).run(
      file,
      sessionId,
      decoded.bytesDone,
      decoded.frames,
      records.length,
      textlessCount,
      dropped,
      Date.now(),
    );
    return stats;
  }

  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO events(session_id, workspace, seq, kind, role, turn, ts, text, meta, ukey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEventFts = db.prepare('INSERT INTO events_fts(rowid, seg) VALUES (?, ?)');
  const maxChars = Number(cfg.maxEventChars ?? 200000);
  const summaryMaxChars = Number(cfg.summaryMaxChars ?? 1200);
  // 只把前 N 个字符送进全文索引：超长工具输出全量建 bigram 索引会把库撑到
  // 上百 MB，而对「找一句话」帮助有限。原文本身仍然完整保存在 events 里。
  const ftsMaxChars = Number(cfg.ftsMaxChars ?? 20000);

  /** @type {Map<string, Array<object>>} */
  const byTurn = new Map();

  tx(db, () => {
    let i = 0;
    for (const t of texts) {
      if (t.title) {
        db.prepare("UPDATE sessions SET title = COALESCE(NULLIF(?, ''), title) WHERE id = ?").run(
          t.title.slice(0, 200),
          sessionId,
        );
      }

      for (const row of t.rows) {
        if (!shouldStore(row.kind, cfg)) continue;

        // 扩展点：入库前可脱敏 / 改写 / 丢弃（返回 false 或设置 payload.drop）
        const hooked = emit(HOOK.INGEST_BEFORE_INSERT, { row, sessionId, kind: row.kind });
        if (hooked?.drop) {
          stats.hookDropped = (stats.hookDropped ?? 0) + 1;
          continue;
        }

        const text = row.text.length > maxChars ? `${row.text.slice(0, maxChars)}\n…[已截断]` : row.text;
        const segStr = segment(text.length > ftsMaxChars ? text.slice(0, ftsMaxChars) : text);
        const ukey = `${sessionId}|${row.seq ?? 'x'}|${row.kind}|${i}`;
        const info = insEvent.run(
          sessionId,
          workspace || null,
          row.seq,
          row.kind,
          row.role,
          row.turn,
          row.ts,
          text,
          row.meta,
          ukey,
        );
        if (info.changes > 0) {
          insEventFts.run(Number(info.lastInsertRowid), segStr);
          stats.newEvents += 1;
        } else {
          stats.duplicates += 1;
        }

        const key = String(row.turn ?? 0);
        if (!byTurn.has(key)) byTurn.set(key, []);
        byTurn.get(key).push(row);
      }
      i += 1;
    }

    // 会话标题（DSH 自己生成的）作为摘要标题的次选
    let sessionTitle = '';
    try {
      sessionTitle = String(
        db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId)?.title ?? '',
      ).trim();
      if (looksLikePrompt(sessionTitle)) sessionTitle = '';
    } catch {
      sessionTitle = '';
    }

    // ── 按轮生成摘要（超长的一轮拆成多条，保证覆盖不漏）──────────────────
    //
    // 早先版本「一轮只出一条摘要、超长直接截断」，结果埋在工具返回里的细节
    // 完全进不了粗召回层（关键词层因此命中不到）。改为按字符预算切块：
    // 一轮拆成 N 条摘要，hash 带块序号，增量重放仍幂等。
    for (const [turnKey, rows] of byTurn) {
      // 「记忆层」只收人和助手的对话。
      //
      // 工具调用/结果仍然会进 events（归档层，能搜、展开时能看到），
      // 但**不参与摘要与关键词挖掘** —— 真实库里 tool-result 出现在 88% 的
      // 摘要里，把关键词榜和摘要正文全污染了。分层之后：
      //   · 记忆层（摘要/关键词）：只有 user / assistant
      //   · 归档层（events）：工具内容仍在，memory_search 与展开都可查
      //
      // 另外要挡掉「标成 user 的注入内容」：DSH 每轮把 runtime context、
      // 人设卡、system-reminder 也当作 user 消息写进日志，它们不是人说的话。
      // 不过滤的话关键词榜会出现 `interpret`、`preceding`、`preparing` 这种。
      const usable = rows.filter((r) => {
        if (r.kind !== 'user' && r.kind !== 'assistant') return false;
        if (r.kind === 'user' && looksLikePrompt(r.text)) return false;
        return true;
      });
      if (usable.length === 0) continue;

      // 标题优先级：用户真说的话 → 助手的回答 → 会话标题 → 轮次兜底。
      // 必须跳过「注入的提示词」（人设卡、系统指令），否则几十条摘要标题一模一样，
      // 检索结果也没法区分。这是真实数据上暴露出来的问题。
      const userTitle = rows
        .filter((r) => r.kind === 'user' && !looksLikePrompt(r.text))
        .map((r) => firstLine(r.text, 60))
        .find(Boolean);
      const assistantTitle = rows
        .filter((r) => r.kind === 'assistant')
        .map((r) => firstLine(r.text, 60))
        .find(Boolean);
      const baseTitle = userTitle
        || assistantTitle
        || sessionTitle
        || `第 ${turnKey} 轮 · 工具记录`;

      /** 当前块累积的状态 */
      let parts = [];
      let used = 0;
      let chunk = 0;
      let chunkRows = [];

      const flush = () => {
        let body = parts.join('\n').trim();
        if (!body) return;
        let title = chunk === 0 ? baseTitle : `${baseTitle}（续 ${chunk}）`;

        // 扩展点：摘要入库前可改写标题/正文（例如自己接 LLM 生成更自然的摘要），
        // 或设 payload.drop = true 丢弃这一条。
        const hooked = emit(HOOK.SUMMARY_BEFORE_INSERT, { sessionId, kind: 'turn', title, body });
        if (hooked?.drop) return;
        if (typeof hooked?.title === 'string' && hooked.title.trim()) title = hooked.title;
        if (typeof hooked?.body === 'string' && hooked.body.trim()) body = hooked.body;

        const seqs = chunkRows.map((r) => r.seq).filter((x) => Number.isFinite(x));
        const tsList = chunkRows.map((r) => r.ts).filter((x) => Number.isFinite(x) && x > 0);
        const id = insertSummary(db, {
          sessionId,
          workspace: workspace || undefined,
          kind: 'turn',
          title,
          body,
          periodFrom: tsList.length ? Math.min(...tsList) : null,
          periodTo: tsList.length ? Math.max(...tsList) : null,
          seqFrom: seqs.length ? Math.min(...seqs) : null,
          seqTo: seqs.length ? Math.max(...seqs) : null,
          hash: contentHash('turn', sessionId, turnKey, chunk),
        });
        if (id !== null) {
          indexSummaryTerms(db, id, body);
          stats.newSummaries += 1;
        }
      };

      for (const r of usable) {
        const label = r.kind === 'user' ? '用户' : r.kind === 'assistant' ? '助手' : r.kind;
        const piece = `[${label}] ${r.text}`;
        if (used > 0 && used + piece.length > summaryMaxChars) {
          flush();
          chunk += 1;
          parts = [];
          used = 0;
          chunkRows = [];
        }
        // 单条本身就超预算时，按预算截断（原文仍在 events 里，不丢）
        const clipped = piece.length > summaryMaxChars
          ? `${piece.slice(0, summaryMaxChars)}…`
          : piece;
        parts.push(clipped);
        used += clipped.length;
        chunkRows.push(r);
      }
      flush();
    }

    // ── compaction 摘要单独入（DSH 自己压缩上下文时写的高质量概要）──────────
    //
    // 受 `storeCompactionSummary` 控制：这个开关名字听起来只管「存不存事件」，
    // 但既然它是内容范围的一部分，关掉就该连摘要也不生成 ——
    // 否则用户关掉了它，压缩摘要还是照进库，配置语义对不上。
    if (shouldStore('compaction-summary', cfg)) {
      for (const t of texts) {
        if (!t.summary) continue;
        const id = insertSummary(db, {
          sessionId,
          workspace: workspace || undefined,
          kind: 'compaction',
          title: t.summary.title || '压缩摘要',
          body: t.summary.body,
          periodFrom: null,
          periodTo: null,
          seqFrom: t.summary.seqFrom,
          seqTo: t.summary.seqTo,
          hash: contentHash('comp', sessionId, t.summary.compactionId ?? t.summary.seqFrom ?? ''),
        });
        if (id !== null) {
          indexSummaryTerms(db, id, t.summary.body);
          stats.newSummaries += 1;
        }
      }
    }

    // ── 水位与会话计数 ────────────────────────────────────────────────────
    db.prepare(
      `INSERT INTO source_files(path, session_id, bytes_done, frames_done, records_seen, records_stored, records_dropped, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         session_id = excluded.session_id,
         bytes_done = excluded.bytes_done,
         frames_done = source_files.frames_done + excluded.frames_done,
         records_seen = source_files.records_seen + excluded.records_seen,
         records_stored = source_files.records_stored + excluded.records_stored,
         records_dropped = source_files.records_dropped + excluded.records_dropped,
         updated_at = excluded.updated_at`,
    ).run(
      file,
      sessionId,
      decoded.bytesDone,
      decoded.frames,
      records.length,
      stats.newEvents,
      textlessCount,
      Date.now(),
    );

    db.prepare('UPDATE sessions SET event_count = event_count + ?, last_seen_at = ? WHERE id = ?').run(
      stats.newEvents,
      Date.now(),
      sessionId,
    );
  });

  stats.bytes = decoded.bytesDone;
  stats.truncated = decoded.truncated;

  // 扩展点：一个会话文件导入完成后（只读统计对象）
  emit(HOOK.INGEST_AFTER_IMPORT, stats);

  return stats;
}

/**
 * 导入全部会话（增量）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot
 * @param {object} cfg
 * @param {(msg: string) => void} [log]
 */
export function importAllSessions(db, sessionsRoot, cfg, log = () => {}) {
  const files = findSessionFiles(sessionsRoot);
  const total = {
    files: files.length,
    newEvents: 0,
    newSummaries: 0,
    skippedByPolicy: 0,
    sessions: new Set(),
  };
  for (const { file } of files) {
    const s = importSessionFile(db, file, cfg);
    total.newEvents += s.newEvents;
    total.newSummaries += s.newSummaries;
    total.skippedByPolicy += s.skippedByPolicy;
    if (s.sessionId) total.sessions.add(s.sessionId);
  }
  log(`导入完成：${total.files} 个文件，新增 ${total.newEvents} 条事件、${total.newSummaries} 条摘要`);
  return { ...total, sessions: total.sessions.size };
}

/**
 * 消费 spool 投递箱。
 *
 * 协议见 docs/spool.md：每行一个 JSON，带 hash 保证幂等。
 * core 完全不知道数据来自哪个插件 —— 这是 QQ 侧解耦的全部秘密。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} inboxDir
 * @param {{ maxLines?: number }} [opts]
 */
export function consumeSpool(db, inboxDir, opts = {}) {
  const { maxLines = 2000 } = opts;
  const stats = { files: 0, lines: 0, stored: 0, duplicates: 0, bad: 0 };

  let entries;
  try {
    entries = readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return stats;
  }

  const insEvent = db.prepare(
    `INSERT OR IGNORE INTO events(session_id, workspace, seq, kind, role, turn, ts, text, meta, ukey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEventFts = db.prepare('INSERT INTO events_fts(rowid, seg) VALUES (?, ?)');

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = join(inboxDir, e.name);
    stats.files += 1;

    const metaKey = `spool:${e.name}`;
    const offset = Number(metaGet(db, metaKey, '0')) || 0;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size <= offset) continue;

    let chunk;
    try {
      chunk = readFileSync(file).subarray(offset, size).toString('utf8');
    } catch {
      continue;
    }

    // 只消费到最后一个换行，避免读到写了一半的行
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) continue;
    const usable = chunk.slice(0, lastNl + 1);
    const consumedTo = offset + Buffer.byteLength(usable, 'utf8');
    const lines = usable.split('\n').filter((l) => l.trim()).slice(0, maxLines);

    tx(db, () => {
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          stats.bad += 1;
          continue;
        }
        const text = String(rec.text ?? '').trim();
        if (!text) continue;

        const source = String(rec.source ?? 'spool');
        const channel = String(rec.channel ?? 'default');
        const ts = Number(rec.ts ?? 0) || Date.now();
        const hash = String(rec.hash ?? contentHash(source, channel, ts, text)).slice(0, 64);
        const sessionId = `${source}:${channel}`;
        const segStr = segment(text);

        const info = insEvent.run(
          sessionId,
          null,
          null,
          String(rec.kind ?? 'message'),
          rec.meta?.isOwner ? 'owner' : 'peer',
          null,
          ts,
          text,
          rec.meta ? JSON.stringify(rec.meta) : null,
          `spool:${hash}`,
        );
        if (info.changes > 0) {
          insEventFts.run(Number(info.lastInsertRowid), segStr);
          stats.stored += 1;
        } else {
          stats.duplicates += 1;
        }
        stats.lines += 1;
      }
      metaSet(db, metaKey, consumedTo);
    });
  }

  return stats;
}
