/**
 * 扩展钩子（public API）。
 *
 * 目的：让「以后要加的功能」插进来，而不是改核心流程。所有钩子都是**同步 + 可失败**：
 * 任何第三方钩子抛错都只记一条日志然后跳过，绝不影响检索和入库。
 *
 * 用法：
 *   import { on, HOOK, registerRanker } from 'dsh-session-vault/core';
 *
 *   // 入库前脱敏
 *   const off = on(HOOK.INGEST_BEFORE_INSERT, (payload) => {
 *     payload.row.text = payload.row.text.replace(/138\d{8}/g, '[手机号]');
 *   });
 *
 *   // 检索后重排（比如让主人私聊的片段加权）
 *   registerRanker(({ db, query }) => new Map([[42, 0.2]]));
 *
 *   off(); // 取消
 *
 * 钩子清单与语义见 docs/extending.md。
 */

/** 全部钩子名。拼写错误会抛错而不是静默失效。 */
export const HOOK = Object.freeze({
  /** 入库前逐行调用。可改 `payload.row.text`；返回 `false` 表示丢弃这一行。 */
  INGEST_BEFORE_INSERT: 'ingest:beforeInsert',
  /** 一个会话文件导入完成后。`payload` 是统计对象，只读。 */
  INGEST_AFTER_IMPORT: 'ingest:afterImport',
  /** 摘要生成后、入库前。可改 `payload.summary.body` / `title`。 */
  SUMMARY_BEFORE_INSERT: 'summary:beforeInsert',
  /** 门控开始前。可改 `payload.query`（例如做同义扩展）。 */
  RECALL_BEFORE_QUERY: 'recall:beforeQuery',
  /** 门控得到结果后、返回给调用方前。可增删/重排 `payload.hits`。 */
  RECALL_AFTER_GATE: 'recall:afterGate',
  /** 渲染注入提示前。可改 `payload.text`。 */
  HINT_BEFORE_RENDER: 'hint:beforeRender',
  /** 开关状态变化时。`payload` = { name, on }。 */
  SWITCH_CHANGED: 'switch:changed',
});

/** 钩子名 → 处理器集合。 */
const registry = new Map();

/** 排序器：`(ctx) => Map<summaryId, boost>` */
const rankers = [];

/**
 * 注册钩子。
 * @param {string} name HOOK 里的值
 * @param {(payload: any) => any} handler
 * @returns {() => void} 取消函数
 */
export function on(name, handler) {
  if (!Object.values(HOOK).includes(name)) {
    throw new Error(`session-vault: 未知钩子 "${name}"。可用：${Object.values(HOOK).join(', ')}`);
  }
  if (typeof handler !== 'function') {
    throw new Error('session-vault: 钩子处理器必须是函数');
  }
  if (!registry.has(name)) registry.set(name, new Set());
  registry.get(name).add(handler);
  return () => {
    registry.get(name)?.delete(handler);
  };
}

/**
 * 触发钩子。
 *
 * 处理器可以：
 *   · 修改 `payload` 上的字段（原地生效）
 *   · 返回 `false` 表达「丢弃这一条」（只有部分钩子认这个返回值）
 *   · 返回其它值会被忽略
 *
 * 任何一个处理器抛错都只记录并继续，绝不让整个流程失败。
 *
 * @param {string} name
 * @param {any} payload
 * @param {(err: unknown, name: string) => void} [onError]
 * @returns {any} payload（可能被改过）
 */
export function emit(name, payload, onError) {
  const set = registry.get(name);
  if (!set || set.size === 0) return payload;
  for (const handler of [...set]) {
    try {
      const ret = handler(payload);
      // 处理器返回 false 表示「丢弃这一条」；换成 payload.drop 让调用方统一判断
      if (ret === false) payload.drop = true;
    } catch (error) {
      try {
        onError?.(error, name);
      } catch {
        // 连错误回调都坏了就彻底放弃
      }
    }
  }
  return payload;
}

/**
 * 注册一个排序器。返回值是 `Map<summaryId, 加分>`，加分会叠加到 0~1 的分数上。
 *
 * 排序器在每次门控时调用一次；抛错会被忽略（当作没有这个排序器）。
 *
 * @param {(ctx: { db: object, query: string, seedTerms: string[], total: number }) => Map<number, number>|void} fn
 * @returns {() => void} 取消函数
 */
export function registerRanker(fn) {
  if (typeof fn !== 'function') throw new Error('session-vault: ranker 必须是函数');
  rankers.push(fn);
  return () => {
    const i = rankers.indexOf(fn);
    if (i >= 0) rankers.splice(i, 1);
  };
}

/**
 * 计算一次排序加成。
 * @param {{ db: object, query: string, seedTerms: string[], total: number }} ctx
 * @returns {Map<number, number>}
 */
export function collectBoosts(ctx) {
  /** @type {Map<number, number>} */
  const boost = new Map();
  if (rankers.length === 0) return boost;
  for (const fn of [...rankers]) {
    try {
      const delta = fn(ctx);
      if (delta instanceof Map) {
        for (const [id, v] of delta) {
          if (!Number.isFinite(v)) continue;
          boost.set(id, (boost.get(id) ?? 0) + v);
        }
      }
    } catch {
      // 排序器坏了就当它不存在
    }
  }
  return boost;
}

/** 诊断：当前注册情况。 */
export function listHooks() {
  const out = {};
  for (const [name, set] of registry) out[name] = set.size;
  return { hooks: out, rankers: rankers.length };
}

/** 测试用：清空所有钩子与排序器。 */
export function clearHooks() {
  registry.clear();
  rankers.length = 0;
}
