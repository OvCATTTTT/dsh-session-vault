/**
 * 工具注册：给模型用的 memory_* 工具。
 *
 * 所有工具都受「读取范围（read_scope）」约束：
 *   off  → 直接拒绝
 *   own  → 强制把查询限定在当前会话
 *   all  → 全库
 * 这样「这个会话不读记忆」就不只是 UI 上的开关，而是运行时硬约束。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** 从 exec 上下文里尽力取当前会话 id（宿主字段名可能变，做多路兜底）。 */
export function sessionIdFromExec(exec) {
  const agent = exec?.agent ?? exec;
  const cand = agent?.session?.id
    ?? agent?.sessionId
    ?? agent?.session?.sessionId
    ?? agent?.id
    ?? null;
  return cand ? String(cand) : null;
}

const text = (s) => [{ type: 'text', text: s }];

/**
 * 注册全部工具。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} deps
 * @param {() => import('./core.js').SessionVault | null} deps.getVault
 * @param {() => object} deps.getConfig
 * @param {(level: string, msg: string) => void} [deps.log]
 */
export function registerTools(ctx, deps) {
  const { getVault, getConfig } = deps;

  const needVault = () => {
    const v = getVault();
    if (!v) throw new Error('session-vault: 记忆库未就绪（初始化失败或已被禁用）');
    return v;
  };

  /** 解析当前会话的读取范围；返回 null 表示允许全库。 */
  const scopeOf = (vault, sessionId) => {
    if (!sessionId) return { readScope: 'off', policy: null }; // 默认不读
    const policy = vault.policyOf(sessionId);
    return { readScope: policy?.readScope ?? 'off', policy }; // 默认不读
  };

  // ── 召回（关键词 → 摘要）──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description:
      '检索长期记忆库里的历史对话摘要（不是当前会话）。当用户提到过去发生的事、'
      + '或你不确定上下文时使用。返回带 #id 的摘要条目，再用 memory_open 展开原文。',
    parameters: {
      query: { type: 'string', required: true, description: '要查的内容，用用户原话即可。' },
      limit: { type: 'integer', description: '最多返回几条，默认取配置值（3）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blocked: { type: 'boolean' },
          summary: { type: 'string' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => text(value.summary ?? ''),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vault = needVault();
      const cfg = getConfig();
      const sessionId = sessionIdFromExec(exec);
      const { readScope, policy } = scopeOf(vault, sessionId);

      if (readScope === 'off') {
        return { blocked: true, hits: [], summary: '本会话未开启记忆读取（read_scope = off）。' };
      }

      const result = vault.recall(String(args.query ?? ''), {
        sessionId,
        readScope,
        // 按标签读时把标签列表传下去，否则 core 展不出会话白名单、等于读全库
        readTags: policy?.readTags ?? [],
        limit: Number(args.limit) > 0 ? Number(args.limit) : cfg.hintMaxItems,
        trigger: 'tool',
      });

      if (result.hits.length === 0) {
        const fallback = result.fallbackEvents ?? [];
        if (fallback.length === 0) {
          return { blocked: false, hits: [], summary: '记忆库里没有找到相关记录。' };
        }
        const lines = fallback.map(
          (e, i) => `${i + 1}. [${e.kind}] ${new Date(e.ts || 0).toISOString().slice(0, 10)} · event#${e.id}\n   ${String(e.text).slice(0, 160)}`,
        );
        return {
          blocked: false,
          hits: fallback,
          summary: `关键词层未命中，原文全文检索到 ${fallback.length} 条：\n${lines.join('\n')}`,
        };
      }

      return { blocked: false, hits: result.hits, summary: result.text };
    },
    presentCall: (args) => ({ card: 'generic', title: `召回记忆：${String(args.query).slice(0, 40)}`, kind: 'other', rawInput: args }),
  }));

  // ── 展开原文 ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_open',
    description: '展开某条记忆摘要（memory_recall 返回的 #id）所覆盖的**原文全文**。',
    parameters: {
      summary_id: { type: 'integer', required: true, description: 'memory_recall 返回的 #id。' },
      max_chars: { type: 'integer', description: '最多返回多少字符，默认 40000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          header: { type: 'string' },
          body: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      render: (_a, v) => text(v.found ? `${v.header}\n\n${v.body}` : '没有这条摘要。'),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vault = needVault();
      const sessionId = sessionIdFromExec(exec);
      const { readScope } = scopeOf(vault, sessionId);
      if (readScope === 'off') return { found: false, header: '', body: '本会话未开启记忆读取。', count: 0 };

      const { summary, events } = vault.expand(Number(args.summary_id), {
        maxChars: Number(args.max_chars) > 0 ? Number(args.max_chars) : 40000,
      });
      if (!summary) return { found: false, header: '', body: '', count: 0 };
      if (readScope === 'own' && summary.session_id !== sessionId) {
        return { found: false, header: '', body: '该条记忆属于其他会话，本会话读取范围限制为自身。', count: 0 };
      }

      const header = `#${summary.id} ${summary.title} · ${summary.kind} · 共 ${events.length} 条原文`;
      const body = events
        .map((e) => {
          const when = e.ts ? new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19) : '';
          const role = e.role ?? e.kind;
          return `── [${role}] ${when} seq=${e.seq ?? '-'} ──\n${e.text}`;
        })
        .join('\n\n');
      return { found: true, header, body, count: events.length };
    },
  }));

  // ── 原文全文检索（兜底）────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: '绕开关键词层，直接在全部原文里做中文全文检索。用于找具体某句话。',
    parameters: {
      query: { type: 'string', required: true, description: '要精确找的词句。' },
      limit: { type: 'integer', description: '最多返回几条，默认 5。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string' }, hits: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vault = needVault();
      const sessionId = sessionIdFromExec(exec);
      const { readScope } = scopeOf(vault, sessionId);
      if (readScope === 'off') return { hits: [], summary: '本会话未开启记忆读取。' };

      const rows = vault.search(String(args.query ?? ''), {
        limit: Number(args.limit) > 0 ? Number(args.limit) : 5,
        sessionId: readScope === 'own' ? sessionId : null,
      });
      if (rows.length === 0) return { hits: [], summary: '没有匹配的原文。' };
      const summary = rows
        .map((r, i) => `${i + 1}. [${r.kind}] ${new Date(r.ts || 0).toISOString().slice(0, 10)} · event#${r.id}\n   ${String(r.text).slice(0, 300)}`)
        .join('\n');
      return { hits: rows, summary };
    },
  }));

  // ── 统计 ───────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: '查看记忆库的规模与状态（会话数、事件数、摘要数、关键词数、体积）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const vault = needVault();
      const s = vault.stats();
      const mb = (s.sizeBytes / 1048576).toFixed(1);
      const summary = [
        `数据目录：${s.dataDir}（${mb} MB）`,
        `会话 ${s.sessions} · 事件 ${s.events} · 摘要 ${s.summaries}（其中压缩摘要 ${s.compactionSummaries}）`,
        `关键词 ${s.activeTerms}/${s.terms} · 共现边 ${s.edges}`,
        `累计召回 ${s.recalls} 次`,
      ].join('\n');
      return { summary };
    },
  }));

  // ── 会话与策略 ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_sessions',
    description: '列出记忆库已知的会话及其「是否入库 / 读取范围」策略。',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少条，默认 50。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const vault = needVault();
      const rows = vault.sessions(Number(args.limit) > 0 ? Number(args.limit) : 50);
      if (rows.length === 0) return { summary: '还没有任何会话记录。' };
      const summary = rows
        .map((r) => `· ${r.id.slice(0, 22)} 存=${r.eff_store ? '是' : '否'} 读=${r.eff_read} 事件=${r.event_count} 「${r.title ?? ''}」`)
        .join('\n');
      return { summary };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_policy',
    description:
      '设置某个会话的「写入（store）」与「读取（read）」策略。两者独立：'
      + 'store=skip 表示不记录该会话；read=off/own/all 表示读取范围（关/仅本会话/全库）。'
      + '不传 session_id 时作用于当前会话。',
    parameters: {
      session_id: { type: 'string', description: '目标会话 id；省略则用当前会话。' },
      store: { type: 'string', description: 'store | skip | inherit' },
      read: { type: 'string', description: 'off | own | all | inherit' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const vault = needVault();
      const sessionId = String(args.session_id ?? sessionIdFromExec(exec) ?? '');
      if (!sessionId) return { summary: '无法确定会话 id，请显式传 session_id。' };
      const resolved = vault.setSession({
        sessionId,
        storeMode: args.store,
        readMode: args.read,
      });
      return { summary: `已更新 ${sessionId}：生效 存=${resolved.store ? '是' : '否'}，读=${resolved.readScope}（来自 ${resolved.from}）` };
    },
  }));

  // ── 关键词库 ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_terms',
    description: '查看自动构建的关键词库（按连接度排序）。',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少条，默认 40。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const vault = needVault();
      const rows = vault.terms(Number(args.limit) > 0 ? Number(args.limit) : 40);
      if (rows.length === 0) return { summary: '关键词库还是空的，先跑一次扫描。' };
      return {
        summary: rows
          .map((r) => `· ${r.term} df=${r.df} 连接=${r.degree}${r.muted ? ' [已屏蔽]' : ''}${r.pinned != null ? ` [pin=${r.pinned}]` : ''}`)
          .join('\n'),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_term',
    description: '调整单个关键词：屏蔽噪声词，或手动加权。',
    parameters: {
      term: { type: 'string', required: true, description: '关键词原文。' },
      muted: { type: 'boolean', description: 'true=屏蔽（不参与联想）。' },
      pinned: { type: 'number', description: '手动权重；传 -1 表示清除。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const vault = needVault();
      const patch = {};
      if (typeof args.muted === 'boolean') patch.muted = args.muted;
      if (args.pinned !== undefined) {
        const p = Number(args.pinned);
        patch.pinned = p < 0 ? null : p;
      }
      const ok = vault.patchTerm(String(args.term ?? ''), patch);
      return { summary: ok ? `已更新关键词「${args.term}」` : `关键词库里没有「${args.term}」` };
    },
  }));

  // ── 运行期开关（主动联想等）────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_switch',
    description:
      '开关记忆库的某项功能。改完**立即生效**，并且持久化（重启后保留）。'
      + '不带参数调用会列出全部开关及其当前状态。'
      + 'autoHint = 主动联想：每轮自动检测相关记忆并注入提示；关掉后不会再自动打扰，'
      + '但你仍可以用 memory_recall 手动查。',
    parameters: {
      name: { type: 'string', description: '开关名，例如 autoHint。省略则只列出状态。' },
      on: { type: 'boolean', description: 'true = 打开，false = 关闭。' },
      clear: { type: 'boolean', description: 'true = 清除显式设置，回到配置里的默认值。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const vault = needVault();
      const cfg = getConfig();

      // 只列状态
      if (!args.name) {
        const list = vault.allSwitches(cfg);
        const summary = list
          .map((s) => `· ${s.name} = ${s.on ? '开' : '关'}（来源：${s.source}）— ${s.label}`)
          .join('\n');
        return { summary: `当前开关：\n${summary}` };
      }

      if (args.clear === true) {
        const st = vault.clearSwitch(String(args.name));
        return { summary: `${st.name} 已恢复默认：${st.on ? '开' : '关'}（来源：${st.source}）` };
      }

      if (typeof args.on !== 'boolean') {
        return { summary: '需要传 on=true/false，或 clear=true 恢复默认。' };
      }

      const st = vault.setSwitch(String(args.name), args.on);
      return { summary: `${st.name} 已${st.on ? '打开' : '关闭'}，立即生效并已持久化。` };
    },
  }));

  // ── 扫描 / 迁移 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_scan',
    description: '立即增量扫描会话目录并入库（平时由插件自动定时扫描）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => false,
    async execute() {
      const vault = needVault();
      // 用异步版：逐文件让出事件循环，避免把宿主卡住
      const r = await vault.scanAsync();
      return {
        summary: `扫描完成：${r.files} 个文件，新增 ${r.newEvents} 条事件、${r.newSummaries} 条摘要`
          + `${r.skippedByPolicy ? `，按策略跳过 ${r.skippedByPolicy} 条` : ''}（${r.ms} ms）`,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_migrate',
    description:
      '把记忆库数据目录移到新路径（复制 → 校验 → 切换，失败自动回滚）。'
      + '必须传 confirm=true 才会执行。',
    parameters: {
      to: { type: 'string', required: true, description: '新的数据目录绝对路径。' },
      confirm: { type: 'boolean', required: true, description: '必须是 true。' },
      delete_old: { type: 'boolean', description: '校验通过后是否删除旧目录，默认 false。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const vault = needVault();
      if (args.confirm !== true) return { summary: '未执行：需要 confirm=true。' };
      const report = vault.migrate(String(args.to ?? ''), { deleteOld: args.delete_old === true });
      if (!report.ok) return { summary: `迁移失败（已回滚到原目录）：${report.reason}` };
      return {
        summary: `迁移完成 → ${args.to}\n文件：${(report.copied ?? []).join(', ')}`
          + `${report.deletedOld ? '\n旧目录已删除' : '\n旧目录保留（确认无误后可手动删除）'}`
          + '\n注意：配置里的 dataDir 需要同步改成新路径才会持久生效。',
      };
    },
  }));

  // ── 置顶 ─────────────────────────────────────────────────────────────────
  //
  // 创建/排序在设置页做；工具只负责两件事：
  //   · 列出有哪些置顶（让模型知道可以去读）
  //   · 按 id 读完整内容（manual 模式的唯一入口，平时零 token 成本）
  ctx.tools.register(defineTool({
    name: 'memory_pin_list',
    description: '列出置顶记忆（用户手动钉住的内容）。默认只列当前会话的。',
    parameters: {
      all: { type: 'boolean', description: 'true = 列出全部会话的置顶' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vault = needVault();
      const sessionId = sessionIdFromExec(exec);
      const { readScope } = scopeOf(vault, sessionId);
      if (!args?.all && readScope === 'off') return { summary: '本会话未开启记忆读取。' };
      const pins = vault.pins({ sessionId: args?.all ? '' : sessionId });
      if (pins.length === 0) return { summary: '没有置顶。' };
      const modeName = { always: '常驻', onMatch: '按需命中', manual: '仅手动' };
      const lines = pins.map((p) => `#${p.id} [${modeName[p.mode] ?? p.mode}] ${p.title}${p.note ? `（${p.note}）` : ''}`);
      return { summary: `置顶 ${pins.length} 条：\n${lines.join('\n')}\n用 memory_pin 读完整内容。` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_pin',
    description: '读取一条置顶记忆的完整内容。',
    parameters: {
      id: { type: 'number', description: '置顶 id（见 memory_pin_list）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } } },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const vault = needVault();
      const pin = vault.pin(Number(args?.id));
      if (!pin) return { summary: `没有 id=${args?.id} 的置顶。` };
      const sessionId = sessionIdFromExec(exec);
      const { readScope, policy } = scopeOf(vault, sessionId);
      if (readScope === 'off') return { summary: '本会话未开启记忆读取。' };
      // 可见性：别人的置顶要落在可读范围内（和自动注入同一套规则）
      if (pin.session_id !== sessionId && pin.follow_read === 1) {
        const tags = policy?.readTags ?? [];
        const visible = readScope === 'all'
          || (readScope === 'tags' && vault.sessionsByTags(tags).includes(pin.session_id));
        if (!visible) return { summary: '这条置顶不在本会话的可读范围内。' };
      }
      return {
        summary: `#${pin.id} ${pin.title}${pin.note ? `（${pin.note}）` : ''}\n${pin.body ?? ''}`,
      };
    },
  }));

  // ── surfcore 记忆卡（只读）──────────────────────────────────────────────
  //
  // 刻意**不**进自动联想：surfcore 记的是 QQ / B站 那边的事，词汇和口吻跟 DSH 会话
  // 完全不是一路，混进关键词库会污染召回。所以只有用户明确说要查「surfcore 记忆 /
  // QQ 记忆 / B站 记忆」时，才由模型主动调这个工具。
  ctx.tools.register(defineTool({
    name: 'memory_surfcore',
    description:
      '查看 surfcore 的记忆卡（QQ / B站 那边记住的事）。**只读**，不会修改 surfcore 的数据文件。\n'
      + '只在用户明确要查「surfcore 记忆 / 记忆卡 / QQ 记忆 / B站记忆」时调用；'
      + '普通回忆对话不要用它，用 memory_recall。\n'
      + '这些内容不参与自动联想，也不会进关键词库。',
    parameters: {
      q: { type: 'string', description: '搜索标题/正文/标签；留空则按重要度和时间列最近的。' },
      kind: { type: 'string', description: '类型筛选：firstMeet / owner / event / promise' },
      onlyForgotten: { type: 'boolean', description: '只看 surfcore 已经遗忘、但全量档案里还留着的。' },
      limit: { type: 'integer', description: '最多返回多少条，默认 20，上限 100。' },
      sync: { type: 'boolean', description: '先重新同步一次再查（镜像模式下有用）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          total: { type: 'integer' },
        },
      },
      render: (_a, v) => text(v.summary),
    },
    isConcurrencySafe: () => true,
    async execute(args = {}) {
      const vault = needVault();
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

      if (args.sync === true) {
        const s = vault.surfcoreSync();
        if (!s.ok) return { summary: `同步失败：${s.reason}`, total: 0 };
      }

      const ov = vault.surfcoreOverview();
      if (!ov.ok && !ov.enabled) {
        return {
          summary: '这台机器上没有找到 surfcore 的记忆卡（没装 surfcore，或者还没产生过记忆）。',
          total: 0,
        };
      }

      const res = vault.surfcoreRecords({
        q: args.q ?? '',
        kind: args.kind ?? '',
        inCard: args.onlyForgotten === true ? '0' : '',
        limit,
        offset: 0,
      });

      if (!res.rows?.length) {
        return { summary: '没有匹配的 surfcore 记忆。', total: 0 };
      }

      const st = ov.card?.stats ?? {};
      const head = `surfcore 记忆卡（只读，${res.mode === 'mirror' ? '镜像入库' : '现读文件'}）`
        + ` · 主卡 ${ov.card?.total ?? 0} 条 · 已遗忘 ${st.forgotten ?? 0} 条`;

      const lines = res.rows.map((r, i) => {
        const flags = [
          r.inCard ? '' : '已遗忘',
          r.pinned ? '钉住' : '',
          r.importance > 0 ? `重要度${r.importance}` : '',
        ].filter(Boolean).join(' ');
        const when = String(r.createdAt ?? '').slice(0, 10);
        const body = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
        return `${i + 1}. [${r.kind ?? '?'}${flags ? ` ${flags}` : ''}] ${r.title || '(无标题)'}\n`
          + `   ${when}${r.speaker ? ` · ${r.speaker}` : ''}${r.platform ? ` · ${r.platform}` : ''}\n`
          + `   ${body}`;
      });

      return {
        summary: [head, '', ...lines, '', `共 ${res.total} 条匹配，这次返回 ${res.rows.length} 条。`].join('\n'),
        total: res.total,
      };
    },
  }));
}
