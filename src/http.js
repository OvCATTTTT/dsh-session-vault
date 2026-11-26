/**
 * 设置页路由用的 HTTP 小工具（纯 Node，无依赖）。
 *
 * 这一层刻意写得很小：只做「判断请求是否可信」和「怎么回 JSON」，
 * 业务判断留在 routes.js。
 */

/**
 * 是否来自本机回环。
 *
 * 注意 `::ffff:127.0.0.1` 这种 IPv4-mapped 形式也会出现，要一起认。
 * @param {import('node:http').IncomingMessage} req
 */
export function isLoopback(req) {
  const addr = String(req?.socket?.remoteAddress ?? '');
  return addr === '127.0.0.1'
    || addr === '::1'
    || addr === '::ffff:127.0.0.1'
    || addr.startsWith('127.');
}

/**
 * 写操作的 Origin 是否同源。
 * 浏览器发起的跨站 POST 会带上目标之外的 Origin；非浏览器客户端通常不带，视为可信
 * （因为前面已经要求回环 + JSON content-type）。
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  const host = String(req?.headers?.host ?? '');
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

/**
 * 交给 DSH 自己的连接策略再拦一次。
 * @param {object} ctx
 * @param {import('node:http').IncomingMessage} req
 * @returns {number|false|undefined|null}
 */
export function rejectByConnection(ctx, req) {
  try {
    const conn = ctx?.get?.('connection');
    if (conn && typeof conn.requestRejection === 'function') {
      return conn.requestRejection(req);
    }
  } catch {
    // 拿不到就跳过这一层
  }
  return undefined;
}

/**
 * 回一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {object} body
 */
export function json(res, code, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload, 'utf8'),
  });
  res.end(payload);
}

/**
 * 读请求体（限制大小，防止被写爆内存）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=262144]
 * @returns {Promise<string>}
 */
export function readBody(req, maxBytes = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求体过大（>${maxBytes} 字节）`));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
