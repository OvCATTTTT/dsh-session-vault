/**
 * 决定记忆库放在哪 —— 新装用户零配置，第一次就落到合适的盘上。
 *
 * 为什么需要这一层：
 *   · 记忆库只增不删，会长到 GB 级，默认压在系统盘（通常在 C）是隐患；
 *   · 但也不能写死 `D:\...` —— 换台没有 D 盘的机器就废了。
 *
 * 策略（按顺序）：
 *   1. 用户在配置里显式给了 dataDir → 听他的
 *   2. 有位置指针（上次定过 / 迁移过）→ 用它，**不再重新探测**
 *   3. 首次运行 → 探测：优先非系统盘（D/E/F/G），要求剩余空间够；
 *      都没有就回退 `<DSH_HOME>/session-vault`
 *   4. 选定后立刻写指针固化 —— 否则哪天 D 盘满了或者被拔走，数据会在盘之间"漂移"
 *
 * 探测只认「盘符存在 + 根目录可读 + 剩余空间 ≥ 阈值」，不区分固定盘/移动盘
 * （区分要调 Windows API，跨平台也得各写一套，不值得）。万一选到了移动盘，
 * 用户在设置页能看到实际路径并迁移。
 */

import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

/** 数据盘至少要留这么多才肯放（数据会长大，别一开始就贴着满盘）。 */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** 探测顺序：这些盘符里挑第一个可用的。C 不在里面 —— 那是系统盘。 */
export const EXTERNAL_DRIVES = ['D', 'E', 'F', 'G'];

/** 在非系统盘下统一用这个目录名，里面的子目录按插件分。 */
export const VAULT_DIRNAME = 'DSH_vault';

/** 数据目录子名（和插件同名，方便认）。 */
export const VAULT_SUBDIR = 'session-vault';

/**
 * 候选目录列表，按优先级排。
 * 最后一项永远是系统盘回退，保证函数一定有结果。
 *
 * @param {string} dshHome
 * @returns {Array<{ dir: string, kind: 'external'|'home', drive?: string }>}
 */
export function candidateDataDirs(dshHome) {
  const out = [];
  for (const d of EXTERNAL_DRIVES) {
    out.push({
      dir: `${d}:\\${VAULT_DIRNAME}\\${VAULT_SUBDIR}`,
      kind: 'external',
      drive: `${d}:`,
    });
  }
  out.push({ dir: join(dshHome, VAULT_SUBDIR), kind: 'home' });
  return out;
}

/**
 * 挑一个默认数据目录。纯函数（依赖可注入），方便单测。
 *
 * @param {string} dshHome
 * @param {{
 *   exists?: (p: string) => boolean,
 *   statfs?: (p: string) => { bavail: number|bigint, bsize: number|bigint },
 *   minFree?: number,
 * }} [opts]
 * @returns {{ dir: string, kind: 'external'|'home', drive?: string, reason: string, freeBytes?: number }}
 */
export function pickDataDir(dshHome, opts = {}) {
  const exists = opts.exists ?? existsSync;
  const statfs = opts.statfs ?? statfsSync;
  const minFree = Number.isFinite(opts.minFree) ? opts.minFree : MIN_FREE_BYTES;

  const home = candidateDataDirs(dshHome).at(-1);

  for (const c of candidateDataDirs(dshHome)) {
    if (c.kind === 'home') break; // 回退项留到最后
    if (!c.drive) continue;
    try {
      if (!exists(`${c.drive}\\`)) continue;
      const st = statfs(`${c.drive}\\`);
      const free = Number(st.bavail) * Number(st.bsize);
      if (!Number.isFinite(free)) continue;
      if (free < minFree) continue;
      return {
        dir: c.dir,
        kind: 'external',
        drive: c.drive,
        reason: `${c.drive} 剩余 ${(free / 1024 ** 3).toFixed(1)} GB，数据放这里不占系统盘`,
        freeBytes: free,
      };
    } catch {
      // 盘符可读但 statfs 失败（网络盘/权限），跳过
      continue;
    }
  }

  return {
    dir: home.dir,
    kind: 'home',
    reason: '没有可用的非系统盘，放回 DSH_HOME',
  };
}

/**
 * 解析最终的数据目录。**这是唯一该被信任的入口。**
 *
 * 优先级：用户显式配置 > 位置指针 > 自动探测。
 *
 * ⚠️ 关键教训（0.4.8–0.4.10 的真实 bug，用户实际踩到）：
 * `normalizeConfig()` 会把 `defaults()` 里的 `dataDir` 填进 `cfg.dataDir`，
 * 所以 `cfg.dataDir` **永远非空**。如果解析时直接看 `cfg.dataDir`，
 * 「配置里没写」和「配置里写了 C 盘」就分不出来 —— 指针和探测永远被跳过，
 * 表现就是"改了半天默认位置，重启后还在老地方"。
 * 所以这里必须看 **rawDataDir（用户原样填的）**，不是归一化后的 cfg。
 *
 * @param {{
 *   dshHome: string,
 *   rawDataDir?: string,
 *   pointer?: string|null,
 *   pick?: (dshHome: string) => { dir: string, reason?: string },
 * }} args
 * @returns {{ dir: string, source: 'config'|'pointer'|'auto', reason?: string }}
 */
export function resolveDataDir({ dshHome, rawDataDir = '', pointer = null, pick = pickDataDir }) {
  const raw = String(rawDataDir ?? '').trim();
  if (raw) {
    return { dir: raw, source: 'config', reason: '配置里显式指定' };
  }
  const ptr = String(pointer ?? '').trim();
  if (ptr) {
    return { dir: ptr, source: 'pointer', reason: '沿用上次选定的位置' };
  }
  const picked = pick(dshHome);
  return { dir: picked.dir, source: 'auto', reason: picked.reason };
}
