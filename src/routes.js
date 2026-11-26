/**
 * 设置页的 HTTP 路由（宿主侧）。
 *
 * 界面是 `lib/client.js` 里的 React 组件（按官方 practice：插件 UI 必须是
 * 插槽里的 React 组件，**不要**用 iframe 嵌 HTML 页面 —— 那样拿不到宿主的
 * 主题 token 和 ctx.locale）。
 *
 * 这里只负责数据和鉴权。安全模型逐条都必要：
 *   · 只接受本机回环（remoteAddress 是 127.0.0.1/::1）
 *   · 写操作要求 `content-type: application/json`（挡住表单跨站提交）
 *   · 写操作校验 Origin 同源（浏览器会带，非浏览器不带则放行）
 *   · 交给 `connection.requestRejection` 再拦一次（DSH 自己的策略）
 *   · 前端传来的策略值必须校验后才写库
 *
 * 没有 webServer 服务时返回 `{ registered: 0 }`，插件本体照常工作。
 */

import { json, readBody, isLoopback, sameOrigin, rejectByConnection } from './http.js';
import {
  groupSessions, sessionSummary, overviewPayload, parsePolicyChange,
} from './ui-data.js';

export const API_PREFIX = '/dsh-session-vault/api';

/** 调试用：开发服务器自己提供 dev/ui.html，这里不再对外暴露页面。 */

/**
 * @param {object} ctx cordis 上下文
 * @param {{ getVault: () => object|null, getConfig: () => object, log: Function, getLastScan: () => object|null }} deps
 * @returns {{ registered: number, reason?: string }}
 */
export function registerRoutes(ctx, deps) {
  const { getVault, getConfig, log, getLastScan } = deps;

  let webServer = null;
  try {
    webServer = ctx.webServer ?? ctx.get?.('webServer') ?? null;
  } catch {
    webServer = null;
  }
  if (!webServer || typeof webServer.register !== 'function') {
    return { registered: 0, reason: 'no-webServer' };
  }

  const disposers = [];
  let bootAt = Date.now();

  /**
   * 注册一条路由，并套上统一的安全检查。
   * @param {'exact'|'prefix'} kind
   * @param {string} path
   * @param {(req: any, res: any) => Promise<void>|void} handler
   */
  function route(kind, path, handler) {
    try {
      disposers.push(webServer.register({
        kind,
        path,
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: '只接受本机回环访问' });
          if (req.method !== 'GET') {
            if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '跨站请求被拒绝' });
            const ct = String(req.headers?.['content-type'] ?? '').toLowerCase();
            if (!ct.includes('application/json')) {
              return json(res, 415, { ok: false, error: '写操作必须是 application/json' });
            }
          }
          try {
            const code = rejectByConnection(ctx, req);
            if (code !== undefined && code !== null && code !== false) {
              res.statusCode = typeof code === 'number' ? code : 403;
              res.end();
              return;
            }
            await handler(req, res);
          } catch (error) {
            log(`设置页 API 失败：${String(error)}`, 'warn');
            try {
              json(res, 500, { ok: false, error: String(error?.message ?? error) });
            } catch {
              // 响应已经发出去就忽略
            }
          }
        },
      }));
      return true;
    } catch (error) {
      log(`路由注册失败 ${path}：${String(error)}`, 'warn');
      return false;
    }
  }

  /** 取库，没有就返回 503。 */
  const requireVault = (res) => {
    const v = getVault();
    if (!v) {
      json(res, 503, { ok: false, error: '记忆库未就绪（插件已禁用或初始化失败）' });
      return null;
    }
    return v;
  };

  // ── 概览 ────────────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/overview`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const cfg = getConfig();
    const payload = overviewPayload(
      vault.stats(),
      vault.allSwitches(cfg),
      { lastScan: getLastScan(), bootAt, scanProgress: vault.scanProgress ?? null },
    );
    return json(res, 200, { ok: true, data: payload });
  });

  // ── 会话列表（按工作区分组）─────────────────────────────────────────────
  route('exact', `${API_PREFIX}/sessions`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const { rows, workspaceRows, allTags } = vault.sessionTree();
    const groups = groupSessions(rows, workspaceRows);
    return json(res, 200, {
      ok: true,
      data: { groups, summary: sessionSummary(groups), allTags: allTags ?? [] },
    });
  });

  // ── 改策略（会话级 / 工作区级）───────────────────────────────────────────
  route('exact', `${API_PREFIX}/policy`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;

    const parsed = parsePolicyChange(JSON.parse((await readBody(req)) || '{}'));
    if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });

    try {
      const resolved = parsed.kind === 'workspace'
        ? vault.setWorkspace(parsed.args)
        : vault.setSession(parsed.args);
      return json(res, 200, { ok: true, data: { resolved } });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 会话内容（挑选置顶来源用）───────────────────────────────────────────
  route('exact', `${API_PREFIX}/messages`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    if (!sessionId) return json(res, 400, { ok: false, error: '缺少 sessionId' });
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 300));
    // kinds=user,assistant 只看对话（挑置顶内容时，工具输出太吵）
    const kindsParam = String(url.searchParams.get('kinds') ?? '').trim();
    const kinds = kindsParam
      ? kindsParam.split(',').map((k) => k.trim()).filter((k) => /^[a-z-]{1,24}$/.test(k))
      : [];
    const db = vault.open();
    // 正文给到 1200 字：列表里能直接看出是哪段，不用再去别处找
    let sql = `SELECT seq, kind, role, turn, ts, SUBSTR(text, 1, 1200) AS text
       FROM events WHERE session_id = ? AND text <> ''`;
    const args = [sessionId];
    if (kinds.length) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      args.push(...kinds);
    }
    sql += ' ORDER BY seq LIMIT ?';
    args.push(limit);
    const rows = db.prepare(sql).all(...args);
    return json(res, 200, { ok: true, data: { rows, limit, kinds } });
  });

  // ── 摘要列表（挑选置顶来源用）───────────────────────────────────────────
  route('exact', `${API_PREFIX}/summaries`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    if (!sessionId) return json(res, 400, { ok: false, error: '缺少 sessionId' });
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
    const db = vault.open();
    const rows = db.prepare(
      `SELECT id, kind, title, seq_from, seq_to, period_from, period_to, LENGTH(body) AS chars,
              SUBSTR(body, 1, 600) AS body
       FROM summaries WHERE session_id = ? ORDER BY id LIMIT ?`,
    ).all(sessionId, limit);
    return json(res, 200, { ok: true, data: { rows, limit } });
  });

  // ── 联想记录 ────────────────────────────────────────────────────────────
  // 每条用户消息都会留一行：当时的查询、命中哪几条摘要、最终注入几条、耗时。
  // 这是"联想到底有没有生效"的可查证据（注入内容本身只进系统提示，界面看不到）。
  route('exact', `${API_PREFIX}/recalls`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    const onlyInjected = url.searchParams.get('onlyInjected') === '1';
    const rows = vault.recalls({ sessionId, limit, onlyInjected }).map((r) => {
      // hits 存的是 JSON：[{id, score}, …]（命中的摘要 id 和分数）
      let hits = [];
      try {
        const parsed = JSON.parse(r.hits ?? '[]');
        if (Array.isArray(parsed)) hits = parsed;
      } catch {
        // 旧数据或脏数据当空
      }
      return {
        id: r.id,
        sessionId: r.session_id,
        sessionTitle: r.session_title ?? '',
        ts: r.ts,
        trigger: r.trigger,
        query: r.query,
        hits,
        injected: r.injected,
        elapsedMs: r.elapsed_ms,
      };
    });

    // 给命中的摘要补上「标题」和「属于哪个会话」。
    // 光给 #5000 这种内部 id 用户看不懂 —— 他要的是"它想到了什么"。
    const ids = new Set();
    for (const r of rows) {
      for (const h of r.hits) {
        const n = Number(h?.id);
        if (Number.isFinite(n) && n > 0) ids.add(n);
      }
    }
    if (ids.size) {
      const infoById = new Map();
      try {
        const db = vault.open();
        const list = [...ids].slice(0, 2000);
        const ph = list.map(() => '?').join(',');
        const found = db.prepare(
          `SELECT s.id, s.title, s.session_id, se.title AS session_title
             FROM summaries s
             LEFT JOIN sessions se ON se.id = s.session_id
            WHERE s.id IN (${ph})`,
        ).all(...list);
        for (const f of found) {
          infoById.set(Number(f.id), {
            title: f.title ?? '',
            sessionTitle: f.session_title ?? '',
            sessionId: f.session_id ?? '',
          });
        }
      } catch {
        // 查不到标题就退回显示 id，不影响页面
      }
      for (const r of rows) {
        r.hits = r.hits.map((h) => {
          const info = infoById.get(Number(h?.id));
          return {
            id: h?.id,
            score: h?.score,
            title: info?.title ?? '',
            sessionTitle: info?.sessionTitle ?? '',
          };
        });
      }
    }

    return json(res, 200, {
      ok: true, data: { rows, limit, sessionId },
    });
  });

  // ── surfcore 记忆卡（只读）──────────────────────────────────────────────
  // 这里所有接口都只读 surfcore 的文件、只写自己的库。没有一个会改 surfcore。

  route('exact', `${API_PREFIX}/surfcore`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      return json(res, 200, { ok: true, data: vault.surfcoreOverview() });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  route('exact', `${API_PREFIX}/surfcore/records`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const q = String(url.searchParams.get('q') ?? '').slice(0, 200);
    const kind = String(url.searchParams.get('kind') ?? '').slice(0, 40);
    const inCard = String(url.searchParams.get('inCard') ?? '');
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 60));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    try {
      return json(res, 200, {
        ok: true, data: vault.surfcoreRecords({ q, kind, inCard, limit, offset }),
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  route('exact', `${API_PREFIX}/surfcore/forgotten`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 60));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    try {
      return json(res, 200, { ok: true, data: vault.surfcoreForgotten({ limit, offset }) });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 切换入库方式：live（现读文件）/ mirror（落库）
  route('exact', `${API_PREFIX}/surfcore/mode`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    try {
      return json(res, 200, { ok: true, data: vault.setSurfcoreMode(body.mode) });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  route('exact', `${API_PREFIX}/surfcore/sync`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      return json(res, 200, { ok: true, data: vault.surfcoreSync() });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  route('exact', `${API_PREFIX}/surfcore/clear`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      return json(res, 200, { ok: true, data: vault.surfcoreClear() });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  route('exact', `${API_PREFIX}/tags`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    return json(res, 200, {
      ok: true,
      data: {
        tags: vault.allTags(),
        sessionTags: sessionId ? vault.tagsOf(sessionId) : [],
      },
    });
  });

  route('exact', `${API_PREFIX}/tag`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const sessionId = String(body.sessionId ?? '').slice(0, 200);
    const tag = String(body.tag ?? '').trim();
    if (!sessionId || !tag) return json(res, 400, { ok: false, error: '缺少 sessionId 或 tag' });
    try {
      const next = body.remove ? vault.removeTag(sessionId, tag) : vault.addTag(sessionId, tag);
      return json(res, 200, { ok: true, data: { sessionTags: next, tags: vault.allTags() } });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 置顶 ────────────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/pins`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    return json(res, 200, {
      ok: true,
      data: {
        pins: vault.pins({ sessionId }).map((p) => ({
          id: p.id,
          sessionId: p.session_id,
          source: p.source,
          summaryId: p.summary_id,
          seqFrom: p.seq_from,
          seqTo: p.seq_to,
          title: p.title,
          note: p.note,
          mode: p.mode,
          orderNo: p.order_no,
          followRead: p.follow_read === 1,
          chars: String(p.body ?? '').length,
          createdAt: p.created_at,
        })),
      },
    });
  });

  route('exact', `${API_PREFIX}/pin`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    try {
      if (body.action === 'delete') {
        return json(res, 200, { ok: true, data: { removed: vault.removePin(Number(body.id)) } });
      }
      if (body.action === 'update') {
        return json(res, 200, { ok: true, data: { pin: vault.patchPin(Number(body.id), body.patch ?? {}) } });
      }
      // 默认新增
      const id = vault.addPin({
        sessionId: body.sessionId,
        source: body.source,
        summaryId: body.summaryId ?? null,
        seqFrom: body.seqFrom ?? null,
        seqTo: body.seqTo ?? null,
        title: body.title,
        note: body.note ?? null,
        body: body.body,
        mode: body.mode ?? 'onMatch',
        orderNo: body.orderNo ?? 0,
        followRead: body.followRead ?? 1,
      });
      return json(res, 200, { ok: true, data: { id } });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 按当前内容范围重建 ──────────────────────────────────────────────────
  // 改了「保存哪些内容」之后，老摘要不会自动按新规则重算，需要清空重导。
  //
  // 这是**破坏性**操作：purgeContent 会清空 events/summaries 并把水位归零，
  // 然后严格按当前策略重导。实测把某个工作区设成 skip 之后重建，
  // 那个工作区的 6100 条事件会直接消失（源日志还在，只是策略不让入库）。
  // 所以这里做两件事保护用户：先自动备份，再把结果里的差值报出来。
  route('exact', `${API_PREFIX}/purge`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const preview = vault.previewPurge();
      // 备份失败不阻塞重建（比如磁盘满），但要如实告诉用户
      let backup = null;
      let backupError = null;
      try {
        backup = vault.backupDb();
      } catch (error) {
        backupError = String(error?.message ?? error);
      }

      const r = vault.purgeContent();
      const scanned = await vault.scanAsync();

      // 内容重新入库之后再跑词发现、再用带词的索引重建一遍。
      // 顺序不能反：词发现要读 summaries.body，必须先扫完。
      let words = null;
      let wordsError = null;
      try {
        words = await vault.discoverWordsAsync();
      } catch (error) {
        wordsError = String(error?.message ?? error);
      }
      let index = null;
      if (words && !words.skipped) {
        const cfg = getConfig();
        index = vault.rebuildIndex({
          minDf: Number(cfg.termMinDf ?? 2),
          maxCount: Number(cfg.termMaxCount ?? 0),
          minEdgeHits: Number(cfg.minEdgeHits ?? 2),
        });
      }

      const after = vault.previewPurge();
      return json(res, 200, {
        ok: true,
        data: {
          purged: r,
          scanned,
          backup,
          backupError,
          words,
          wordsError,
          index,
          preview,
          after: after.current,
        },
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 预演：按当前策略重建会剩多少（不执行任何写操作）────────────────────
  route('exact', `${API_PREFIX}/purge-preview`, async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
      return json(res, 405, { ok: false, error: '只支持 GET / POST' });
    }
    const vault = requireVault(res);
    if (!vault) return;
    try {
      return json(res, 200, { ok: true, data: vault.previewPurge() });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 词表：查看 / 重新发现 ───────────────────────────────────────────────
  route('exact', `${API_PREFIX}/words`, async (req, res) => {
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const rows = vault
        .open()
        .prepare('SELECT word, freq, pmi, entropy FROM mined_words ORDER BY freq DESC LIMIT 500')
        .all();
      return json(res, 200, { ok: true, data: { ...vault.wordStats(), rows } });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 重新发现词表。只清点词表本身，**不动** events / summaries；
  // 但词表一变索引就得重建（否则新词没进倒排），所以顺手重建索引。
  route('exact', `${API_PREFIX}/words/discover`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const words = await vault.discoverWordsAsync();
      let index = null;
      if (!words.skipped) {
        const cfg = getConfig();
        index = vault.rebuildIndex({
          minDf: Number(cfg.termMinDf ?? 2),
          maxCount: Number(cfg.termMaxCount ?? 0),
          minEdgeHits: Number(cfg.minEdgeHits ?? 2),
        });
      }
      return json(res, 200, { ok: true, data: { words, index } });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 运维：备份 ──────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/backup`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      return json(res, 200, { ok: true, data: vault.backupDb() });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 运维：重建索引 ──────────────────────────────────────────────────────
  // ── 一键全关（不存 / 不读）──────────────────────────────────────────────
  // 清掉会话级与工作区级的历史显式设置，回到"全都不存不读"，让用户重新一个个打开。
  // 只改策略，不删数据。
  route('exact', `${API_PREFIX}/policy-reset`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const r = vault.resetPolicies();
      return json(res, 200, { ok: true, data: r });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 立即扫描（异步逐文件让出，避免卡住宿主）────────────────────────────
  route('exact', `${API_PREFIX}/scan`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const r = await vault.scanAsync();
      return json(res, 200, { ok: true, data: r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 开关 ────────────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/switch`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    const body = JSON.parse((await readBody(req)) || '{}');
    const name = String(body.name ?? '');
    if (!name) return json(res, 400, { ok: false, error: '需要 name' });
    try {
      if (body.clear === true) {
        const st = vault.clearSwitch(name);
        return json(res, 200, { ok: true, data: st });
      }
      if (typeof body.on !== 'boolean') {
        return json(res, 400, { ok: false, error: '需要 on=true/false 或 clear=true' });
      }
      const st = vault.setSwitch(name, body.on);
      return json(res, 200, { ok: true, data: st });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 关键词库 ────────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/terms`, async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只支持 GET' });
    const vault = requireVault(res);
    if (!vault) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const q = String(url.searchParams.get('q') ?? '').slice(0, 100);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
    // script=cjk 只看中文词，script=ascii 只看英文/标识符词
    const rawScript = String(url.searchParams.get('script') ?? 'all');
    const script = ['cjk', 'ascii'].includes(rawScript) ? rawScript : 'all';
    // sessionId：只统计这个会话里的词频（全库榜对"某个会话在聊什么"没有意义）
    const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 200);
    // kind：word=只列词发现判出来的真词（默认），gram=只列 2 字碎片，all=全都要。
    // 有词表时默认只给真词，因为 bigram 榜一半是跨词边界碎片，没法读。
    const rawKind = String(url.searchParams.get('kind') ?? 'word');
    const kind = ['word', 'gram', 'all'].includes(rawKind) ? rawKind : 'word';
    // len：按词长筛（2/3/4 字）。0 或缺失 = 不筛
    const wordLen = Math.max(0, Math.min(8, Number(url.searchParams.get('len')) || 0));
    const rows = vault.termsPage({
      q, limit, includeMuted: true, script, sessionId, kind, wordLen,
    });
    return json(res, 200, {
      ok: true, data: {
        rows, q, limit, script, sessionId, kind, wordLen,
        words: vault.wordStats(),
      },
    });
  });

  route('exact', `${API_PREFIX}/term`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;

    const body = JSON.parse((await readBody(req)) || '{}');
    const term = String(body.term ?? '').slice(0, 200);
    if (!term) return json(res, 400, { ok: false, error: '需要 term' });

    const patch = {};
    if (typeof body.muted === 'boolean') patch.muted = body.muted;
    if (body.pinned !== undefined) {
      const p = Number(body.pinned);
      if (!Number.isFinite(p)) return json(res, 400, { ok: false, error: 'pinned 必须是数字（-1 表示清除）' });
      patch.pinned = p < 0 ? null : Math.max(0, Math.min(1000, p));
    }
    if (Object.keys(patch).length === 0) {
      return json(res, 400, { ok: false, error: '需要 muted 或 pinned' });
    }

    const found = vault.patchTerm(term, patch);
    if (!found) return json(res, 404, { ok: false, error: `关键词库里没有「${term}」` });
    return json(res, 200, { ok: true, data: { term, patch } });
  });

  // ── 运维：重建索引 ──────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/rebuild`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    const cfg = getConfig();
    try {
      const r = vault.rebuildIndex({
        minDf: Number(cfg.termMinDf ?? 2),
        maxCount: Number(cfg.termMaxCount ?? 0),
        minEdgeHits: Number(cfg.minEdgeHits ?? 2),
      });
      return json(res, 200, { ok: true, data: r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 运维：导出 ──────────────────────────────────────────────────────────
  route('exact', `${API_PREFIX}/export`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;
    try {
      const r = vault.exportData({});
      return json(res, 200, { ok: true, data: r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 运维：迁移数据目录 ──────────────────────────────────────────────────
  //
  // 危险操作：必须显式 confirm=true。迁移成功后库里已经在用新目录，
  // 但**配置里的 dataDir 不会自动改** —— 这一点要在返回值和 UI 上都说清楚。
  route('exact', `${API_PREFIX}/migrate`, async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' });
    const vault = requireVault(res);
    if (!vault) return;

    const body = JSON.parse((await readBody(req)) || '{}');
    if (body.confirm !== true) {
      return json(res, 400, { ok: false, error: '需要 confirm=true（这个操作会搬动整个数据目录）' });
    }
    const to = String(body.to ?? '').trim();
    if (!to || to.length > 400) return json(res, 400, { ok: false, error: '需要目标路径 to' });
    if (to === vault.dataDir) return json(res, 400, { ok: false, error: '目标与当前目录相同' });

    try {
      const report = vault.migrate(to, { deleteOld: body.deleteOld === true });
      if (!report.ok) return json(res, 400, { ok: false, error: report.reason, data: report });
      return json(res, 200, {
        ok: true,
        data: {
          ...report,
          dataDir: vault.dataDir,
          needsConfigUpdate: true,
          note: '配置里的 dataDir 需要同步改成新路径才会持久生效；否则下次启动会回到旧目录。',
        },
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 供 index.js 在插件事务里统一释放
  const dispose = () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d();
      } catch {
        // 忽略
      }
    }
    disposers.length = 0;
  };

  return { registered: disposers.length, dispose, bootAt };
}
