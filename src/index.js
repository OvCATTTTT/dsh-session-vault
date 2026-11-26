/**
 * dsh-session-vault —— DSH 插件入口。
 *
 * import `@deepseek-ai/*` 的文件一共两个：本文件（`schemastery` / `dsh-home-paths`）和
 * `src/tools.js`（`dsh-tools` 的 `defineTool`）。所有业务逻辑在 src/core.js 及其依赖里，
 * 可以脱离 DSH 单独运行和测试。
 *
 * 设计原则：
 *   · 插件初始化全程 try/catch —— 任何异常都只让本插件「自我禁用」，绝不阻塞 DSH 启动。
 *   · 自动提示走 `agent/inbox/claimed`（DSH 在组装提示词之前的同步钩子）+
 *     `systemPrompt.section`，不改主流程。
 *   · 所有检索失败静默，不影响对话。
 */

import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { join } from 'node:path';

import { SessionVault } from './core.js';
import { normalizeConfig } from './config.js';
import { mkdirSync } from 'node:fs';

import { readLocationPointer, writeLocationPointer } from './migrate.js';
import { resolveDataDir } from './datadir.js';
import { registerTools, sessionIdFromExec } from './tools.js';
import { registerRoutes } from './routes.js';
import { HOOK, emit } from './hooks.js';

export const name = 'dsh-session-vault';
export const inject = ['systemPrompt', 'tools'];

/** 设置页可见的配置项。 */
export const Config = z.object({
  enabled: z.boolean().default(true),

  // ── 路径 ──
  // 默认放在 <DSH_HOME>/plugins/ 下，和插件放在一起 —— 用户一眼能找到，
  // 备份/搬机器也不用记两处路径。改这里不会搬文件，用 memory_migrate 工具搬。
  dataDir: z.string().description('记忆库数据目录（留空 = 自动选择：优先非系统盘 D/E/F/G，都没有则 <DSH_HOME>/session-vault）。第一次运行会选定并记住。改这里不会搬文件，用 memory_migrate 工具搬。').default(''),
  sessionsRoot: z.string().description('DSH 会话日志目录（留空 = <DSH_HOME>/sessions）。').default(''),

  // ── 内容范围 ──
  storeUser: z.boolean().description('保存用户消息').default(true),
  storeAssistant: z.boolean().description('保存助手回答').default(true),
  storeReasoning: z.boolean().description('保存模型的思考过程（体积大，默认关）').default(false),
  storeToolCall: z.boolean().description('保存工具调用参数（只归档，不进摘要/关键词）').default(true),
  storeToolResult: z.boolean().description('保存工具返回结果（只归档，不进摘要/关键词）').default(true),
  storeSystem: z.boolean().description('保存系统提示词（重复度高，默认关）').default(false),
  storeDeveloper: z.boolean().description('保存开发者消息（默认不存）').default(false),
  storeCompactionSummary: z.boolean().description('保存 DSH 压缩摘要（默认不存）').default(false),
  maxEventChars: z.number().description('单条事件最多保存多少字符').default(200000),
  summaryMaxChars: z.number().description('一条摘要最多多少字符').default(1200),
  ftsMaxChars: z.number().description('每条事件送进全文索引的最大字符数（影响库体积）').default(20000),

  // ── 检索与提示 ──
  autoHint: z.boolean().description('每轮自动检测并注入「记忆提示」').default(true),
  hintThreshold: z.number().description('提示触发阈值（0~1，越高越严格）').default(0.35),
  hintMaxItems: z.number().description('最多提示几条').default(3),
  hintCooldownMin: z.number().description('同一条记忆多少分钟内不重复提示').default(10),
  pinBudget: z.number().description('置顶内容每轮最多注入多少字（超出按顺序截断）').default(1500),
  pinHitThreshold: z.number().description('置顶「按需命中」模式的阈值（0~1，越高越严格）').default(0.35),
  injectBoundaryNotice: z.boolean().description('注入常驻的「记忆边界」声明').default(true),
  spreadDepth: z.number().description('关键词联想扩散最大跳数').default(2),
  spreadJump: z.number().description('每跳权重衰减').default(0.4),
  spreadThreshold: z.number().description('扩散剪枝阈值').default(0.15),

  // ── 关键词库 ──
  termMinDf: z.number().description('关键词进入词库所需的最小出现次数（df）；低于此值的词查不到，会由全文检索兜底').default(2),
  termMaxCount: z.number().description('关键词库总量上限（0 = 不限）').default(8000),
  minEdgeHits: z.number().description('共现边保留阈值（只共现过 1 次的边是噪声，默认剪掉）').default(2),
  maxNeighbors: z.number().description('扩散时每个词最多取多少条边（掐断 hub 词扇出）').default(30),
  maxFrontier: z.number().description('扩散时每层最多扩展多少节点').default(100),
  maxSpreadTerms: z.number().description('扩散词数硬上限').default(400),

  // ── 分会话策略（设置页可改，键是会话 id）──
  // 会话 id 可以用 memory_sessions 工具查。值：
  //   store: 'store' | 'skip' | 'inherit'
  //   read : 'off' | 'own' | 'all' | 'inherit'
  // 说明：这是「配置 → 数据库」的单向同步，启动和保存设置时执行。
  // 用 memory_policy 工具临时改的，若该会话在上面字典里出现过，会被这里的值覆盖。
  sessionStore: z.dict(z.string(), z.string()).description('会话 → 写入策略（store/skip/inherit）').default({}),
  sessionRead: z.dict(z.string(), z.string()).description('会话 → 读取范围（off/own/all/inherit）').default({}),
  workspaceStore: z.dict(z.string(), z.string()).description('工作区路径 → 默认写入策略（store/skip）').default({}),
  workspaceRead: z.dict(z.string(), z.string()).description('工作区路径 → 默认读取范围（off/own/all）').default({}),
  mutedTerms: z.array(z.string()).description('要屏蔽的关键词（噪声词）').default([]),
  pinnedTerms: z.array(z.string()).description('要手动加权的关键词').default([]),

  // ── 运维 ──
  scanIntervalSec: z.number().description('自动扫描间隔（秒），0 表示关闭定时扫描').default(300),
  spoolEnabled: z.boolean().description('消费 inbox/ 里的外部投递（如 QQ 记忆）').default(true),
  debug: z.boolean().description('输出调试日志').default(false),
});

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const bootStartedAt = Date.now();
  const dshHome = resolveDshHome();
  let cfg = normalizeConfig(rawConfig, { dshHome });
  // 数据目录解析：用户显式配置 > 位置指针（迁移/首次探测写下的） > 首次自动探测。
  //
  // ⚠️ 这里必须看 rawConfig.dataDir，不能看 cfg.dataDir：
  // normalizeConfig 会把 defaults() 里的 dataDir（C 盘）填进 cfg，
  // 于是 cfg.dataDir 永远非空。早期版本错看了 cfg，结果指针和探测被永久跳过，
  // 用户把默认改到 D 盘、重启后却还在 C 盘 —— 就是这个 bug。
  //
  // 为什么要有「首次探测 + 立刻固化」：
  //   · 记忆库只增不删，会长到 GB 级，默认压系统盘是隐患；
  //   · 但也不能写死 D:\...，换台没 D 盘的机器就废了。
  // 第一次运行时挑一个合适的盘，**选完就把指针写下来**，
  // 之后一律读指针 —— 否则哪天 D 盘满了/被拔走，数据会在盘之间漂移。
  const resolved = resolveDataDir({
    dshHome,
    rawDataDir: typeof rawConfig?.dataDir === 'string' ? rawConfig.dataDir : '',
    pointer: readLocationPointer(dshHome),
  });
  cfg.dataDir = resolved.dir;
  if (resolved.source === 'auto') {
    try {
      mkdirSync(resolved.dir, { recursive: true });
      writeLocationPointer(dshHome, resolved.dir);
      ctx.logger?.('session-vault')?.info?.(`数据目录首次定为 ${resolved.dir}（${resolved.reason}）`);
    } catch {
      // 建不出来/写不进指针就下次再探测，不阻断启动
    }
  }
  cfg.sessionsRoot = cfg.sessionsRoot || join(dshHome, 'sessions');

  /** @type {SessionVault | null} */
  let vault = null;
  let disabled = false;
  let initError = null;

  /** @type {WeakMap<object, { text: string, ids: Set<number>, at: number }>} */
  const agentState = new WeakMap();
  /**
   * 置顶文本单独存：它和「联想提示」的开关是两套逻辑
   * （置顶是用户显式钉的，即使关掉 autoHint 也该注入）。
   * @type {WeakMap<object, { text: string, at: number }>}
   */
  const pinState = new WeakMap();
  /** 当 assembly 里拿不到 agent 时的兜底。 */
  let lastHint = { text: '', ids: new Set(), at: 0 };
  let lastPins = { text: '', at: 0 };
  /** 冷却表：summaryId → 上次提示时间 */
  const cooldown = new Map();

  const log = (msg, level = 'info') => {
    try {
      const fn = ctx.logger?.[level] ?? ctx.logger?.info;
      fn?.call(ctx.logger, `[session-vault] ${msg}`);
    } catch {
      // 日志失败无所谓
    }
  };

  const debug = (msg) => {
    if (cfg.debug) log(msg, 'info');
  };

  // ── 初始化（失败即自我禁用，绝不抛）────────────────────────────────────
  try {
    if (!cfg.enabled) {
      disabled = true;
      log('配置里 enabled=false，插件不启用', 'info');
    } else {
      vault = new SessionVault({
        dataDir: cfg.dataDir,
        sessionsRoot: cfg.sessionsRoot,
        config: cfg,
        dshHome,
        log: (m) => debug(m),
      });
      vault.open();
      log(`记忆库已打开：${cfg.dataDir}`);
    }
  } catch (error) {
    disabled = true;
    initError = error;
    console && console.warn?.(`[dsh-session-vault] 初始化失败，插件已自我禁用：${String(error)}`);
  }

  const getVault = () => (disabled ? null : vault);
  const getConfig = () => cfg;

  if (!disabled) {
    // ── 工具 ──────────────────────────────────────────────────────────────
    try {
      registerTools(ctx, { getVault, getConfig, log });
    } catch (error) {
      log(`工具注册失败：${String(error)}`, 'warn');
    }

    // ── 设置页路由 ────────────────────────────────────────────────────────
    //
    // 官方 practice：可选服务用 `ctx.inject([...], cb)` 声明 —— 没有这个服务的
    // profile 里那段注册根本不会执行，而不是靠 try/catch 兜。这里用它，并保留一条
    // 退路（老版本没有 ctx.inject 时直接注册，由 registerRoutes 自己判断）。
    const registerUi = (target) => {
      const reg = registerRoutes(target, {
        getVault,
        getConfig: () => cfg,
        log,
        getLastScan: () => vault?.lastScan ?? null,
      });
      if (reg.registered > 0) {
        log(`设置页已就绪：${reg.registered} 条 API 路由`);
        const owner = target && typeof target.effect === 'function' ? target : ctx;
        owner.effect(() => () => reg.dispose?.());
      } else {
        log(`设置页不可用（${reg.reason ?? 'unknown'}），插件其余功能正常`, 'info');
      }
    };

    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (scoped) => {
          try {
            registerUi(scoped ?? ctx);
          } catch (error) {
            log(`设置页路由注册失败：${String(error)}`, 'warn');
          }
        });
      } else {
        registerUi(ctx);
      }
    } catch (error) {
      log(`设置页服务声明失败：${String(error)}`, 'warn');
    }

    // ── 系统提示：常驻边界声明 ────────────────────────────────────────────
    try {
      if (cfg.injectBoundaryNotice) {
        ctx.effect(() => ctx.systemPrompt.section({
          name: 'session-vault:boundary',
          order: 0.72,
          interpolate: false,
          text: (assembly) => {
            try {
              if (isSubagent(assembly?.agent)) return '';
              return vault?.boundaryNotice() ?? '';
            } catch {
              return '';
            }
          },
        }));
      }
    } catch (error) {
      log(`边界声明注册失败：${String(error)}`, 'warn');
    }

    // ── 系统提示：置顶记忆（排在行为边界之前，优先级最高）──────────────────
    //
    // 为什么单独一个 section：置顶和「联想提示」是两套逻辑 ——
    // 用户显式钉的东西不该受 autoHint 开关影响；预算也单独算。
    try {
      ctx.effect(() => ctx.systemPrompt.section({
        name: 'session-vault:pins',
        order: 0.71,
        interpolate: false,
        text: (assembly) => {
          try {
            if (isSubagent(assembly?.agent)) return '';
            const st = assembly?.agent ? pinState.get(assembly.agent) : undefined;
            return (st ?? lastPins).text ?? '';
          } catch {
            return '';
          }
        },
      }));
    } catch (error) {
      log(`置顶注入注册失败：${String(error)}`, 'warn');
    }

    // ── 系统提示：每轮的记忆提示 ──────────────────────────────────────────
    try {
      ctx.effect(() => ctx.systemPrompt.section({
        name: 'session-vault:hint',
        order: 0.73,
        interpolate: false,
        text: (assembly) => {
          try {
            if (isSubagent(assembly?.agent)) return '';
            const st = assembly?.agent ? agentState.get(assembly.agent) : undefined;
            return (st ?? lastHint).text ?? '';
          } catch {
            return '';
          }
        },
      }));
    } catch (error) {
      log(`提示 section 注册失败：${String(error)}`, 'warn');
    }

    // ── 每轮门控：DSH 组装提示词之前的同步钩子 ────────────────────────────
    try {
      ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        const started = Date.now();
        try {
          if (disabled || !vault) return;
          if (isSubagent(agent)) return;
          if (message?.source?.kind !== 'user') return;

          // 系统级提示：首次导入的进度 / 完成通知。
          // 不受「主动联想」开关影响 —— 这是关于记忆库自身的状态，跟联想无关。
          let notice = '';
          try {
            notice = vault.takeNotice();
            if (!notice && vault.scanning) {
              const p = vault.scanProgress;
              if (p && p.total > 0) {
                notice = `〔记忆库〕正在导入历史会话 ${p.done}/${p.total}…可以正常聊天，导入在后台进行。`;
              }
            }
          } catch {
            notice = '';
          }

          // ── 置顶注入：独立于「主动联想」开关 ────────────────────────────
          //
          // 置顶是用户显式钉住的东西，不属于"联想"，所以即使关掉了 autoHint
          // 也照常注入（除非该会话的「读」是关的 —— 那说明用户想全静默）。
          try {
            const pinQuery = (Array.isArray(message.content) ? message.content : [])
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
              .slice(0, 2000);
            const pinSession = sessionIdFromExec({ agent });
            const r = vault.pinTextForTurn({
              sessionId: pinSession,
              query: pinQuery,
              budget: cfg.pinBudget,
              hitThreshold: cfg.pinHitThreshold,
            });
            pinState.set(agent, { text: r.text ?? '', at: Date.now() });
            lastPins = { text: r.text ?? '', at: Date.now() };
            if (r.injected > 0) debug(`置顶注入 ${r.injected} 条（跳过 ${r.skipped}）`);
          } catch {
            pinState.set(agent, { text: '', at: Date.now() });
          }

          // 主动联想开关：运行期可关（memory_switch），关掉后不再自动打扰，
          // 但 memory_recall 工具仍可用。开关存在库里，重启后保留。
          let autoOn = false;
          try {
            autoOn = vault.switchState('autoHint', cfg.autoHint).on;
          } catch {
            autoOn = cfg.autoHint !== false;
          }
          if (!autoOn) {
            if (notice) setHint(agent, { text: notice, ids: new Set(), at: Date.now() });
            return;
          }

          const query = (Array.isArray(message.content) ? message.content : [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
            .slice(0, 2000);
          if (!query.trim()) return;

          const sessionId = sessionIdFromExec({ agent });
          const policy = sessionId ? vault.policyOf(sessionId) : null;
          // 默认「不读」：拿不到策略时不许读全库，否则等于偷偷把别的会话的记忆喂进来
          const readScope = policy?.readScope ?? 'off';
          if (readScope === 'off') {
            setHint(agent, { text: '', ids: new Set(), at: Date.now() });
            return;
          }

          const result = vault.recall(query, {
            sessionId,
            readScope,
            // 按标签读时必须带上标签列表，否则 core 那边展不出会话白名单
            readTags: policy?.readTags ?? [],
            limit: cfg.hintMaxItems,
            threshold: cfg.hintThreshold,
            trigger: 'auto',
          });

          // 冷却过滤
          const now = Date.now();
          const coolMs = Math.max(0, cfg.hintCooldownMin) * 60000;
          const fresh = result.hits.filter((h) => {
            const last = cooldown.get(h.id) ?? 0;
            return now - last >= coolMs;
          });

          if (fresh.length === 0) {
            setHint(agent, { text: notice, ids: new Set(), at: now });
            return;
          }
          for (const h of fresh) cooldown.set(h.id, now);

          // 冷却表别无限增长
          if (cooldown.size > 2000) {
            const cutoff = now - 24 * 3600 * 1000;
            for (const [id, ts] of cooldown) if (ts < cutoff) cooldown.delete(id);
          }

          // 扩展点：允许第三方改写/抑制注入的提示文本
          let hintText = `〔记忆提示〕库里有 ${fresh.length} 条相关记录：\n${fresh
            .map((h, i) => {
              const when = h.periodFrom ? new Date(h.periodFrom).toISOString().slice(0, 10) : '时间未知';
              return `${i + 1}. ${h.title} · ${when} · #${h.id}`;
            })
            .join('\n')}\n需要时用 memory_open 展开 #id 查看原文。`;
          // 把系统级提示（首次导入进度/完成）拼在记忆提示前面
          if (notice) hintText = `${notice}\n${hintText}`;

          {
            const p = emit(HOOK.HINT_BEFORE_RENDER, { hits: fresh, text: hintText });
            if (typeof p?.text === 'string') hintText = p.text;
          }

          setHint(agent, {
            text: hintText,
            ids: new Set(fresh.map((h) => h.id)),
            at: now,
          });

          debug(`门控命中 ${fresh.length} 条，耗时 ${Date.now() - started} ms`);
        } catch (error) {
          debug(`门控异常（已静默）：${String(error)}`);
        }
      });
    } catch (error) {
      log(`门控钩子注册失败：${String(error)}`, 'warn');
    }

    // ── 一轮结束：防抖重扫（增量）─────────────────────────────────────────
    let rescanTimer = null;
    try {
      ctx.on('session/event', (_session, event) => {
        try {
          if (disabled || vault?.scanning) return;
          const type = event?.type;
          if (type !== 'turn/end' && type !== 'session/end-seed') return;
          if (rescanTimer) return;
          rescanTimer = setTimeout(() => {
            rescanTimer = null;
            runScan('事件触发');
          }, 3000);
          rescanTimer.unref?.();
        } catch {
          // 忽略
        }
      });
    } catch (error) {
      log(`事件钩子注册失败：${String(error)}`, 'warn');
    }

    /**
     * 扫描：走异步版，每导入一个文件让出事件循环。
     *
     * 同步版 `scan()` 首次导入实测 17~19 秒（单个大文件 1.86 秒），在 Node 单线程里
     * 就是整段卡死宿主 —— 界面不刷新、模型流中断。所以这里必须用 scanAsync。
     */
    function runScan(reason) {
      if (disabled || !vault || vault.scanning) return;
      const started = Date.now();
      const firstRun = !vault.lastScan;
      vault.scanAsync({
        onProgress: (p) => {
          // 首次导入时每 10 个文件报一次，让用户知道在动
          if (firstRun && p.done > 0 && p.done % 10 === 0) {
            log(`首次导入 ${p.done}/${p.total} 个会话…（已入库 ${p.newEvents} 条）`);
          }
        },
      }).then((r) => {
        if (r.newEvents > 0 || r.newSummaries > 0) {
          log(`扫描(${reason})：+${r.newEvents} 事件 / +${r.newSummaries} 摘要 / ${r.ms}ms`);
        } else if (firstRun) {
          log(`首次扫描完成：库已是最新（${r.files} 个文件，${Date.now() - started}ms）`);
        }

        // 首次导入完成 → 给用户一条一次性通知（下一轮对话里由模型转述）
        if (firstRun && (r.newEvents > 0 || r.newSummaries > 0)) {
          vault?.setNotice(
            `〔记忆库〕首次导入完成：${r.files} 个会话、${r.newEvents} 条事件、${r.newSummaries} 条摘要`
            + `（耗时 ${Math.round(r.ms / 1000)} 秒）。`
            + '请用一句话告诉用户这件事，并说明以后会自动增量更新、无需手动操作；'
            + '不要展开细节，除非用户追问。',
          );
        }
      }).catch((error) => {
        log(`扫描(${reason})失败（已静默）：${String(error)}`, 'warn');
      });
    }

    // ── 启动后首次扫描 + 定时扫描 ─────────────────────────────────────────
    //
    // 延迟到 8 秒：宿主启动那几秒自己也在读大量文件、加载 16 个插件，
    // 这时候再去扫 66 个会话文件就是跟它抢磁盘。错开之后体感差别很明显。
    try {
      const boot = setTimeout(() => runScan('启动'), 8000);
      boot.unref?.();
    } catch {
      // 忽略
    }

    // 挖词规则升级后的索引重建，也要放在启动完成之后。
    // 放在 open() 里同步跑会把启动卡住（实测几秒），已经挪出来。
    try {
      const reidx = setTimeout(() => {
        try {
          const r = vault?.maybeReindex?.();
          if (r?.reindexed) log(`关键词索引已按新规则重建（${r.summaries} 条摘要）`);
        } catch (error) {
          log(`关键词索引重建失败：${String(error)}`, 'warn');
        }
      }, 12000);
      reidx.unref?.();
      ctx.effect(() => () => clearTimeout(reidx));
    } catch {
      // 忽略
    }

    if (Number(cfg.scanIntervalSec) > 0) {
      try {
        const timer = setInterval(() => runScan('定时'), Number(cfg.scanIntervalSec) * 1000);
        timer.unref?.();
        ctx.effect(() => () => clearInterval(timer));
      } catch {
        // 忽略
      }
    }

    // ── 词向量（PPMI + SVD）定期重训 ─────────────────────────────────────
    //
    // 这套向量**目前不参与检索**（A/B 实测无提升，见 CHANGELOG 0.5.2），
    // 训练结果只写进 term_vectors 备查。所以：
    //   · 失败绝不能影响宿主 —— 全部包在 try/catch 里
    //   · 不在启动时立刻跑，挪到 60 秒后（启动那阵子别跟宿主抢 CPU）
    //   · 全量训练约 700ms，异步且不阻塞
    if (Number(cfg.vectorTrainIntervalSec) > 0) {
      const trainVectors = (reason) => {
        try {
          if (disabled || !vault || vault.scanning) return;
          vault
            .trainVectorsAsync()
            .then((r) => {
              if (r?.skipped) return;
              log(`词向量已训练（${reason}）：${r.saved} 个词 × ${r.dim} 维，耗时 ${r.totalMs}ms`);
            })
            .catch((error) => log(`词向量训练失败：${String(error)}`, 'warn'));
        } catch (error) {
          log(`词向量训练触发失败：${String(error)}`, 'warn');
        }
      };
      try {
        const first = setTimeout(() => trainVectors('启动'), 60000);
        first.unref?.();
        ctx.effect(() => () => clearTimeout(first));

        const timer = setInterval(() => trainVectors('定时'), Number(cfg.vectorTrainIntervalSec) * 1000);
        timer.unref?.();
        ctx.effect(() => () => clearInterval(timer));
      } catch {
        // 忽略
      }
    }

    // ── 应用配置里的 mute / pin ───────────────────────────────────────────
    try {
      for (const term of cfg.mutedTerms) vault?.patchTerm(String(term), { muted: true });
      for (const item of cfg.pinnedTerms) {
        const [term, weight] = String(item).split(':');
        const w = Number(weight);
        if (term && Number.isFinite(w)) vault?.patchTerm(term, { pinned: w });
      }
    } catch (error) {
      debug(`应用关键词配置失败：${String(error)}`);
    }

    // ── 把设置页里的分会话策略同步进数据库 ────────────────────────────────
    //
    // 这是「设置页能改会话开关」的落地方式：DSH 会根据 Config 的 z.dict 自动生成
    // 可编辑表单，插件在启动和保存设置时把这些字典写进 sessions 表。
    // 好处是不用自己写设置页 UI；代价是它是一张「会话 id → 策略」的映射，
    // 需要先用 memory_sessions 工具查到 id。
    const syncPolicyFromConfig = () => {
      try {
        if (!vault) return;
        const wsStore = cfg.workspaceStore ?? {};
        const wsRead = cfg.workspaceRead ?? {};
        for (const ws of new Set([...Object.keys(wsStore), ...Object.keys(wsRead)])) {
          vault.setWorkspace({
            workspace: ws,
            storeDefault: wsStore[ws] ?? 'store',
            readDefault: wsRead[ws] ?? 'off',
          });
        }
        const sessStore = cfg.sessionStore ?? {};
        const sessRead = cfg.sessionRead ?? {};
        for (const sid of new Set([...Object.keys(sessStore), ...Object.keys(sessRead)])) {
          vault.setSession({
            sessionId: sid,
            storeMode: sessStore[sid] ?? 'inherit',
            readMode: sessRead[sid] ?? 'inherit',
          });
        }
        debug('分会话策略已按配置同步');
      } catch (error) {
        log(`分会话策略同步失败：${String(error)}`, 'warn');
      }
    };

    // 启动后同步一次；设置页保存后再同步
    const syncTimer = setTimeout(syncPolicyFromConfig, 2000);
    syncTimer.unref?.();
    try {
      ctx.on('settings/document-updated', () => {
        try {
          syncPolicyFromConfig();
        } catch {
          // 忽略
        }
      });
    } catch {
      debug('settings/document-updated 钩子不可用，设置页改动需重启生效');
    }
  }

  /** 写入某 agent 本轮提示。 */
  function setHint(agent, value) {
    if (agent && typeof agent === 'object') agentState.set(agent, value);
    lastHint = value;
  }

  /** 子智能体不注入记忆，避免污染。 */
  function isSubagent(agent) {
    const depth = Number(agent?.delegationDepth ?? 0);
    return Number.isFinite(depth) && depth > 0;
  }

  // 初始化失败时留个可见但不打扰的痕迹
  if (initError) {
    try {
      ctx.logger?.warn?.(`[session-vault] 未启用：${String(initError)}`);
    } catch {
      // 忽略
    }
  }

  // 启动耗时埋点：只在慢的时候说一声，正常时不占日志。
  // 用户反馈"每次打开 DSH 很慢"时，日志里能直接看出是不是这个插件造成的。
  const bootMs = Date.now() - bootStartedAt;
  if (bootMs > 500) {
    log(`插件初始化耗时 ${bootMs}ms（打开库 ${vault?.openMs ?? '-'}ms）`, 'warn');
  } else {
    debug(`插件初始化耗时 ${bootMs}ms（打开库 ${vault?.openMs ?? '-'}ms）`);
  }
}
