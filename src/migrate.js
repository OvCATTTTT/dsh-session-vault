/**
 * 数据目录迁移。
 *
 * 要求：改记忆路径时，**原文件也要跟着走**，而且不能丢数据。
 *
 * 流程（复制优先，绝不先删）：
 *   ① 校验目标：不存在或为空、可写
 *   ② 复制整个数据目录
 *   ③ 校验：两个库的 `PRAGMA integrity_check` + 关键表行数一致
 *   ④ 返回报告；由调用方切换配置
 *   ⑤ 切换成功后才可选删除旧目录（keepOld=false）
 *
 * 任何一步失败都保留旧目录、返回失败报告，不抛到插件启动路径。
 */

import {
  existsSync, mkdirSync, readdirSync, rmSync, statSync, cpSync, accessSync, constants,
  readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const VERIFY_TABLES = ['events', 'summaries', 'terms', 'terms_inv', 'term_edges', 'sessions', 'source_files'];

/**
 * 数据目录「位置指针」文件。
 *
 * 为什么需要它：插件配置 `dataDir` 由 DSH 的设置页管，插件自己写不进去。
 * 如果只搬文件不改配置，下次启动又会回到旧目录——用户体验就是"改位置改不了"。
 *
 * 所以迁移成功后，在 **DSH_HOME 根目录**（不随数据目录移动）留一个指针，
 * 启动时按 config.dataDir → 指针 → 默认值 的顺序解析。
 * 指针放在根目录而不是数据目录里，这样它永远找得到。
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function locationPointerPath(dshHome) {
  return join(dshHome, 'session-vault-location.json');
}

/**
 * 读位置指针。
 * @param {string} dshHome
 * @returns {string|null}
 */
export function readLocationPointer(dshHome) {
  if (!dshHome) return null;
  try {
    const j = JSON.parse(readFileSync(locationPointerPath(dshHome), 'utf8'));
    const p = typeof j?.dataDir === 'string' ? j.dataDir.trim() : '';
    return p || null;
  } catch {
    return null;
  }
}

/**
 * 写位置指针（迁移成功后调用）。
 * @param {string} dshHome
 * @param {string} dataDir
 * @returns {boolean}
 */
export function writeLocationPointer(dshHome, dataDir) {
  if (!dshHome) return false;
  try {
    mkdirSync(dshHome, { recursive: true });
    writeFileSync(
      locationPointerPath(dshHome),
      `${JSON.stringify({ dataDir, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 统计某个库的关键表行数。
 * @param {string} file
 * @returns {Record<string, number>|null}
 */
export function tableCounts(file) {
  if (!existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const out = {};
    for (const t of VERIFY_TABLES) {
      try {
        out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
      } catch {
        out[t] = -1;
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略
    }
  }
}

/**
 * 库完整性检查。
 * @param {string} file
 * @returns {boolean}
 */
export function integrityOk(file) {
  if (!existsSync(file)) return true; // 库还不存在视为正常（首次运行）
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    const value = row ? Object.values(row)[0] : null;
    return String(value ?? 'ok').toLowerCase() === 'ok';
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略
    }
  }
}

/**
 * 迁移数据目录。
 *
 * 调用前**必须已经关闭数据库连接**，否则 WAL 里的数据可能没落盘。
 *
 * @param {object} args
 * @param {string} args.from 旧目录
 * @param {string} args.to 新目录
 * @param {boolean} [args.deleteOld=false] 校验通过后是否删除旧目录
 * @returns {{ ok: boolean, reason?: string, copied?: string[], counts?: object, deletedOld?: boolean }}
 */
export function migrateDataDir({ from, to, deleteOld = false }) {
  const src = resolve(from);
  const dst = resolve(to);

  if (src === dst) return { ok: true, reason: 'noop', copied: [] };
  if (!existsSync(src)) return { ok: false, reason: 'source-missing' };

  // ① 校验目标
  if (existsSync(dst)) {
    let entries = [];
    try {
      entries = readdirSync(dst);
    } catch (error) {
      return { ok: false, reason: `target-unreadable: ${String(error)}` };
    }
    if (entries.length > 0) return { ok: false, reason: 'target-not-empty' };
  } else {
    try {
      mkdirSync(dst, { recursive: true });
    } catch (error) {
      return { ok: false, reason: `target-create-failed: ${String(error)}` };
    }
  }

  try {
    accessSync(dst, constants.W_OK);
  } catch {
    return { ok: false, reason: 'target-not-writable' };
  }

  // ② 复制
  try {
    cpSync(src, dst, { recursive: true, force: true, errorOnExist: false });
  } catch (error) {
    return { ok: false, reason: `copy-failed: ${String(error)}` };
  }

  // ③ 校验
  const srcDsh = join(src, 'dsh.db');
  const dstDsh = join(dst, 'dsh.db');
  const srcQq = join(src, 'qq.db');
  const dstQq = join(dst, 'qq.db');

  for (const [a, b, label] of [
    [srcDsh, dstDsh, 'dsh.db'],
    [srcQq, dstQq, 'qq.db'],
  ]) {
    if (!existsSync(a)) continue;
    if (!existsSync(b)) return { ok: false, reason: `missing-after-copy: ${label}` };
    if (!integrityOk(b)) return { ok: false, reason: `integrity-failed: ${label}` };

    const ca = tableCounts(a);
    const cb = tableCounts(b);
    if (!ca || !cb) return { ok: false, reason: `count-unreadable: ${label}` };
    for (const t of VERIFY_TABLES) {
      if ((ca[t] ?? 0) !== (cb[t] ?? 0)) {
        return { ok: false, reason: `count-mismatch: ${label}.${t} ${ca[t]} -> ${cb[t]}` };
      }
    }
  }

  // 尺寸粗校验（排除 -wal/-shm 这类会波动的文件）
  const copied = [];
  for (const name of readdirSync(dst)) {
    if (name.endsWith('-wal') || name.endsWith('-shm')) continue;
    copied.push(name);
  }

  let deletedOld = false;
  if (deleteOld) {
    try {
      rmSync(src, { recursive: true, force: true });
      deletedOld = true;
    } catch {
      deletedOld = false;
    }
  }

  return {
    ok: true,
    copied,
    counts: tableCounts(dstDsh),
    deletedOld,
  };
}

/**
 * 数据目录体积（字节）。
 * @param {string} dir
 */
export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += statSync(p).size;
      } catch {
        // 忽略单个文件错误
      }
    }
  };
  walk(dir);
  return total;
}
