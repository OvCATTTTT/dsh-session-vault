#!/usr/bin/env node
/**
 * 设置页开发预览：起一个本地 HTTP 服务，把 dev/ui.html + /api/* 跑起来。
 *
 * 用途：先在这里把界面调好，再翻译成 lib/client.js 里的 h()。
 * 完整流程见 docs/ui-workflow.md。
 *
 *   1. 浏览器里改（http://127.0.0.1:<port>/dsh-session-vault/ui），
 *      不用把插件装进 DSH、也不用重启它。改 dev/ui.html 刷新即可。
 *   2. 配合无头 Edge 截图，验收浅色/深色两套视觉。
 *
 * 它复用真实的 src/routes.js（用一个假的 webServer 收集路由再挂到 http 上），
 * 所以测的是真路由，不是另一套玩具实现。
 *
 * 用法：
 *   node scripts/dev-ui.js --data <库目录> [--port 8790] [--sessions <会话目录>]
 */

import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

import { SessionVault } from '../src/core.js';
import { registerRoutes, API_PREFIX } from '../src/routes.js';

/** 调试页面（不随插件发布）。 */
const UI_FILE = join(import.meta.dirname, '..', 'dev', 'ui.html');
const UI_PATH = '/dsh-session-vault/ui';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', '8790'));
const dataDir = arg('data', join(tmpdir(), 'session-vault-dev'));
const sessionsRoot = arg('sessions', join(process.env.USERPROFILE ?? '.', '.dsh', 'sessions'));

const vault = new SessionVault({
  dataDir,
  sessionsRoot,
  log: (m) => console.log('  ·', m),
});
vault.open();

console.log('数据目录:', dataDir);
console.log('会话目录:', sessionsRoot);
console.log('正在扫描（首次会慢一些）…');
const t0 = Date.now();
const scan = await vault.scanAsync();
console.log(`扫描完成 ${Date.now() - t0}ms：+${scan.newEvents} 事件 / +${scan.newSummaries} 摘要`);

// 假 webServer：把路由收进 Map，再挂到真 http 上
const routes = new Map();
const fakeCtx = {
  webServer: {
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  },
  get: () => null,
};

const reg = registerRoutes(fakeCtx, {
  getVault: () => vault,
  getConfig: () => ({}),
  log: (m) => console.log('  !', m),
  getLastScan: () => scan,
});
console.log(`已注册 ${reg.registered} 条路由：`, [...routes.keys()].join(', '));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  // 调试页面：直接读 dev/ui.html（改完刷新即可，服务不用重启）
  if (url.pathname === UI_PATH) {
    let html;
    try {
      html = readFileSync(UI_FILE, 'utf8');
    } catch (error) {
      html = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px">`
        + `<h3>找不到 dev/ui.html</h3><p>${String(error?.message ?? error)}</p></body>`;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(html, 'utf8'),
    });
    res.end(html);
    return;
  }

  const handler = routes.get(url.pathname);
  if (handler) {
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      }
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`404 ${url.pathname}\n可用：\n${[...routes.keys()].join('\n')}`);
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log(`  设置页: http://127.0.0.1:${port}${UI_PATH}`);
  console.log(`  概览  : http://127.0.0.1:${port}${API_PREFIX}/overview`);
  console.log(`  会话  : http://127.0.0.1:${port}${API_PREFIX}/sessions`);
  console.log('');
  console.log('Ctrl+C 结束（库文件保留在数据目录里）');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    try {
      vault.close();
    } catch {
      // 忽略
    }
    process.exit(0);
  });
}
