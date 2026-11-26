/**
 * dsh-session-vault —— 客户端半边：设置页里的「记忆库」面板。
 *
 * 严格按 DSH 官方插件开发指引写（`@deepseek-ai/dsh-agent-preset` 里的
 * `skills/cordis-plugin-development/references/practices.md`）：
 *
 *   · 插件 UI 必须是**插槽里的 React 组件**，不要用 iframe 嵌 HTML 页面 ——
 *     iframe 拿不到宿主的主题 token、明暗切换和 ctx.locale。
 *   · 样式只用 `--dsw-alias-*` 主题变量，不写死颜色（写死会在深色模式下瞎）。
 *   · 不 require 任何 Harness Client 包（`dsh-client-ui-primitives` 等），
 *     自己写控件并模仿宿主外观。
 *   · 组件抛错会让整个 slot 条目变空白，所以外面必须套错误边界。
 *   · React 由宿主的浏览器模块表提供（`require('react')`），不需要打包。
 *
 * 数据流：组件 ⇄ `/dsh-session-vault/api/*`（同源 fetch）⇄ 宿主 SQLite。
 * 界面逻辑先在 `dev/ui.html` 里调好，再翻译成这里的 h() —— 流程见 docs/ui-workflow.md。
 */

// 模块加载器不是标准 API，名字必须实测：真实 Web 外壳上是
// `window.__ModuleLoader__`（**两个**下划线）。官方模板里写的是
// `_ModuleLoader__`（一个），照抄会直接 `ReferenceError`，
// 而这个错误会让整个 web boot 报告「entry did not activate」，**应用起不来**。
//
// 所以这里做三件事：多路取名、找不到就只警告、整体 try/catch。
// 原则：界面挂不上可以，绝不能拖垮宿主启动。
(function bootstrapSessionVaultClient() {
  const loader = (typeof window !== 'undefined')
    ? (window.__ModuleLoader__ || window._ModuleLoader__)
    : (typeof __ModuleLoader__ !== 'undefined' ? __ModuleLoader__ : undefined);

  if (!loader || typeof loader.load !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[dsh-session-vault] 找不到客户端模块加载器（__ModuleLoader__），设置页不会出现；插件其余功能不受影响');
    return;
  }

  try {
    loader.load({
      id: 'dsh-session-vault',
      factory(require) {
        const React = require('react');
        const {
          createElement: h, useState, useEffect, useCallback, useRef, Component,
        } = React;

        const API = '/dsh-session-vault/api';
        const NS = 'dsh-session-vault';

        // ─────────────────────────────────────────────────────────────────
        // 主题：只用官方 token（取自 dsh-client-ui-* 里的真实变量名）
        // ─────────────────────────────────────────────────────────────────
        const T = {
          text: 'var(--dsw-alias-label-primary)',
          text2: 'var(--dsw-alias-label-secondary)',
          text3: 'var(--dsw-alias-label-tertiary)',
          caption: 'var(--dsw-alias-label-caption)',
          cardFill: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
          cardStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2))',
          border: 'var(--dsw-alias-border-l2)',
          border3: 'var(--dsw-alias-border-l3)',
          inputFill: 'var(--dsw-alias-bg-layer-2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      brand: 'var(--dsw-alias-state-business-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      fill: 'var(--dsw-alias-fill-tsp-secondary)',
    };

    const CSS = `
.sv-root{max-width:1000px;font-size:13px;line-height:20px;color:${T.text}}
.sv-card{border:1px solid ${T.cardStroke};background:${T.cardFill};border-radius:12px;padding:14px 16px;margin-bottom:12px}
.sv-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.sv-title{font-size:15px;font-weight:600;margin:0;color:${T.text}}
.sv-sub{color:${T.text3};font-size:12px;margin:3px 0 0;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.sv-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.sv-tabs-line{flex:1 1 100%;margin:0}
.sv-tab{padding:5px 14px;border-radius:999px;border:1px solid ${T.border};background:transparent;color:${T.text};cursor:pointer;font-size:12px;font:inherit;font-size:12px}
.sv-tab:hover{background:${T.hover}}
.sv-tab.on{background:${T.brand};border-color:transparent;color:#fff}
.sv-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.sv-kpi{border:1px solid ${T.border3};border-radius:10px;padding:8px 10px}
.sv-kpi b{display:block;font-size:17px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums;color:${T.text}}
.sv-kpi span{font-size:11px;color:${T.text3}}
.sv-meter{height:6px;border-radius:999px;background:${T.fill};overflow:hidden;margin-top:10px}
.sv-meter i{display:block;height:100%;background:${T.brand};transition:width .25s}
.sv-note{font-size:11px;color:${T.text3};margin:7px 0 0}
.sv-btn{font-size:12px;padding:4px 13px;border-radius:8px;border:1px solid ${T.border};background:transparent;color:${T.text};cursor:pointer;font-family:inherit}
.sv-btn:hover{background:${T.hover}}
.sv-btn.primary{background:${T.brand};border-color:transparent;color:#fff}
.sv-btn.sm{font-size:11px;padding:2px 9px}
.sv-btn:disabled{opacity:.5;cursor:not-allowed}
.sv-ws{border-top:1px solid ${T.border3};padding:10px 0 6px}
.sv-ws:first-of-type{border-top:0;padding-top:0}
.sv-wshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.sv-wsname{font-size:13px;font-weight:600;color:${T.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.sv-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;color:${T.text}}
.sv-badge{font-size:11px;padding:1px 7px;border-radius:999px;background:${T.fill};color:${T.text2}}
.sv-row{padding:8px 0 8px 14px;border-top:1px dashed ${T.border3}}
.sv-row-main{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.sv-row-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:5px 8px}
.sv-mini{font-size:11px;color:${T.caption}}
.sv-t{font-weight:500}
.sv-eff{font-size:12px;min-width:18px;text-align:center;color:${T.caption};cursor:help}
.sv-eff.on{color:${T.brand};font-weight:700}
.sv-row:first-of-type{border-top:0}
.sv-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-sid{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:${T.caption};min-width:54px}
.sv-time{font-size:10px;color:${T.caption};min-width:74px;font-variant-numeric:tabular-nums;white-space:nowrap}
.sv-n{font-size:11px;color:${T.text3};min-width:50px;text-align:right;font-variant-numeric:tabular-nums}
.sv-eff{font-size:11px;color:${T.text2};min-width:76px;text-align:right}
.sv-sel{font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid ${T.border};background:${T.inputFill};color:${T.text};font-family:inherit;max-width:340px}
.sv-sel-grow{flex:1 1 200px;min-width:160px;max-width:none}
.sv-search{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.sv-input{flex:1;min-width:180px;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid ${T.border};background:${T.inputFill};color:${T.text};font-family:inherit}
.sv-toggle{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none}
.sv-sw{width:34px;height:18px;border-radius:999px;background:${T.fill};border:1px solid ${T.border};position:relative;transition:background .15s;flex:0 0 auto}
.sv-sw.on{background:${T.brand};border-color:transparent}
.sv-sw i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:left .15s}
.sv-sw.on i{left:18px}
.sv-msg{margin:10px 0 0;font-size:12px}
.sv-msg.ok{color:${T.brand}}
.sv-msg.err{color:${T.danger}}
.sv-trow{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px dashed ${T.border3};font-size:12px}
.sv-trow:first-of-type{border-top:0}
.sv-tname{font-family:ui-monospace,Consolas,monospace;flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-tnum{color:${T.text3};min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
.sv-trow.muted .sv-tname{opacity:.45;text-decoration:line-through}
.sv-thead{font-size:10px;color:${T.caption};border-top:0;border-bottom:1px solid ${T.border3};padding:2px 0 5px;letter-spacing:.03em}
.sv-thead .sv-tname{font-family:inherit;font-weight:400}
.sv-thead .sv-tnum{font-size:10px}
.sv-pin{width:56px;font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid ${T.border};background:${T.inputFill};color:${T.text};text-align:right;font-family:inherit}
.sv-field{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.sv-warn{color:${T.text2};font-size:12px;margin-top:6px}
.sv-kv{font-size:12px;margin-top:6px;font-family:ui-monospace,Consolas,monospace;word-break:break-all;white-space:pre-wrap}
.sv-empty{color:${T.text3};font-size:12px;padding:8px 0}
.sv-more{margin:6px 0 0 14px;font-size:11px;color:${T.brand};background:none;border:0;cursor:pointer;padding:0;font-family:inherit}
.sv-msgs{max-height:260px;overflow:auto;border:1px solid ${T.border3};border-radius:10px;padding:6px;margin-top:8px}
.sv-msgrow{display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px}
.sv-msgrow:hover{background:${T.hover}}
.sv-msgrow.on{background:${T.brand};color:#fff}
.sv-seq{font-family:ui-monospace,Consolas,monospace;font-size:10px;min-width:42px;opacity:.75}
.sv-role{font-size:10px;min-width:64px;opacity:.75}
.sv-mtext{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;background:${T.fill};color:${T.text2};margin-right:4px}
.sv-tags{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;max-width:220px}
.sv-chip{cursor:pointer}
.sv-chip.on{background:${T.brand};color:#fff}
.sv-rrow{display:flex;gap:10px;align-items:baseline;padding:5px 8px;border-bottom:1px solid ${T.border3};font-size:12px}
.sv-rrow:last-child{border-bottom:0}
.sv-rtime{font-size:10px;color:${T.caption};min-width:74px;font-variant-numeric:tabular-nums;white-space:nowrap}
.sv-rhead{font-size:10px;color:${T.caption};padding-bottom:5px;letter-spacing:.03em}
.sv-rhead.sv-rrow{border-top:0;border-bottom:1px solid ${T.border3}}
.sv-rhead .sv-rinj{font-weight:400;color:${T.caption}}
.sv-rq{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-rhits{flex:1.2 1 140px;min-width:0;font-size:11px;color:${T.text2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-rinj{min-width:30px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.sv-rinj.on{color:${T.brand}}
.sv-rinj.off{color:${T.caption}}
.sv-rms{font-size:10px;color:${T.caption};min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
.sv-preview{margin-top:12px;border:1px solid ${T.border3};border-radius:10px;padding:10px 12px;max-height:260px;overflow:auto;background:${T.fill}}
.sv-preview-head{font-size:11px;color:${T.caption};margin-bottom:8px}
.sv-preview-item{margin-bottom:10px}
.sv-preview-item:last-child{margin-bottom:0}
.sv-preview-tag{font-size:10px;color:${T.text3};font-family:ui-monospace,Consolas,monospace}
.sv-preview-body{font-size:12px;white-space:pre-wrap;word-break:break-word;color:${T.text};line-height:1.55;margin-top:2px}
.sv-sc-banner{display:flex;align-items:center;gap:8px;font-size:12px;color:${T.text2};padding:6px 10px;border-radius:8px;background:${T.fill};margin-bottom:10px}
.sv-sc-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;border:1px solid ${T.brand};color:${T.brand};white-space:nowrap}
.sv-sc-kinds{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.sv-scrow{border-top:1px dashed ${T.border3}}
.sv-scrow:first-child{border-top:0}
.sv-scrow-head{display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-size:12px;border-radius:6px}
.sv-scrow-head:hover{background:${T.hover}}
.sv-scrow-arrow{width:10px;color:${T.caption};font-size:10px;flex:0 0 auto}
.sv-scrow-k{font-size:10px;padding:1px 5px;border-radius:4px;border:1px solid ${T.border3};color:${T.text3};white-space:nowrap;flex:0 0 auto}
.sv-schead{cursor:default;border-bottom:1px solid ${T.border3};border-radius:0;padding:2px 4px 5px}
.sv-schead:hover{background:transparent}
.sv-schead .sv-scrow-t{font-size:10px;color:${T.caption};letter-spacing:.03em}
.sv-scrow-ktag{font-size:10px;padding:1px 5px;border-radius:4px;color:${T.caption};white-space:nowrap;flex:0 0 auto}
.sv-schead .sv-scrow-imp,.sv-schead .sv-scrow-time{font-size:10px;color:${T.caption}}
.sv-scrow-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sv-scrow-gone{font-size:10px;color:${T.danger};white-space:nowrap;flex:0 0 auto}
.sv-scrow-pin{font-size:10px;color:${T.brand};white-space:nowrap;flex:0 0 auto}
.sv-scrow-lock{font-size:10px;color:${T.text3};white-space:nowrap;flex:0 0 auto}
.sv-scrow-imp{font-size:10px;color:${T.text3};min-width:18px;text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto}
.sv-scrow-time{font-size:10px;color:${T.caption};white-space:nowrap;flex:0 0 auto}
.sv-scrow-body{padding:2px 4px 12px 22px}
.sv-sc-text{font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.55;color:${T.text}}
.sv-sc-detail{font-size:11px;color:${T.text3};margin-top:6px;white-space:pre-wrap;word-break:break-word}
.sv-sc-reasons{font-size:11px;color:${T.text3};margin-top:6px}
.sv-sc-meta{font-size:10px;color:${T.caption};margin-top:8px;word-break:break-all}
.sv-sc-mask{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:${T.text3};padding:6px 0}
.sv-taginput{width:96px;font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid ${T.border};background:${T.inputFill};color:${T.text};font-family:inherit}
`;

    const STORE_OPTS = [['inherit', '继承'], ['store', '存'], ['skip', '不存']];
    const READ_OPTS = [['inherit', '继承'], ['off', '关'], ['own', '仅本会话'], ['all', '全库']];
    const WS_STORE = [['store', '存'], ['skip', '不存']];
    const WS_READ = [['off', '关'], ['own', '仅本会话'], ['all', '全库']];

    const fmt = (n) => Number(n ?? 0).toLocaleString('zh-CN');

    /** 会话最后活动时间：标题重复时靠它区分（MM-DD HH:mm）。 */
    // 时间格式化。既接受毫秒时间戳，也接受 ISO 字符串
    // （surfcore 的记录用的是 ISO，直接 Number() 会 NaN）。
    const fmtTime = (ts) => {
      const n = typeof ts === 'string' && !/^\d+$/.test(ts)
        ? Date.parse(ts)
        : Number(ts ?? 0);
      if (!Number.isFinite(n) || !n) return '—';
      const d = new Date(n);
      const p = (v) => String(v).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    // ─────────────────────────────────────────────────────────────────────
    // 请求
    // ─────────────────────────────────────────────────────────────────────
    async function api(path, body) {
      const opt = { method: body ? 'POST' : 'GET' };
      if (body) {
        opt.headers = { 'content-type': 'application/json' };
        opt.body = JSON.stringify(body);
      }
      const res = await fetch(`${API}${path}`, opt);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
      return data.data;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 错误边界：组件抛错会让整个 slot 条目变空白，必须自己兜
    // ─────────────────────────────────────────────────────────────────────
    class Boundary extends Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }

      static getDerivedStateFromError(err) {
        return { err };
      }

      componentDidCatch(err) {
        // eslint-disable-next-line no-console
        console.warn(`[${NS}] 界面渲染出错（已兜住，避免整块空白）：`, err);
      }

      render() {
        if (this.state.err) {
          return h('div', { className: 'sv-root' }, [
            h('style', { key: 'css' }, CSS),
            h('div', { className: 'sv-card', key: 'c' }, [
              h('h3', { className: 'sv-title', key: 't' }, '记忆库界面出错'),
              h('p', { className: 'sv-note', key: 'm' }, String(this.state.err?.message ?? this.state.err)),
              h('p', { className: 'sv-note', key: 'h' },
                `插件本体不受影响，可用 memory_* 工具或直接访问 ${API}/overview。`),
            ]),
          ]);
        }
        return this.props.children;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 小组件
    // ─────────────────────────────────────────────────────────────────────
    function Card({ children, key }) {
      return h('div', { className: 'sv-card', key }, children);
    }

    function Kpis({ items }) {
      return h('div', { className: 'sv-kpis' },
        items.map((p) => h('div', { className: 'sv-kpi', key: p[0] }, [
          h('b', { key: 'b' }, p[1]),
          h('span', { key: 's' }, p[0]),
        ])));
    }

    // 注意 className 要显式支持：外部会用它做「选中态」切换。
    // 另外**千万不要**把 style 写成字符串（React 要求对象，字符串会让整个 tab 崩掉）。
    function Btn({ children, onClick, disabled, primary, sm, className }) {
      const cls = ['sv-btn', primary ? 'primary' : '', sm ? 'sm' : '', className ?? '']
        .filter(Boolean).join(' ');
      return h('button', {
        type: 'button',
        className: cls,
        onClick,
        disabled: !!disabled,
      }, children);
    }

    /**
     * 把会话树摊平成 `<select>` 的选项。
     *
     * 为什么单独抽出来：三个页面（关键词 / 置顶 / 联想）各写了一遍，宽度和
     * 重名处理都不一致。更重要的是**重名问题** —— whale-work 那批自动化会话
     * 是同一分钟创建的，标题全被当成注入内容挡掉，最后都显示成
     * `（11-26 07:18 · 5 条）`，31 个一模一样的选项，用户根本选不出哪个是哪个。
     * 所以这里给重名的加序号（第 1 个、第 2 个…）。
     *
     * @param {Array} groups sessionTree 的 groups
     * @param {{ head?: [string, string] }} [opts] 第一项（如「全部会话」）
     */
    function sessionOptionList(groups, opts = {}) {
      const items = [];
      for (const g of groups ?? []) {
        for (const s of g.sessions ?? []) {
          items.push([s.id, `${g.workspaceLabel ?? g.workspace} · ${s.title}`]);
        }
      }
      const total = new Map();
      for (const [, label] of items) total.set(label, (total.get(label) ?? 0) + 1);
      const seen = new Map();
      const out = opts.head ? [opts.head] : [];
      for (const [id, label] of items) {
        let text = label;
        if ((total.get(label) ?? 0) > 1) {
          const k = (seen.get(label) ?? 0) + 1;
          seen.set(label, k);
          text = `${label}（${k}）`;
        }
        out.push([id, text.slice(0, 90)]);
      }
      return out;
    }

    // options 必须是 [值, 标签] 元组数组（不是 {value,label} 对象）。
    // className 用来在特定位置加宽度约束（比如关键词页的会话下拉要拉宽）。
    function Sel({ value, options, onChange, disabled, className }) {
      return h('select', {
        className: className ? `sv-sel ${className}` : 'sv-sel',
        value: value ?? '',
        disabled: !!disabled,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, label]) => h('option', { key: v, value: v }, label)));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 概览
    // ─────────────────────────────────────────────────────────────────────
    function Overview({ data, busy, onScan, onToggle, scanProgress }) {
      if (!data) return h(Card, { key: 'l' }, h('div', { className: 'sv-empty' }, '加载中…'));

      const out = [];

      const sp = scanProgress ?? data.scanProgress;
      if (sp && sp.running) {
        const pct = sp.total ? Math.round((sp.done / sp.total) * 100) : 0;
        out.push(h(Card, { key: 'prog' }, [
          h('h3', { className: 'sv-title', key: 't' },
            sp.phase === 'index' ? '正在建立索引…' : '正在导入会话…'),
          h('p', { className: 'sv-note', key: 'n' },
            `${sp.done}/${sp.total} 个文件 · 已入库 ${fmt(sp.newEvents)} 条事件、${fmt(sp.newSummaries)} 条摘要`),
          h('div', { className: 'sv-meter', key: 'm' }, h('i', { style: { width: `${Math.max(2, pct)}%` } })),
        ]));
      }

      const auto = (data.switches ?? []).find((s) => s.name === 'autoHint');

      out.push(h(Card, { key: 'main' }, [
        h('div', { className: 'sv-head', key: 'h' }, [
          h('div', { key: 'l', style: { flex: 1, minWidth: '160px' } }, [
            h('h3', { className: 'sv-title', key: 't' }, '记忆库'),
            h('p', { className: 'sv-sub', key: 's' }, data.dataDir || '（未配置数据目录）'),
          ]),
          h(Btn, { key: 'b', onClick: onScan, disabled: busy, primary: true },
            busy ? '扫描中…' : '立即扫描'),
        ]),

        h(Kpis, {
          key: 'k',
          items: [
            ['会话', fmt(data.sessions)],
            ['事件', fmt(data.events)],
            ['摘要', fmt(data.summaries)],
            ['关键词', fmt(data.activeTerms)],
            ['共现边', fmt(data.edges)],
            ['库体积', `${data.sizeMB} MB`],
          ],
        }),

        h('div', { className: 'sv-meter', key: 'm' },
          h('i', { style: { width: `${Math.max(2, Math.min(100, Math.round((data.sizeMB / 500) * 100)))}%` } })),

        h('p', { className: 'sv-note', key: 'n' },
          `最近一条事件：${data.latestEventAt ? new Date(data.latestEventAt).toISOString().slice(0, 10) : '—'}`
          + ` · 累计召回 ${fmt(data.recalls)} 次`
          + (data.lastScan ? ` · 上次扫描 ${data.lastScan.ms}ms 新增 ${fmt(data.lastScan.newEvents)} 条` : '')),

        auto ? h('div', { key: 'sw', style: { marginTop: '14px' } }, [
          h('label', {
            className: 'sv-toggle',
            key: 'l',
            onClick: () => onToggle('autoHint', !auto.on),
          }, [
            h('div', { className: `sv-sw${auto.on ? ' on' : ''}`, key: 's' }, h('i')),
            h('span', { key: 't' }, `主动联想：${auto.on ? '开' : '关'}`),
          ]),
          h('p', { className: 'sv-note', key: 'n' },
            '开：每轮自动检测相关记忆并注入一行提示。关：不再自动打扰，但 memory_recall 仍可手动查。'),
        ]) : null,
      ]));

      out.push(h(Card, { key: 'kinds' }, [
        h('h3', { className: 'sv-title', key: 't' }, '事件构成'),
        h('p', { className: 'sv-note', key: 'n' },
          (data.byKind ?? []).map((k) => `${k.kind} ${fmt(k.n)}`).join(' · ') || '暂无'),
      ]));

      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 会话
    // ─────────────────────────────────────────────────────────────────────
    function SessionsTab({
      data, busy, onChange, expanded, onExpand,
      tagEdit, onTagEdit, onAddTag, onRemoveTag,
    }) {
      if (!data) return h(Card, { key: 'l' }, h('div', { className: 'sv-empty' }, '加载中…'));
      const { groups = [], summary = {}, allTags = [] } = data;

      // 读的下拉：基础四档 + 每个已有标签一档。
      // 选中任意标签档就进入 `tags:` 模式，这时行里会出现标签勾选区，
      // 可以再点其他标签「多选」—— 存成 tags:a,b，policy 那边已经支持。
      const readOptions = [...READ_OPTS, ...allTags.map((t) => [`tags:${t.tag}`, `标签：${t.tag}`])];

      const out = [h(Card, { key: 'sum' }, [
        h(Kpis, {
          key: 'k',
          items: [
            ['工作区', fmt(summary.workspaces)],
            ['会话总数', fmt(summary.total)],
            ['正在记录', fmt(summary.storing)],
            ['可读记忆', fmt(summary.reading)],
          ],
        }),
        h('p', { className: 'sv-note', key: 'n' },
          '「存」控制这个会话的话要不要进库；「读」控制这个会话能查哪些记忆。两者互相独立。'),
      ])];

      if (groups.length === 0) {
        out.push(h(Card, { key: 'e' },
          h('div', { className: 'sv-empty' }, '还没有任何会话。点「概览」里的「立即扫描」把历史会话导入。')));
        return out;
      }

      const COLLAPSE_AT = 8;
      out.push(h(Card, { key: 'table' }, groups.map((g) => {
        const isExpanded = !!expanded[g.workspace];
        const list = isExpanded ? g.sessions : g.sessions.slice(0, COLLAPSE_AT);

        return h('div', { className: 'sv-ws', key: g.workspace }, [
          h('div', { className: 'sv-wshead', key: 'h' }, [
            // 显示 DSH 左侧栏的工作区名字（「工作区」「微信会话」…），
            // 完整路径放 title 里，鼠标悬停可看
            h('span', { className: 'sv-wsname', key: 'n', title: g.workspace }, g.workspaceLabel ?? g.workspace),
            h('span', { className: 'sv-badge', key: 'b' }, '默认'),
            h('span', { className: 'sv-note', key: 'l1', style: { margin: 0 } }, '存'),
            h(Sel, {
              key: 's1',
              value: g.storeDefault,
              options: WS_STORE,
              disabled: busy,
              onChange: (v) => onChange({ workspace: g.workspace, storeDefault: v }),
            }),
            h('span', { className: 'sv-note', key: 'l2', style: { margin: 0 } }, '读'),
            h(Sel, {
              key: 's2',
              value: g.readDefault,
              options: WS_READ,
              disabled: busy,
              onChange: (v) => onChange({ workspace: g.workspace, readDefault: v }),
            }),
          ]),

          // 两行结构：上行是"这是什么"（标题 + 时间 + 状态点），
          // 下行是"怎么控制"（入库数 + 存 + 读 + 标签）。
          // 单行硬塞 8 个元素在窄面板里会全挤在一起，标题只能露十个字。
          ...list.map((s) => h('div', { className: 'sv-row', key: s.id }, [
            h('div', { className: 'sv-row-main', key: 'main' }, [
              h('span', { className: 'sv-t', key: 't', title: `${s.id}\n扫描到 ${s.events} 条事件，已入库 ${s.storedEvents} 条` }, s.title),
              h('span', { className: 'sv-time', key: 'd' }, fmtTime(s.lastSeenAt)),
              // 生效值：默认（不存不读）时只显示一个灰点，避免每行重复"不存/off"。
              (() => {
                const storeOn = s.effStore === 'store';
                const readOn = s.effRead !== 'off';
                const active = storeOn || readOn;
                const readText = s.effRead === 'off' ? '禁读'
                  : (s.effRead === 'all' ? '全库' : (s.effRead === 'own' ? '仅本会话' : s.effRead));
                return h('span', {
                  className: `sv-eff${active ? ' on' : ''}`,
                  key: 'e',
                  title: `生效：${storeOn ? '会记录' : '不记录'} / ${readText}\n`
                    + `来源：${s.resolvedFrom === 'session' ? '本会话设置'
                      : (s.resolvedFrom === 'workspace' ? '工作区默认' : '全局默认')}`,
                }, active ? '●' : '○');
              })(),
            ]),
            h('div', { className: 'sv-row-ctl', key: 'ctl' }, [
              h('span', { className: 'sv-sid', key: 'i' }, s.shortId),
              h('span', {
                className: 'sv-n',
                key: 'n',
                title: s.storedEvents === 0 && s.events > 0
                  ? `扫描到 ${s.events} 条，但被「不存」挡在库外；把「存」打开后会重新读取历史`
                  : `已入库 ${s.storedEvents} 条`,
              }, s.storedEvents === 0 && s.events > 0 ? '未入库' : `入库 ${fmt(s.storedEvents)} 条`),
              h('span', { className: 'sv-mini', key: 'l1' }, '存'),
              h(Sel, {
                key: 's1',
                value: s.storeMode,
                options: STORE_OPTS,
                disabled: busy,
                onChange: (v) => onChange({ sessionId: s.id, storeMode: v }),
              }),
              h('span', { className: 'sv-mini', key: 'l2' }, '读'),
              h(Sel, {
                key: 's2',
                value: s.readMode,
                options: (() => {
                  // readMode 是多标签（tags:a,b）时 Sel 里没有对应项，补一个动态选项。
                  const tagMode = String(s.readMode ?? '').startsWith('tags:');
                  const cur = tagMode ? String(s.readMode).slice(5).split(',').filter(Boolean) : [];
                  return (tagMode && cur.length > 1)
                    ? [...readOptions, [s.readMode, `标签：${cur.join(' + ')}`]]
                    : readOptions;
                })(),
                disabled: busy,
                onChange: (v) => onChange({ sessionId: s.id, readMode: v }),
              }),
              // 标签：已有的点一下就删，+ 号展开输入框
              h('span', { className: 'sv-tags', key: 'tg' }, [
                ...(s.tags ?? []).map((t) => h('span', {
                  className: 'sv-chip',
                  key: `c-${t}`,
                  title: '点击删除这个标签',
                  onClick: () => onRemoveTag(s.id, t),
                }, t)),
                tagEdit?.sessionId === s.id
                  ? h('input', {
                    key: 'ti',
                    className: 'sv-taginput',
                    type: 'text',
                    placeholder: '标签名，回车确认',
                    value: tagEdit.value,
                    onChange: (e) => onTagEdit(s.id, e.target.value),
                    onKeyDown: (e) => {
                      if (e.key !== 'Enter') return;
                      const v = tagEdit.value.trim();
                      if (v) onAddTag(s.id, v);
                      onTagEdit(null, '');
                    },
                  })
                  : h('button', {
                    key: 'tb',
                    type: 'button',
                    className: 'sv-more',
                    title: '给这个会话加标签（读策略里可以按标签读）',
                    onClick: () => onTagEdit(s.id, ''),
                  }, '+标签'),
              ]),
              // 读 - 按标签多选：只有 readMode 进了 tags: 模式才出现
              (() => {
                const tagMode = String(s.readMode ?? '').startsWith('tags:');
                if (!tagMode) return null;
                const cur = String(s.readMode).slice(5).split(',').filter(Boolean);
                const pool = [...new Set([...(s.tags ?? []), ...allTags.map((t) => t.tag)])];
                if (pool.length === 0) return null;
                return h('span', { className: 'sv-tags', key: 'rt' }, [
                  h('span', { className: 'sv-note', key: 'rl', style: { margin: 0 } }, '读:'),
                  ...pool.map((t) => h('span', {
                    key: `rt-${t}`,
                    className: `sv-chip${cur.includes(t) ? ' on' : ''}`,
                    title: cur.includes(t) ? '点一下不再读这个标签' : '点一下加入读取范围',
                    onClick: () => {
                      const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
                      onChange({
                        sessionId: s.id,
                        readMode: next.length ? `tags:${next.join(',')}` : 'off',
                      });
                    },
                  }, t)),
                ]);
              })(),
            ]),
          ])),

          g.sessions.length > COLLAPSE_AT
            ? h('button', {
              key: 'more',
              className: 'sv-more',
              onClick: () => onExpand(g.workspace),
            }, isExpanded ? '收起' : `展开其余 ${g.sessions.length - COLLAPSE_AT} 条（共 ${g.sessions.length}）`)
            : null,
        ]);
      })));

      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 关键词
    // ─────────────────────────────────────────────────────────────────────
    function TermsTab({
      data, busy, q, script, sessionId, sessionOptions, wordLen,
      onSearch, onSearchInput, onPatch, onMuteAll, onScript, onSession, onWordLen,
    }) {
      const noisy = (data?.rows ?? []).filter((r) => !r.muted && r.degree >= 500).slice(0, 50);
      const words = data?.words ?? null;
      const out = [];

      out.push(h(Card, { key: 'search' }, [
        h('div', { className: 'sv-search', key: 's' }, [
          h('div', { className: 'sv-tabs sv-tabs-line', key: 'sc' }, [
            h(Btn, {
              key: 'all',
              sm: true,
              primary: script !== 'cjk' && script !== 'ascii',
              onClick: () => onScript('all'),
            }, '全部'),
            h(Btn, {
              key: 'cjk',
              sm: true,
              primary: script === 'cjk',
              onClick: () => onScript('cjk'),
            }, '只看中文'),
            h(Btn, {
              key: 'ascii',
              sm: true,
              primary: script === 'ascii',
              onClick: () => onScript('ascii'),
            }, '只看英文'),
          ]),
          // 按词长筛：3/4 字的真词（关键词 / 人格卡 / 训练数据）会被 2 字高频词压住，
          // 不单独筛根本露不出来。没有词表时不显示这排按钮。
          words && words.total > 0
            ? h('div', { className: 'sv-tabs sv-tabs-line', key: 'wl' }, [
              h(Btn, { key: '0', sm: true, primary: !wordLen, onClick: () => onWordLen(0) }, '不限字数'),
              h(Btn, { key: '2', sm: true, primary: wordLen === 2, onClick: () => onWordLen(2) }, '2 字'),
              h(Btn, { key: '3', sm: true, primary: wordLen === 3, onClick: () => onWordLen(3) }, '3 字'),
              h(Btn, { key: '4', sm: true, primary: wordLen === 4, onClick: () => onWordLen(4) }, '4 字'),
            ])
            : null,
          h('input', {
            key: 'i',
            className: 'sv-input',
            type: 'search',
            placeholder: '搜索关键词（例如 ACL、项目、延期）',
            defaultValue: q,
            onChange: (e) => onSearchInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') onSearch(); },
          }),
          h(Btn, { key: 'b1', onClick: onSearch }, '搜索'),
          h(Btn, { key: 'b2', onClick: () => onSearch('') }, '清空'),
        ]),

        // 按会话看：全库榜看不出"这个会话在聊什么"，
        // 一个会话里反复出现的专有名词放到全库会沉底。
        h('div', { className: 'sv-field', key: 'sess' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '看哪个会话'),
          h(Sel, {
            key: 'sel',
            value: sessionId ?? '',
            options: sessionOptions ?? [['', '全库']],
            disabled: busy,
            className: 'sv-sel-grow',
            onChange: (v) => onSession(v),
          }),
        ]),
        h('p', { className: 'sv-note', key: 'h', style: { margin: '4px 0 10px' } },
          sessionId
            ? '只统计这个会话的摘要，所以"它到底在聊什么"能直接看出来。'
            : '全库榜适合找整体主题；想看某个会话在聊什么，选上面那个下拉。'),

        noisy.length
          ? h('div', { className: 'sv-field', key: 'n' }, [
            h(Btn, { key: 'b', onClick: () => onMuteAll(noisy), disabled: busy },
              `屏蔽高频噪声词（${noisy.length}）`),
            h('span', { className: 'sv-note', key: 't' },
              '连接度 ≥ 500 的词，通常是工具名或路径前缀，屏蔽后联想更准。'),
          ])
          : null,

        h('p', { className: 'sv-note', key: 'd' },
          '关键词由摘要自动挖掘。屏蔽（mute）后不参与联想；加权（pin）会覆盖默认 idf 权重，数字越大越优先。'
          + (data ? `  当前 ${data.rows.length} 个${q ? `（搜索：${q}）` : ''}` : '')),
      ]));

      const card = h(Card, { key: 'list' }, (() => {
        if (!data) return h('div', { className: 'sv-empty' }, '加载中…');
        if (!data.rows.length) {
          return h('div', { className: 'sv-empty' }, q ? '没有匹配的关键词。' : '关键词库还是空的，先扫描一次。');
        }
        return [
          // 列头。原来只写 `df 40` / `连 300`，缩写没人看得懂。
          h('div', { className: 'sv-trow sv-thead', key: '_head' }, [
            h('span', { className: 'sv-tname', key: 'n' }, '关键词'),
            h('span', { className: 'sv-tnum', key: 'd' }, '出现次数'),
            h('span', { className: 'sv-tnum', key: 'g' }, '连接度'),
          ]),
          ...data.rows.map((t) => h('div', {
            className: `sv-trow${t.muted ? ' muted' : ''}`,
            key: t.term,
          }, [
            h('span', { className: 'sv-tname', key: 'n' }, t.term),
            h('span', { className: 'sv-tnum', key: 'd' }, String(t.df)),
            h('span', {
              className: 'sv-tnum',
              key: 'g',
              title: '连接度：这个词和其他词一起出现的密集程度。越高越像工具名或路径前缀。',
            }, String(t.degree)),
            h('input', {
              key: 'p',
              className: 'sv-pin',
              type: 'number',
              placeholder: '权重',
              defaultValue: t.pinned == null ? '' : t.pinned,
              onChange: (e) => {
                const raw = e.target.value.trim();
                const v = raw === '' ? -1 : Number(raw);
                if (Number.isFinite(v)) onPatch(t.term, { pinned: v });
              },
            }),
            h(Btn, {
              key: 'm',
              sm: true,
              onClick: () => onPatch(t.term, { muted: !t.muted }),
            }, t.muted ? '恢复' : '屏蔽'),
          ])),
        ];
      })());

      out.push(card);
      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 运维
    // ─────────────────────────────────────────────────────────────────────
    // 注意：这个组件里**不能**用 useState / useEffect。
    // 它被当普通函数调用（不是 h(OpsTab, ...)），而且只在 tab === 'ops' 时执行，
    // 里面的 hooks 会跑到条件分支里，破坏 hooks 顺序 —— 切到运维页直接崩，
    // 表现就是"运维界面出不来"。状态一律由根组件持有，通过 props 传进来。
    // ─────────────────────────────────────────────────────────────────────
    // 置顶
    // ─────────────────────────────────────────────────────────────────────
    const PIN_MODES = [['onMatch', '按需命中'], ['always', '常驻'], ['manual', '仅手动']];

    function PinTab({
      pins, sessionOptions, sessionId, msgs, sums, source, sel, title, mode, busy, msgsOnly,
      onPickSession, onPickMsg, onPickSummary, onSource, onTitle, onMode, onSave, onDelete, onPatch,
      onToggleMsgsOnly,
    }) {
      const out = [];

      out.push(h(Card, { key: 'list' }, [
        h('h3', { className: 'sv-title', key: 't' }, `已置顶 ${pins.length} 条`),
        h('p', { className: 'sv-note', key: 'n' },
          '「按需命中」= 聊到相关内容才注入（默认，省 token）；'
          + '「常驻」= 每轮都注入；「仅手动」= 只有模型调 memory_pin 时才算。'),
        pins.length === 0
          ? h('div', { className: 'sv-empty', key: 'e' }, '还没有置顶。在下面选一段内容钉住。')
          : [
            // 列头：不标一下，看不出「38 字」和那个下拉分别是什么意思
            h('div', { className: 'sv-trow sv-thead', key: '_head' }, [
              h('span', { className: 'sv-tname', key: 'n' }, '置顶内容'),
              h('span', { className: 'sv-tnum', key: 'c' }, '字数'),
            ]),
            ...pins.map((p) => h('div', { className: 'sv-trow', key: p.id }, [
              h('span', { className: 'sv-tname', key: 'n', title: p.note ?? '' }, `#${p.id} ${p.title}`),
              h('span', { className: 'sv-tnum', key: 'c' }, `${p.chars} 字`),
              h(Sel, {
                key: 'm',
                value: p.mode,
                options: PIN_MODES,
                disabled: busy,
                onChange: (v) => onPatch(p.id, { mode: v }),
              }),
              h(Btn, {
                key: 'd', sm: true, disabled: busy, onClick: () => onDelete(p.id),
              }, '删'),
            ])),
          ],
      ]));

      out.push(h(Card, { key: 'new' }, [
        h('h3', { className: 'sv-title', key: 't' }, '新增置顶'),
        h('div', { className: 'sv-field', key: 's' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '从会话'),
          h(Sel, {
            key: 'sel', value: sessionId, options: sessionOptions, disabled: busy,
            className: 'sv-sel-grow',
            onChange: (v) => onPickSession(v),
          }),
          // 来源切换：消息（可精确到一句/一段）/ 整条摘要
          h('span', { className: 'sv-note', key: 'l2', style: { margin: 0 } }, '来源'),
          h(Sel, {
            key: 'src',
            value: source,
            options: [['messages', '消息（可选用区间）'], ['summaries', '整条摘要']],
            disabled: busy || !sessionId,
            onChange: onSource,
          }),
          // 只看对话：工具调用/结果太吵，挑置顶内容时基本不需要
          sessionId && source === 'messages'
            ? h(Btn, {
              key: 'only',
              sm: true,
              primary: msgsOnly,
              disabled: busy,
              onClick: onToggleMsgsOnly,
            }, msgsOnly ? '只看对话 ✓' : '只看对话')
            : null,
        ]),

        // ── 消息来源 ──
        source === 'messages'
          ? (msgs.length === 0
            ? h('div', { className: 'sv-empty', key: 'm' }, sessionId ? '这个会话还没有入库的消息（换个过滤试试）。' : '先选一个会话。')
            : h('div', { className: 'sv-msgs', key: 'm' }, msgs.map((m) => {
              const on = sel && sel.summaryId == null && m.seq >= sel.from && m.seq <= sel.to;
              return h('div', {
                key: `${m.seq}`,
                className: `sv-msgrow${on ? ' on' : ''}`,
                onClick: (e) => onPickMsg(m.seq, e.shiftKey),
                title: '点击选中；Shift+点击选到这一段',
              }, [
                h('span', { className: 'sv-seq', key: 'q' }, `#${m.seq}`),
                h('span', { className: 'sv-role', key: 'r' }, m.kind),
                h('span', { className: 'sv-mtext', key: 'x' }, (() => {
                  // 列表里只显示第一行（正文可能很长），全文在下面的预览区
                  const one = String(m.text ?? '').split('\n').find((x) => x.trim()) ?? '';
                  return one.trim().slice(0, 110);
                })()),
              ]);
            })))
          // ── 摘要来源 ──
          : (sums.length === 0
            ? h('div', { className: 'sv-empty', key: 's' }, sessionId ? '这个会话还没有摘要。' : '先选一个会话。')
            : h('div', { className: 'sv-msgs', key: 's' }, sums.map((s) => {
              const on = sel && sel.summaryId === s.id;
              return h('div', {
                key: `${s.id}`,
                className: `sv-msgrow${on ? ' on' : ''}`,
                onClick: () => onPickSummary(s),
                title: s.body ?? '',
              }, [
                h('span', { className: 'sv-seq', key: 'q' }, `#${s.id}`),
                h('span', { className: 'sv-role', key: 'r' }, `${s.chars}字`),
                h('span', { className: 'sv-mtext', key: 'x' }, String(s.title ?? '').slice(0, 90)),
              ]);
            }))),

        // ── 选中内容的预览：点开就能看到全文，不用去别处找 ──
        (() => {
          if (!sel) return null;
          let lines = [];
          if (source === 'messages') {
            lines = msgs.filter((m) => m.seq >= sel.from && m.seq <= sel.to);
          } else {
            const one = sums.find((x) => x.id === sel.summaryId);
            if (one) lines = [{ seq: one.id, kind: '摘要', text: one.body ?? '' }];
          }
          if (lines.length === 0) return null;
          const total = lines.reduce((n, m) => n + String(m.text ?? '').length, 0);
          return h('div', { className: 'sv-preview', key: 'pv' }, [
            h('div', { className: 'sv-preview-head', key: 'h' },
              `已选 ${lines.length} 条 · 共 ${total} 字`),
            ...lines.map((m) => h('div', { className: 'sv-preview-item', key: `p-${m.seq}` }, [
              h('span', { className: 'sv-preview-tag', key: 't' }, `#${m.seq} ${m.kind}`),
              h('div', { className: 'sv-preview-body', key: 'b' }, String(m.text ?? '')),
            ])),
          ]);
        })(),

        h('p', { className: 'sv-note', key: 'h' },
          source === 'messages'
            ? '点一条 = 选单条；Shift + 点 = 选连续区间（起止都能对上原文）。'
            : '选一条摘要，整段作为置顶内容。'),
        h('div', { className: 'sv-field', key: 'title' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '标题'),
          h('input', {
            key: 'i',
            className: 'sv-input',
            type: 'text',
            placeholder: '例如：Obsidian 库位置',
            value: title,
            onChange: (e) => onTitle(e.target.value),
          }),
          h(Sel, { key: 'm', value: mode, options: PIN_MODES, onChange: onMode }),
          h(Btn, {
            key: 'b',
            primary: true,
            disabled: busy || !sessionId || !sel || !title.trim(),
            onClick: onSave,
          }, '置顶这段'),
        ]),
      ]));

      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // surfcore 记忆卡（只读）
    // ─────────────────────────────────────────────────────────────────────
    // 这个 tab 只读 surfcore 的数据文件，一个字节都不改。
    // 条目默认折叠（几百条全展开没法看），点一下才展开正文。
    const SC_KIND_LABEL = {
      firstMeet: '初见', owner: '主人', event: '事件', promise: '承诺',
    };
    const SC_MODE_LABEL = { live: '现读文件', mirror: '镜像入库' };

    function SurfcoreTab({
      data, rows, busy, q, kind, onlyForgotten, openIds, revealed,
      onToggle, onReveal, onSearch, onClearSearch, onSearchInput, onKind, onToggleForgotten,
      onMode, onSync, onRefresh, onClear, kindOptions,
    }) {
      const out = [];

      if (!data) {
        out.push(h(Card, { key: 'load' }, h('div', { className: 'sv-empty' }, '读取 surfcore 记忆卡…')));
        return out;
      }

      if (!data.ok) {
        out.push(h(Card, { key: 'miss' }, [
          h('h3', { className: 'sv-title', key: 't' }, '没有找到 surfcore 记忆卡'),
          h('p', { className: 'sv-note', key: 'r' }, data.reason ?? '未知原因'),
          h('p', { className: 'sv-note', key: 'p' },
            `找的位置：${data.root ?? '~/.dsh/surfcore'}。装了 surfcore 并且产生过记忆之后这里才会有内容。`),
        ]));
        return out;
      }

      const st = data.card?.stats ?? {};
      const byKind = data.card?.byKind ?? {};
      const mirror = data.mirror ?? {};

      // ── 顶部：只读声明 + 模式切换 ──
      out.push(h(Card, { key: 'head' }, [
        h('div', { className: 'sv-sc-banner', key: 'b' }, [
          h('span', { className: 'sv-sc-badge', key: 'i' }, '只读'),
          h('span', {}, '这个页面只看不改 —— 不会修改 surfcore 的任何数据文件。'),
        ]),
        h('h3', { className: 'sv-title', key: 't' },
          `${data.characterName || 'surfcore'} 的记忆卡`),
        h('p', { className: 'sv-note', key: 'n' },
          `主卡 ${fmt(data.card?.total ?? 0)} 条 · 更新于 ${data.card?.updatedAt ? fmtTime(data.card.updatedAt) : '未知'}`
          + ` · 上次衰减 ${st.lastDecayAt ? fmtTime(st.lastDecayAt) : '无记录'}`),

        h('div', { className: 'sv-field', key: 'mode' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '怎么读'),
          h(Btn, {
            key: 'live', sm: true, primary: data.mode === 'live', disabled: busy,
            onClick: () => onMode('live'),
          }, '现读文件'),
          h(Btn, {
            key: 'mirror', sm: true, primary: data.mode === 'mirror', disabled: busy,
            onClick: () => onMode('mirror'),
          }, '镜像入库'),
          data.mode === 'mirror'
            ? h(Btn, { key: 'sync', sm: true, disabled: busy, onClick: onSync }, '重新同步')
            : null,
          data.mode === 'mirror' && !mirror.empty
            ? h(Btn, { key: 'clr', sm: true, disabled: busy, onClick: onClear }, '清空镜像')
            : null,
        ]),
        h('p', { className: 'sv-note', key: 'md' },
          data.mode === 'live'
            ? '现读文件：每次打开都直接读 surfcore 的文件，永远是最新的，但不落库、不能和其他表联动。'
            : `镜像入库：读到自己的库里，能搜索、能跨库对照。`
              + (mirror.empty
                ? '（还没同步）'
                : ` 已存 ${fmt(mirror.total)} 条（其中 ${fmt(mirror.forgotten)} 条它已经忘了），`
                  + `上次同步 ${mirror.syncedAt ? fmtTime(mirror.syncedAt) : '未知'}。`)),
      ]));

      // ── 统计 ──
      out.push(h(Card, { key: 'stats' }, [
        h('div', { className: 'sv-kpis', key: 'k' }, [
          [fmt(data.card?.total ?? 0), '在主卡里'],
          [fmt(st.forgotten ?? 0), '已被遗忘'],
          [fmt(st.decayed ?? 0), '衰减过'],
          [fmt(st.ingested ?? 0), '累计进过'],
        ].map(([v, l]) => h('div', { className: 'sv-kpi', key: l }, [
          h('div', { className: 'sv-kpi-v', key: 'v' }, v),
          h('div', { className: 'sv-kpi-l', key: 'l' }, l),
        ]))),
        h('div', { className: 'sv-sc-kinds', key: 'bd' },
          Object.entries(byKind).map(([k, n]) => h('span', {
            className: 'sv-chip', key: k,
          }, `${SC_KIND_LABEL[k] ?? k} ${n}`))),
        h('p', { className: 'sv-note', key: 'e' },
          '「已被遗忘」= 主卡里已经没有了、但全量档案里还留着的。surfcore 按自己的遗忘曲线跑，'
          + '这里能看见它忘了什么。'),
      ]));

      // ── 筛选 ──
      out.push(h(Card, { key: 'filter' }, [
        h('div', { className: 'sv-search', key: 's' }, [
          h('input', {
            key: 'q',
            className: 'sv-input',
            type: 'text',
            placeholder: '搜索标题 / 正文 / 标签',
            value: q,
            onChange: (e) => onSearchInput(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') onSearch(); },
          }),
          h(Btn, { key: 'b1', disabled: busy, onClick: onSearch }, '搜索'),
          h(Btn, { key: 'b2', disabled: busy, onClick: onClearSearch }, '清空'),
        ]),
        h('div', { className: 'sv-field', key: 'f' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '类型'),
          h(Sel, {
            key: 'k',
            value: kind,
            options: kindOptions,
            disabled: busy,
            onChange: onKind,
          }),
          h(Btn, {
            key: 'forgot', sm: true, primary: onlyForgotten, disabled: busy,
            onClick: onToggleForgotten,
          }, onlyForgotten ? '只看它忘掉的 ✓' : '只看它忘掉的'),
          h(Btn, { key: 'r', sm: true, disabled: busy, onClick: onRefresh }, '刷新'),
        ]),
        h('p', { className: 'sv-note', key: 'c' },
          `共 ${fmt(rows.total ?? 0)} 条${q ? `（搜索：${q}）` : ''}，点一行展开正文。`),
      ]));

      // ── 列表 ──
      if (!rows.rows?.length) {
        out.push(h(Card, { key: 'empty' },
          h('div', { className: 'sv-empty' }, busy ? '读取中…' : '没有匹配的记忆。')));
        return out;
      }

      out.push(h(Card, { key: 'list' }, [
        // 列头。这页原来每行是「类型 + 标题 + 几个小标记 + 一个数字 + 时间」，
        // 不标一下，那个数字（重要度）和时间是什么全靠猜。
        h('div', { className: 'sv-scrow-head sv-schead', key: '_head' }, [
          h('span', { className: 'sv-scrow-arrow', key: 'a' }, ''),
          h('span', { className: 'sv-scrow-ktag', key: 'k' }, '类型'),
          h('span', { className: 'sv-scrow-t', key: 't' }, '记忆内容（点一行展开）'),
          h('span', { className: 'sv-scrow-imp', key: 'i' }, '重要'),
          h('span', { className: 'sv-scrow-time', key: 'd' }, '记录时间'),
        ]),
        ...rows.rows.map((r) => {
        const open = !!openIds[r.id];
        // 标了敏感/私聊的，默认遮住正文，点一下「显示」才给看
        const masked = (r.sensitive || r.private) && !revealed[r.id];
        const title = r.title || String(r.text ?? '').split('\n').find((x) => x.trim()) || '(无标题)';
        return h('div', { className: `sv-scrow${open ? ' open' : ''}`, key: r.id }, [
          h('div', {
            className: 'sv-scrow-head',
            onClick: () => onToggle(r.id),
            title: open ? '点击收起' : '点击展开正文',
          }, [
            h('span', { className: 'sv-scrow-arrow', key: 'a' }, open ? '▾' : '▸'),
            h('span', {
              className: 'sv-scrow-k', key: 'k',
            }, SC_KIND_LABEL[r.kind] ?? r.kind ?? '其他'),
            h('span', { className: 'sv-scrow-t', key: 't' }, String(title).slice(0, 80)),
            !r.inCard ? h('span', { className: 'sv-scrow-gone', key: 'g' }, '已遗忘') : null,
            r.pinned ? h('span', { className: 'sv-scrow-pin', key: 'p' }, '钉') : null,
            r.sensitive || r.private ? h('span', { className: 'sv-scrow-lock', key: 'l' }, '私') : null,
            h('span', { className: 'sv-scrow-imp', key: 'i' },
              r.importance > 0 ? String(r.importance) : ''),
            h('span', { className: 'sv-scrow-time', key: 'd' }, fmtTime(r.createdAt)),
          ]),
          open
            ? h('div', { className: 'sv-scrow-body', key: 'b' }, [
              masked
                ? h('div', { className: 'sv-sc-mask', key: 'm' }, [
                  h('span', { key: 'x' }, '这条标了私聊/敏感，默认遮住。'),
                  h(Btn, {
                    key: 'b', sm: true, onClick: (e) => { e.stopPropagation(); onReveal(r.id); },
                  }, '显示内容'),
                ])
                : h('div', { className: 'sv-sc-text', key: 'x' }, String(r.text || '(空)')),
              !masked && r.detail
                ? h('div', { className: 'sv-sc-detail', key: 'd' }, r.detail)
                : null,
              (r.tags?.length ?? 0) > 0
                ? h('div', { className: 'sv-tags', key: 'tg' },
                  r.tags.map((t) => h('span', { className: 'sv-chip', key: t }, t)))
                : null,
              (r.importanceReasons?.length ?? 0) > 0
                ? h('div', { className: 'sv-sc-reasons', key: 'r' },
                  `为什么重要：${r.importanceReasons.join(' · ')}`)
                : null,
              h('div', { className: 'sv-sc-meta', key: 'm' }, [
                r.speaker ? `${r.speaker}` : '',
                r.platform ? `平台 ${r.platform}` : '',
                r.clarity ? `清晰度 ${r.clarity}` : '',
                `召回 ${r.recallCount} 次`,
                r.decaySteps ? `衰减 ${r.decaySteps} 步` : '',
                `id ${r.id}`,
              ].filter(Boolean).join(' · ')),
            ])
            : null,
        ]);
        }),
      ]));

      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 联想记录
    // ─────────────────────────────────────────────────────────────────────
    // 注入到系统提示的内容界面上看不到，所以这里提供"审计视图"：
    // 每条消息留下了什么查询、命中哪几条摘要、最终注入了没有。
    function RecallTab({
      rows, busy, sessionOptions, sessionId, onlyInjected,
      onSession, onToggleInjected, onRefresh,
    }) {
      const out = [];

      out.push(h(Card, { key: 'head' }, [
        h('h3', { className: 'sv-title', key: 't' }, `联想记录 ${rows.length} 条`),
        h('p', { className: 'sv-note', key: 'n' },
          '每条用户消息都会留一行：当时的查询、命中哪几条摘要、最终注入几条、耗时。'
          + '注入内容本身只进系统提示，界面上看不到 —— 这里能确认它到底有没有生效。'),
        h('p', { className: 'sv-note', key: 'n2' },
          '「—」表示没注入：可能是那句话太短/太泛没过阈值，也可能被冷却过滤了。'),
        h('div', { className: 'sv-field', key: 'f' }, [
          h('span', { className: 'sv-note', key: 'l', style: { margin: 0 } }, '会话'),
          h(Sel, {
            key: 's',
            value: sessionId,
            options: sessionOptions,
            disabled: busy,
            className: 'sv-sel-grow',
            onChange: onSession,
          }),
          h(Btn, {
            key: 'b', sm: true, primary: onlyInjected, disabled: busy, onClick: onToggleInjected,
          }, onlyInjected ? '只看注入成功 ✓' : '只看注入成功'),
          h(Btn, { key: 'r', sm: true, disabled: busy, onClick: onRefresh }, '刷新'),
        ]),
      ]));

      if (rows.length === 0) {
        out.push(h(Card, { key: 'empty' },
          h('div', { className: 'sv-empty' }, '还没有联想记录。发几条消息再回来看。')));
        return out;
      }

      out.push(h(Card, { key: 'list' }, [
        // 表头：之前这个列表没有任何列名。命中列改成显示摘要标题后列变宽了，
        // 不标一下分不清哪列是什么（尤其「注入」和「耗时」这种数字列）。
        h('div', { className: 'sv-rrow sv-rhead', key: 'head' }, [
          h('span', { className: 'sv-rtime', key: 't' }, '时间'),
          h('span', { className: 'sv-rq', key: 'q' }, '你说了什么'),
          h('span', { className: 'sv-rhits', key: 'h' }, '联想到的摘要'),
          h('span', { className: 'sv-rinj', key: 'i' }, '注入'),
          h('span', { className: 'sv-rms', key: 'm' }, '耗时'),
        ]),
        ...rows.map((r) => {
          const hits = Array.isArray(r.hits) ? r.hits : [];
        // 显示摘要标题而不是 #id —— 用户看不懂内部编号。
        // 多条命中时只显示第一条的标题 + "+N"，全部列在 tooltip 里。
        const first = hits[0];
        const firstLabel = first ? (first.title || `#${first.id}`) : '';
        const hitText = hits.length
          ? `${firstLabel}${hits.length > 1 ? ` +${hits.length - 1}` : ''}`
          : '无';
        const scoreTitle = hits.length
          ? hits.map((x, i) => {
            const mark = i < (r.injected ?? 0) ? '✓ ' : '  ';
            return `${mark}${x.title || `#${x.id}`}  相关度 ${x.score}`
              + (x.sessionTitle ? `\n     ${x.sessionTitle}` : '');
          }).join('\n')
          : '没有命中任何摘要';
        return h('div', { className: 'sv-rrow', key: r.id }, [
          h('span', { className: 'sv-rtime', key: 't' }, fmtTime(r.ts)),
          h('span', {
            className: 'sv-rq', key: 'q', title: `${r.query}\n\n会话：${r.sessionTitle || r.sessionId || '（未知）'}`,
          }, String(r.query ?? '')),
          h('span', {
            className: 'sv-rhits',
            key: 'h',
            title: `${scoreTitle}\n\n命中 ${hits.length} 条，注入 ${r.injected} 条（✓ = 真注入了）`,
          }, hitText),
          h('span', {
            className: `sv-rinj ${r.injected > 0 ? 'on' : 'off'}`,
            key: 'i',
            title: r.injected > 0 ? `已注入 ${r.injected} 条` : '未注入（阈值或冷却过滤）',
          }, r.injected > 0 ? `+${r.injected}` : '—'),
          h('span', { className: 'sv-rms', key: 'm' }, `${r.elapsedMs ?? 0}ms`),
        ]);
        }),
      ]));

      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 运维
    // ─────────────────────────────────────────────────────────────────────
    function OpsTab({
      data, busy, ops, onMigrate, onRebuild, onExport, target, onTargetChange, onResetPolicies, onPurge,
      onBackup, onRediscoverWords, words, vectors, onTrainVectors,
    }) {
      const out = [];

      out.push(h(Card, { key: 'backup' }, [
        h('h3', { className: 'sv-title', key: 't' }, '备份'),
        h('p', { className: 'sv-note', key: 'n' },
          '把当前记忆库整体拷一份到数据目录下（文件名带时间戳）。'
          + '用的是 SQLite 的 VACUUM INTO，产出一个干净的单文件，不依赖 -wal / -shm。'),
        h('p', { className: 'sv-note', key: 'n2' },
          '重建会清空内容并按当前策略重新导入，这个工作区若被设成「不存」，'
          + '那些历史就再也回不来了 —— 所以重建前会先自动备份一次。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onBackup, disabled: busy }, '立即备份')),
      ]));

      out.push(h(Card, { key: 'content' }, [
        h('h3', { className: 'sv-title', key: 't' }, '按当前内容范围重建'),
        h('p', { className: 'sv-note', key: 'n1' },
          '记忆层（摘要、关键词）只收人和助手的对话；工具调用/结果只进归档层'
          + '（能搜、展开原文能看到），不参与摘要与关键词挖掘。'),
        h('p', { className: 'sv-note', key: 'n2' },
          '改了「保存哪些内容」之后要跑一次这个，老摘要才会按新规则重算。'
          + '会清空事件/摘要/关键词并重新导入（约 3 秒）；会话、策略、标签、置顶都保留。'),
        h('p', { className: 'sv-warn', key: 'n3' },
          '注意：重建严格按当前策略重导。设成「不存」的工作区，历史数据会消失。'
          + '点按钮时会把「预计保留 / 预计丢弃」先算出来给你看。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onPurge, disabled: busy }, '清空并按新规则重建')),
      ]));

      out.push(h(Card, { key: 'privacy' }, [
        h('h3', { className: 'sv-title', key: 't' }, '隐私开关'),
        h('p', { className: 'sv-note', key: 'n' },
          '默认所有会话都「不存、不读」。这个按钮把历史设置（会话级、工作区级）全部清掉，'
          + '回到一个都没打开的状态，然后你自己在「会话」页一个个决定存哪个、读哪个。'),
        h('p', { className: 'sv-note', key: 'n2' },
          '只改开关，不会删掉已经入库的事件和摘要。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onResetPolicies, disabled: busy }, '全部关掉（不存 / 不读）')),
      ]));

      out.push(h(Card, { key: 'dir' }, [
        h('h3', { className: 'sv-title', key: 't' }, '数据目录'),
        h('p', { className: 'sv-sub', key: 's' }, data?.dataDir ?? '…'),
        h('div', { className: 'sv-field', key: 'f' }, [
          h('input', {
            key: 'i',
            className: 'sv-input',
            type: 'text',
            placeholder: '新的数据目录绝对路径，例如 D:\\DSH\\session-vault',
            value: target,
            onChange: (e) => onTargetChange(e.target.value),
          }),
          h(Btn, { key: 'b', onClick: () => onMigrate(target.trim()), disabled: busy || !target.trim() }, '迁移'),
        ]),
        h('p', { className: 'sv-warn', key: 'w' },
          '迁移会复制整个目录并逐表校验行数，校验通过才切换；失败自动回滚。'
          + '迁移成功后会记住新路径，下次启动自动使用，不需要再改配置。'),
      ]));

      out.push(h(Card, { key: 'words' }, [
        h('h3', { className: 'sv-title', key: 't' }, '词表（真词）'),
        h('p', { className: 'sv-note', key: 'n' },
          '关键词库现在同时存两种东西：2 字滑动窗口碎片（保证召回）和词发现判出来的真词'
          + '（关键词页默认只显示真词）。词发现靠互信息和左右熵判断词边界，不需要词典。'),
        h('p', { className: 'sv-note', key: 'n2' },
          words && words.total > 0
            ? `当前词表：${words.total} 个真词`
              + `（2 字 ${words.byLen?.[2] ?? 0} / 3 字 ${words.byLen?.[3] ?? 0} / 4 字 ${words.byLen?.[4] ?? 0}）`
            : '还没有词表 —— 摘要少于 80 条时统计量不可靠，会保持纯 bigram 行为。'),
        h('p', { className: 'sv-warn', key: 'n3' },
          '重新发现会重算词表并重建索引（词变了索引必须跟着变，否则会错位）。不动原文和摘要。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onRediscoverWords, disabled: busy }, '重新发现词表')),
      ]));

      out.push(h(Card, { key: 'vectors' }, [
        h('h3', { className: 'sv-title', key: 't' }, '词向量（实验性，不参与检索）'),
        h('p', { className: 'sv-note', key: 'n' },
          '用共现矩阵 + PPMI + SVD 学出来的词向量 —— 不需要任何预训练模型，'
          + '纯粹从你自己的语料里统计「哪些词总一起出现」。'),
        h('p', { className: 'sv-warn', key: 'n2' },
          '⚠ 这套向量目前**不参与检索**。实测把它接进重排，top1 相关率 86% → 86%，'
          + '没有任何提升（语料太小、而且会学到字符重叠这种假相似）。'
          + '这里只是把训练自动化，方便语料涨大之后重新评估。'),
        h('p', { className: 'sv-note', key: 'n3' },
          vectors && vectors.total > 0
            ? `当前：${fmt(vectors.total)} 个词 × ${vectors.dim} 维`
              + (vectors.updatedAt ? `，上次训练 ${fmtTime(vectors.updatedAt)}` : '')
              + (vectors.last ? `（耗时 ${fmt(vectors.last.totalMs)}ms，能量占比 ${vectors.last.energy}）` : '')
            : '还没有训练过。不同内容少于 100 条时会跳过 —— 那么少的语料 SVD 学不到有意义的东西。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onTrainVectors, disabled: busy }, '立即训练')),
      ]));

      out.push(h(Card, { key: 'rebuild' }, [
        h('h3', { className: 'sv-title', key: 't' }, '重建关键词索引'),
        h('p', { className: 'sv-note', key: 'n' },
          '清空关键词库与共现边，从摘要重新抽取一遍。不会动原文和摘要。'
          + '改过 termMinDf / minEdgeHits 之后跑一次即可生效。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onRebuild, disabled: busy }, '开始重建')),
      ]));

      out.push(h(Card, { key: 'export' }, [
        h('h3', { className: 'sv-title', key: 't' }, '导出'),
        h('p', { className: 'sv-note', key: 'n' },
          '把会话 / 摘要 / 原文导成一个 JSONL 文件，放在数据目录下。可用于备份或迁移到别处。'),
        h('div', { className: 'sv-field', key: 'f' },
          h(Btn, { onClick: onExport, disabled: busy }, '导出 JSONL')),
      ]));

      if (ops) {
        out.push(h(Card, { key: 'result' }, [
          h('h3', { className: 'sv-title', key: 't' }, '上次操作结果'),
          h('div', { className: 'sv-kv', key: 'k' }, ops),
        ]));
      }
      return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 根组件
    // ─────────────────────────────────────────────────────────────────────
    function Root() {
      const [tab, setTab] = useState('overview');
      const [overview, setOverview] = useState(null);
      const [sessions, setSessions] = useState(null);
      const [terms, setTerms] = useState(null);
      const [words, setWords] = useState(null);
      const [vectors, setVectors] = useState(null);
      const [termQ, setTermQ] = useState('');
      const [termInput, setTermInput] = useState('');
      // all / cjk / ascii：关键词列表的语言筛选（中文语料里英文标识符太多）
      const [termScript, setTermScript] = useState('all');
      const [termLen, setTermLen] = useState(0);
      // '' = 全库榜；填具体会话 id = 只看这个会话里的词。
      // 全库榜对"某个会话在聊什么"没有意义 —— 一个会话里反复出现的专有名词
      // 放到全库 4000+ 条摘要里只占零点几，永远排不上来。
      const [termSession, setTermSession] = useState('');
      // 置顶页状态（全部由根组件持有，PinTab 是普通函数调用，不能用 hooks）
      const [pins, setPins] = useState([]);
      const [pinSession, setPinSession] = useState('');
      const [pinMsgs, setPinMsgs] = useState([]);
      const [pinSums, setPinSums] = useState([]);
      // 只看对话：挑置顶内容时把工具调用/结果滤掉
      const [pinMsgsOnly, setPinMsgsOnly] = useState(false);
      // 置顶来源：messages（消息/区间）| summaries（整条摘要）
      const [pinSource, setPinSource] = useState('messages');
      // 联想记录页：rows + 会话筛选 + 只看注入成功
      const [recalls, setRecalls] = useState([]);
      const [recallSession, setRecallSession] = useState('');
      const [recallOnly, setRecallOnly] = useState(false);
      // surfcore 记忆卡页：概览 / 列表 / 筛选 / 展开状态
      const [scData, setScData] = useState(null);
      const [scRows, setScRows] = useState({ rows: [], total: 0 });
      const [scQ, setScQ] = useState('');
      const [scKind, setScKind] = useState('');
      const [scOnlyForgotten, setScOnlyForgotten] = useState(false);
      const [scOpen, setScOpen] = useState({});
      const [scRevealed, setScRevealed] = useState({});
      // { from, to } 用于消息区间；{ summaryId } 用于摘要
      const [pinSel, setPinSel] = useState(null);
      const [pinTitle, setPinTitle] = useState('');
      const [pinMode, setPinMode] = useState('onMatch');
      // 标签行内编辑：{ sessionId, value } 或 null
      const [tagEdit, setTagEdit] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [ops, setOps] = useState('');
      // 迁移目标路径由根组件持有：OpsTab 是普通函数调用，不能自己存 state
      const [migrateTarget, setMigrateTarget] = useState('');
      const [expanded, setExpanded] = useState({});
      const [scanProgress, setScanProgress] = useState(null);
      const pollRef = useRef(null);
      const mountedRef = useRef(true);

      useEffect(() => () => {
        mountedRef.current = false;
        if (pollRef.current) clearTimeout(pollRef.current);
      }, []);

      const loadAll = useCallback(async () => {
        try {
          const [o, s] = await Promise.all([api('/overview'), api('/sessions')]);
          if (!mountedRef.current) return;
          setOverview(o);
          setSessions(s);
          setScanProgress(o.scanProgress ?? null);
          // 词表统计单独拿：失败了不该拖垮整个页面
          try {
            const w = await api('/words');
            if (mountedRef.current) setWords(w);
          } catch { /* 忽略 */ }
          // 词向量状态同理（这套向量不参与检索，拿不到更要能正常渲染）
          try {
            const vv = await api('/vectors');
            if (mountedRef.current) setVectors(vv);
          } catch { /* 忽略 */ }
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, []);

      const loadTerms = useCallback(async (qq, sc, sessionId, wl) => {
        try {
          const s = sc ?? termScript;
          const sid = sessionId === undefined ? termSession : sessionId;
          const len = wl === undefined ? termLen : wl;
          const url = `/terms?q=${encodeURIComponent(qq ?? termQ)}&limit=300`
            + `&script=${encodeURIComponent(s)}&sessionId=${encodeURIComponent(sid ?? '')}&len=${len}`;
          const d = await api(url);
          if (mountedRef.current) setTerms(d);
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [termQ, termScript, termSession, termLen]);

      // ── 置顶 ────────────────────────────────────────────────────────────
      const loadPins = useCallback(async (sessionId) => {
        try {
          const sid = sessionId === undefined ? pinSession : sessionId;
          const d = await api(`/pins?sessionId=${encodeURIComponent(sid ?? '')}`);
          if (mountedRef.current) setPins(d.pins ?? []);
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [pinSession]);

      const loadPinMsgs = useCallback(async (sessionId, only) => {
        if (!sessionId) {
          if (mountedRef.current) setPinMsgs([]);
          return;
        }
        try {
          const o = only === undefined ? pinMsgsOnly : only;
          const kinds = o ? '&kinds=user,assistant' : '';
          const d = await api(`/messages?sessionId=${encodeURIComponent(sessionId)}&limit=300${kinds}`);
          if (mountedRef.current) setPinMsgs(d.rows ?? []);
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [pinMsgsOnly]);

      const loadPinSums = useCallback(async (sessionId) => {
        if (!sessionId) {
          if (mountedRef.current) setPinSums([]);
          return;
        }
        try {
          const d = await api(`/summaries?sessionId=${encodeURIComponent(sessionId)}&limit=300`);
          if (mountedRef.current) setPinSums(d.rows ?? []);
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, []);

      // ── 联想记录 ────────────────────────────────────────────────────────
      const loadRecalls = useCallback(async (sessionId, onlyInjected) => {
        try {
          const sid = sessionId === undefined ? recallSession : sessionId;
          const only = onlyInjected === undefined ? recallOnly : onlyInjected;
          const url = `/recalls?limit=200&sessionId=${encodeURIComponent(sid ?? '')}`
            + `${only ? '&onlyInjected=1' : ''}`;
          const d = await api(url);
          if (mountedRef.current) setRecalls(d.rows ?? []);
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [recallSession, recallOnly]);

      // ── surfcore 记忆卡 ──────────────────────────────────────────────────
      const loadSurfcore = useCallback(async (overrides = {}) => {
        const q = overrides.q === undefined ? scQ : overrides.q;
        const kind = overrides.kind === undefined ? scKind : overrides.kind;
        const onlyForgotten = overrides.onlyForgotten === undefined
          ? scOnlyForgotten : overrides.onlyForgotten;
        try {
          const ov = await api('/surfcore');
          if (!mountedRef.current) return;
          setScData(ov);
          if (!ov.ok) { setScRows({ rows: [], total: 0 }); return; }
          const params = new URLSearchParams({ limit: '200' });
          if (q) params.set('q', q);
          if (kind) params.set('kind', kind);
          // 「只看它忘掉的」= 只要主卡里已经没有的
          if (onlyForgotten) params.set('inCard', '0');
          const list = await api(`/surfcore/records?${params.toString()}`);
          if (!mountedRef.current) return;
          setScRows({ rows: list.rows ?? [], total: list.total ?? 0 });
        } catch (error) {
          if (mountedRef.current) setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [scQ, scKind, scOnlyForgotten]);

      const onSurfcoreMode = useCallback(async (mode) => {
        try {
          await api('/surfcore/mode', { mode });
          setScOpen({});
          await loadSurfcore();
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [loadSurfcore]);

      const onSurfcoreSync = useCallback(async () => {
        try {
          const r = await api('/surfcore/sync', {});
          setMsg({ kind: 'ok', text: `已同步 ${r.added ?? 0} 条（主卡 ${r.inCard ?? 0}，已遗忘 ${r.forgotten ?? 0}）` });
          await loadSurfcore();
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [loadSurfcore]);

      const onSurfcoreClear = useCallback(async () => {
        if (!window.confirm('清空镜像表？只删本库的副本，surfcore 文件不受影响。')) return;
        try {
          await api('/surfcore/clear', {});
          await loadSurfcore();
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }, [loadSurfcore]);

      const onPickPinSession = useCallback((sid) => {
        setPinSession(sid);
        setPinSel(null);
        setPinTitle('');
        loadPins(sid);
        loadPinMsgs(sid, pinMsgsOnly);
        loadPinSums(sid);
      }, [loadPins, loadPinMsgs, loadPinSums]);

      const onPickMsg = useCallback((seq, shiftKey) => {
        setPinSel((cur) => {
          if (shiftKey && cur && cur.summaryId == null) {
            return { from: Math.min(cur.from, seq), to: Math.max(cur.to, seq) };
          }
          return { from: seq, to: seq };
        });
      }, []);

      /** 选一条摘要作为置顶来源。 */
      const onPickSummary = useCallback((s) => {
        setPinSel({
          summaryId: s.id,
          from: s.seq_from ?? null,
          to: s.seq_to ?? null,
        });
        if (!pinTitle.trim()) setPinTitle(String(s.title ?? '').slice(0, 60));
      }, [pinTitle]);


      useEffect(() => {
        loadAll();
      }, [loadAll]);

      // 扫描进行中：轮询概览让进度条动起来
      useEffect(() => {
        if (!scanProgress?.running) return undefined;
        pollRef.current = setTimeout(async () => {
          try {
            const o = await api('/overview');
            if (!mountedRef.current) return;
            setOverview(o);
            setScanProgress(o.scanProgress ?? null);
            if (!o.scanProgress?.running) loadAll();
          } catch { /* 轮询失败就停 */ }
        }, 1500);
        return () => {
          if (pollRef.current) clearTimeout(pollRef.current);
        };
      }, [scanProgress, loadAll]);

      const withBusy = useCallback(async (fn, okText) => {
        setBusy(true);
        setMsg(null);
        try {
          await fn();
          if (okText) setMsg({ kind: 'ok', text: okText });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }, []);

      // ── 标签 ────────────────────────────────────────────────────────────
      const onAddTag = useCallback((sessionId, tag) => withBusy(async () => {
        await api('/tag', { sessionId, tag });
        await loadAll();
      }, '已加标签'), [withBusy, loadAll]);

      const onRemoveTag = useCallback((sessionId, tag) => withBusy(async () => {
        await api('/tag', { sessionId, tag, remove: true });
        await loadAll();
      }, '已移除标签'), [withBusy, loadAll]);

      const onSavePin = useCallback(() => withBusy(async () => {
        if (!pinSession || !pinSel) throw new Error('先选会话和内容');

        // 三种来源统一在这里收口：
        //   summary = 整条摘要    event = 单条消息    range = 连续消息区间
        let payload;
        if (pinSel.summaryId != null) {
          const s = pinSums.find((x) => x.id === pinSel.summaryId);
          if (!s) throw new Error('找不到选中的摘要');
          // 详情接口只给前 600 字，够用；超长的摘要本来也不该整条常驻
          const body = String(s.body ?? '').trim();
          if (!body) throw new Error('这条摘要没有正文');
          payload = {
            sessionId: pinSession,
            source: 'summary',
            summaryId: s.id,
            seqFrom: s.seq_from ?? null,
            seqTo: s.seq_to ?? null,
            title: pinTitle.trim() || String(s.title ?? '').slice(0, 60) || `摘要 #${s.id}`,
            body,
            mode: pinMode,
          };
        } else {
          const slice = pinMsgs.filter((m) => m.seq >= pinSel.from && m.seq <= pinSel.to);
          const body = slice.map((m) => m.text).join('\n');
          if (!body.trim()) throw new Error('选中的消息没有文本');
          payload = {
            sessionId: pinSession,
            source: pinSel.from === pinSel.to ? 'event' : 'range',
            seqFrom: pinSel.from,
            seqTo: pinSel.to,
            title: pinTitle.trim() || `#${pinSel.from}-${pinSel.to}`,
            body,
            mode: pinMode,
          };
        }

        await api('/pin', payload);
        setPinSel(null);
        setPinTitle('');
        await loadPins();
      }, '已置顶'), [pinSession, pinSel, pinMsgs, pinSums, pinTitle, pinMode, withBusy, loadPins]);

      const onDeletePin = useCallback((id) => withBusy(async () => {
        await api('/pin', { action: 'delete', id });
        await loadPins();
      }, '已删除'), [withBusy, loadPins]);

      const onPatchPin = useCallback((id, patch) => withBusy(async () => {
        await api('/pin', { action: 'update', id, patch });
        await loadPins();
      }), [withBusy, loadPins]);
      const onScan = useCallback(() => withBusy(async () => {
        const r = await api('/scan', {});
        await loadAll();
        setMsg({
          kind: 'ok',
          text: `扫描完成：新增 ${fmt(r.newEvents)} 条事件、${fmt(r.newSummaries)} 条摘要（${r.ms}ms）`,
        });
      }), [withBusy, loadAll]);

      const onToggle = useCallback((name, on) => withBusy(async () => {
        await api('/switch', { name, on });
        await loadAll();
      }, `${name} 已${on ? '打开' : '关闭'}`), [withBusy, loadAll]);

      const onChange = useCallback((body) => withBusy(async () => {
        await api('/policy', body);
        await loadAll();
      }), [withBusy, loadAll]);

      const onPatch = useCallback((term, patch) => withBusy(async () => {
        await api('/term', { term, ...patch });
        await loadTerms();
      }), [withBusy, loadTerms]);

      const onMuteAll = useCallback((list) => withBusy(async () => {
        for (const r of list) {
          // 顺序执行，别把宿主打满
          await api('/term', { term: r.term, muted: true });
        }
        await loadTerms();
      }, `已屏蔽 ${list.length} 个高频噪声词`), [withBusy, loadTerms]);

      // 一键全关：清掉历史显式设置，回到"全都不存不读"（不删数据）
      const onResetPolicies = useCallback(() => {
        // 这条会一次清掉所有会话级 + 工作区级的策略，而且没有"撤销"，
        // 所以必须确认 —— 和「清空重建」「迁移」「重建索引」保持一致。
        if (!window.confirm(
          '把所有会话的「存 / 读」设置全部清掉，恢复成默认的「不存 / 不读」？\n\n'
          + '· 已入库的事件和摘要不会被删\n'
          + '· 标签、置顶也保留\n'
          + '· 但每个会话单独设过的存/读开关都会丢失，且无法撤销',
        )) return;
        return withBusy(async () => {
          const r = await api('/policy-reset', {});
          setOps(`已把 ${r?.sessions ?? 0} 个会话恢复成「不存 / 不读」。`
            + '已入库的数据没有删，只是不再写入、不再检索；需要时再一个个打开。');
          await loadAll();
        }, '已全部关闭');
      }, [withBusy, loadAll]);

      // 按当前内容范围重建：清空事件/摘要/关键词后重新导入
      //
      // 这里先拿一次预演再确认，因为重建严格按当前策略重导：
      // 设成「不存」的工作区，历史数据会直接消失（源日志还在，但策略不让入库）。
      // 用户点之前必须看到「会掉多少」。
      const onPurge = useCallback(async () => {
        let pv = null;
        try {
          pv = await api('/purge-preview', { kind: 'preview' });
        } catch {
          // 预演失败不阻止重建，只是少了数字
        }
        const lines = [
          '清空事件、摘要、关键词，并按当前内容范围重新导入？',
          '',
        ];
        if (pv) {
          lines.push(`当前库：${fmt(pv.current.events)} 条事件 / ${fmt(pv.current.summaries)} 条摘要`);
          lines.push(`预计保留：约 ${fmt(pv.expected.events)} 条（${fmt(pv.expected.sessions)} 个会话）`);
          if (pv.dropped.events > 0) {
            lines.push(`预计丢弃：约 ${fmt(pv.dropped.events)} 条（${fmt(pv.dropped.sessions)} 个会话设了「不存」）`);
            lines.push('');
            lines.push('⚠ 被丢弃的部分重建后不会回来 —— 源日志还在，但策略不让入库。');
          }
          lines.push('');
        }
        lines.push('· 会自动先备份一份（文件名带时间戳）');
        lines.push('· 会话、策略、标签、置顶都保留');
        lines.push('· 原始会话日志不会被删');
        if (!window.confirm(lines.join('\n'))) return;
        return withBusy(async () => {
          const r = await api('/purge', {});
          const parts = [
            `原有 ${fmt(r?.preview?.current?.events ?? 0)} 条事件 / ${fmt(r?.preview?.current?.summaries ?? 0)} 条摘要已清空`,
            `重新导入 ${fmt(r?.after?.events ?? 0)} 条事件 / ${fmt(r?.after?.summaries ?? 0)} 条摘要`,
          ];
          if (r?.backup) parts.push(`备份 → ${String(r.backup.path).split(/[\\/]/).pop()}`);
          else if (r?.backupError) parts.push(`备份失败：${r.backupError}`);
          if (r?.words?.skipped) parts.push(`词表：跳过（${r.words.reason}）`);
          else if (r?.words) parts.push(`词表：${r.words.total} 个真词`);
          if (r?.wordsError) parts.push(`词发现失败：${r.wordsError}`);
          if (r?.index) parts.push(`索引：${fmt(r.index.terms)} 个词 / ${fmt(r.index.edges)} 条边`);
          setOps(parts.join('；'));
          await loadAll();
        }, '已重建');
      }, [withBusy, loadAll]);

      // 立即备份
      const onBackup = useCallback(() => {
        return withBusy(async () => {
          const r = await api('/backup', {});
          const mb = Math.round((r?.bytes ?? 0) / 1048576);
          setOps(`已备份：${r?.path ?? '?'}（${mb} MB）`);
        }, '已备份');
      }, [withBusy]);

      // 重新发现词表（会连带重建索引）
      const onRediscoverWords = useCallback(() => {
        if (!window.confirm(
          '重新统计词表？\n\n'
          + '· 会扫描全部摘要正文，用互信息 + 左右熵重新判定词边界\n'
          + '· 术语变了索引必须跟着重建，所以会顺带重建关键词库\n'
          + '· 不动原文和摘要；屏蔽/加权设置会保留（按词名匹配）',
        )) return;
        return withBusy(async () => {
          const r = await api('/words/discover', {});
          if (r?.words?.skipped) {
            setOps(`跳过：${r.words.reason}`);
          } else {
            const byLen = r?.words?.byLen ?? {};
            setOps(`词表已更新：${r?.words?.total ?? 0} 个真词`
              + `（2 字 ${byLen[2] ?? 0} / 3 字 ${byLen[3] ?? 0} / 4 字 ${byLen[4] ?? 0}）`
              + (r?.index ? `；索引 ${fmt(r.index.terms)} 个词` : ''));
          }
          await loadAll();
        }, '词表已更新');
      }, [withBusy, loadAll]);

      // 训练词向量（PPMI + SVD）。纯实验性质，不接入检索。
      const onTrainVectors = useCallback(() => {
        return withBusy(async () => {
          const r = await api('/vectors/train', {});
          const res = r?.result;
          if (res?.skipped) {
            setOps(`跳过：${res.reason}`);
          } else if (res) {
            setOps(`训练完成：${fmt(res.saved)} 个词 × ${res.dim} 维，`
              + `耗时 ${fmt(res.totalMs)}ms（能量占比 ${res.energy}）。注意：这些向量不参与检索。`);
          }
          if (r?.stats) setVectors(r.stats);
          await loadAll();
        }, '词向量已训练');
      }, [withBusy, loadAll]);

      const onRebuild = useCallback(() => {
        if (!window.confirm('重建关键词索引？\n原文和摘要不受影响，但词库会按当前配置重算（可能需要几秒）。')) return;
        withBusy(async () => {
          const r = await api('/rebuild', {});
          setOps(`重建完成：${r.summaries} 条摘要 → ${r.terms} 个关键词、${r.edges} 条边`
            + `（剪掉 ${r.pruned} 个低频词），耗时 ${r.ms}ms`);
          await loadAll();
        }, '索引已重建');
      }, [withBusy, loadAll]);

      const onExport = useCallback(() => withBusy(async () => {
        const r = await api('/export', {});
        setOps(`已导出 ${r.file}\n会话 ${r.sessions} · 摘要 ${r.summaries} · 原文 ${r.events}`
          + ` · ${Math.round(r.bytes / 1024)} KB`);
      }, '导出完成'), [withBusy]);

      const onMigrate = useCallback((to) => {
        if (!to) return;
        if (!window.confirm(`确定把整个数据目录迁移到：\n${to}\n\n会先复制并校验，失败自动回滚。`)) return;
        withBusy(async () => {
          const r = await api('/migrate', { to, confirm: true });
          setOps(`迁移完成 → ${r.dataDir}\n文件：${(r.copied ?? []).join(', ')}\n`
            + `旧目录${r.deletedOld ? '已删除' : '保留（确认无误后可手动删）'}\n提醒：${r.note}`);
          await loadAll();
        }, '迁移完成');
      }, [withBusy, loadAll]);

      const goTab = (next) => {
        setTab(next);
        if (next === 'terms' && !terms) loadTerms(termInput);
        if (next === 'pins') loadPins();
        if (next === 'recalls') loadRecalls();
        if (next === 'surfcore') loadSurfcore();
      };

      const tabs = [
        ['overview', '概览'], ['sessions', '会话'], ['terms', '关键词'],
        ['pins', '置顶'], ['recalls', '联想'], ['surfcore', '记忆卡'], ['ops', '运维'],
      ];

      let body;
      if (tab === 'overview') {
        body = Overview({ data: overview, busy, onScan, onToggle, scanProgress });
      } else if (tab === 'sessions') {
        body = SessionsTab({
          data: sessions,
          busy,
          onChange,
          tagEdit,
          onTagEdit: (sid, value) => setTagEdit(sid === null ? null : { sessionId: sid, value }),
          onAddTag,
          onRemoveTag,
          expanded,
          onExpand: (ws) => setExpanded((prev) => ({ ...prev, [ws]: !prev[ws] })),
        });
      } else if (tab === 'pins') {
        // 会话下拉：这里不需要「全库」项，置顶必须挂在某个会话上
        const pinSessionOptions = sessionOptionList(sessions?.groups, {
          head: ['', '（选一个会话）'],
        });
        body = PinTab({
          pins,
          sessionOptions: pinSessionOptions,
          sessionId: pinSession,
          msgs: pinMsgs,
          sums: pinSums,
          source: pinSource,
          msgsOnly: pinMsgsOnly,
          sel: pinSel,
          title: pinTitle,
          mode: pinMode,
          busy,
          onPickSession: onPickPinSession,
          onPickMsg,
          onPickSummary,
          onSource: (v) => { setPinSource(v); setPinSel(null); },
          onToggleMsgsOnly: () => {
            const next = !pinMsgsOnly;
            setPinMsgsOnly(next);
            setPinSel(null);
            loadPinMsgs(pinSession, next);
          },
          onTitle: setPinTitle,
          onMode: setPinMode,
          onSave: onSavePin,
          onDelete: onDeletePin,
          onPatch: onPatchPin,
        });
      } else if (tab === 'recalls') {
        const recallSessionOptions = sessionOptionList(sessions?.groups, {
          head: ['', '全部会话'],
        });
        body = RecallTab({
          rows: recalls,
          busy,
          sessionOptions: recallSessionOptions,
          sessionId: recallSession,
          onlyInjected: recallOnly,
          onSession: (sid) => {
            setRecallSession(sid);
            loadRecalls(sid, recallOnly);
          },
          onToggleInjected: () => {
            const next = !recallOnly;
            setRecallOnly(next);
            loadRecalls(recallSession, next);
          },
          onRefresh: () => loadRecalls(recallSession, recallOnly),
        });
      } else if (tab === 'surfcore') {
        const scKindOptions = [['', '全部类型']];
        const byKind = scData?.card?.byKind ?? {};
        for (const [k, n] of Object.entries(byKind)) {
          scKindOptions.push([k, `${k}（${n}）`]);
        }
        body = SurfcoreTab({
          data: scData,
          rows: scRows,
          busy,
          q: scQ,
          kind: scKind,
          onlyForgotten: scOnlyForgotten,
          openIds: scOpen,
          revealed: scRevealed,
          kindOptions: scKindOptions,
          onToggle: (id) => setScOpen((prev) => ({ ...prev, [id]: !prev[id] })),
          onReveal: (id) => setScRevealed((prev) => ({ ...prev, [id]: true })),
          onSearchInput: setScQ,
          onSearch: () => loadSurfcore(),
          onClearSearch: () => { setScQ(''); loadSurfcore({ q: '' }); },
          onKind: (v) => { setScKind(v); loadSurfcore({ kind: v }); },
          onToggleForgotten: () => {
            const next = !scOnlyForgotten;
            setScOnlyForgotten(next);
            loadSurfcore({ onlyForgotten: next });
          },
          onMode: onSurfcoreMode,
          onSync: onSurfcoreSync,
          onClear: onSurfcoreClear,
          onRefresh: () => loadSurfcore(),
        });
      } else if (tab === 'terms') {
        // 会话下拉：全库 + 每个会话（带工作区名，方便认）
        // 注意 Sel 的 options 是 [值, 标签] 元组数组，不是 {value,label} 对象 ——
        // 传对象会让 `options.map(([v, label]) => …)` 抛 "not iterable"，整块崩掉。
        const sessionOptions = sessionOptionList(sessions?.groups, {
          head: ['', '全库（整体主题）'],
        });
        body = TermsTab({
          data: terms,
          busy,
          q: termQ,
          script: termScript,
          sessionId: termSession,
          sessionOptions,
          wordLen: termLen,
          onSearch: (v) => {
            const next = typeof v === 'string' ? v : termInput;
            setTermQ(next);
            setTermInput(next);
            loadTerms(next);
          },
          onSearchInput: (v) => setTermInput(v),
          onScript: (s) => {
            setTermScript(s);
            loadTerms(termQ, s);
          },
          onWordLen: (n) => {
            setTermLen(n);
            loadTerms(termQ, termScript, undefined, n);
          },
          onSession: (sid) => {
            setTermSession(sid);
            loadTerms(termQ, termScript, sid);
          },
          onPatch,
          onMuteAll,
        });
      } else {
        body = OpsTab({
          data: overview,
          busy,
          ops,
          onMigrate,
          onRebuild,
          onExport,
          target: migrateTarget,
          onTargetChange: setMigrateTarget,
          onResetPolicies,
          onBackup,
          onRediscoverWords,
          words,
          vectors,
          onTrainVectors,
          onPurge,
        });
      }

      return h('div', { className: 'sv-root' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'sv-tabs', key: 'tabs' }, tabs.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          className: `sv-tab${tab === id ? ' on' : ''}`,
          onClick: () => goTab(id),
        }, label))),
        h('div', { key: 'body' }, body),
        msg ? h('p', { key: 'msg', className: `sv-msg ${msg.kind}` }, msg.text) : null,
      ]);
    }

    function Wrapped() {
      return h(Boundary, null, h(Root));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 注册
    // ─────────────────────────────────────────────────────────────────────
    const inject = ['slots'];

    function apply(ctx) {
      try {
        ctx.effect(
          () => ctx.slots.inject(
            'settings.section',
            () => ctx.slots.register(
              {
                name: 'settings.section',
                id: 'session-vault',
                order: 40,
                label: () => '记忆库',
              },
              Wrapped,
            ),
            `${NS}: settings section`,
          ),
          `${NS}: settings section`,
        );
      } catch (error) {
        // 界面挂不上不影响插件本体
        // eslint-disable-next-line no-console
        console.warn(`[${NS}] 设置页注册失败：${String(error)}`);
      }
    }

      // 返回模块命名空间。
      //
      // 用官方模板的写法（`factory` 直接返回对象）。**不要**用
      // `exports.apply = ...` / `return module.exports` —— 那种写法要求 factory
      // 作用域里有 `module` / `exports`（打包产物才有），手写 bundle 里它们是
      // 未定义的，一求值就抛 ReferenceError。
        return {
          inject,
          apply,
          SessionVaultSection: Wrapped,
          // 仅供测试：用假 React 把每个 tab 真的渲染一遍。
          // 单测抓不到"渲染期才炸"的错误（比如把 {value,label} 传给只认
          // [值,标签] 元组的 Sel），这个出口让它们能在本地就暴露。
          __tabs: {
            Overview, SessionsTab, TermsTab, OpsTab, PinTab, RecallTab, SurfcoreTab,
          },
        };
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[dsh-session-vault] 客户端注册失败（设置页不会出现，插件其余功能不受影响）：', error);
  }
})();
