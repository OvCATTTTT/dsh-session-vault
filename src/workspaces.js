/**
 * 工作区显示名。
 *
 * DSH 左侧栏显示的是「工作区 / 微信会话 / QQ 聊天」这样的**标题**，不是路径。
 * 这个标题存在 `$DSH_HOME/storages/workspace.json` 里：
 *
 *   tables.workspaces[<id>] = { path: 'D:\\work\\project', title: '工作区', ... }
 *
 * 所以按 `sessions.workspace`（就是那个 path）反查 title 即可。
 * 查不到就退回路径最后一段（`D:\\DSH` → `DSH`），总比整条路径好认。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 路径归一化，用于匹配。Windows 下大小写和分隔符都可能不一致。
 * @param {string} p
 * @returns {string}
 */
export function normalizeWorkspacePath(p) {
  return String(p ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 读 DSH 的工作区表，返回 `归一化路径 -> 标题`。
 * 文件不存在或格式异常时返回空 Map（插件其余功能不受影响）。
 *
 * @param {string} dshHome
 * @returns {Map<string, string>}
 */
export function loadWorkspaceTitles(dshHome) {
  const map = new Map();
  if (!dshHome) return map;
  try {
    const raw = readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8');
    const json = JSON.parse(raw);
    const table = json?.tables?.workspaces ?? {};
    for (const id of Object.keys(table)) {
      const entry = table[id];
      const path = String(entry?.path ?? '').trim();
      const title = String(entry?.title ?? '').trim();
      if (path && title) map.set(normalizeWorkspacePath(path), title);
    }
  } catch {
    // 没有这个文件（比如在测试环境里跑）就当作没有标题
  }
  return map;
}

/**
 * 取一个工作区的显示名。查不到标题时退回路径最后一段。
 *
 * @param {string} path
 * @param {Map<string, string>} titles
 * @returns {string}
 */
export function workspaceTitleOf(path, titles) {
  const p = String(path ?? '').trim();
  if (!p) return '（未知工作区）';
  const hit = titles?.get(normalizeWorkspacePath(p));
  if (hit) return hit;
  const seg = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return seg || p;
}
