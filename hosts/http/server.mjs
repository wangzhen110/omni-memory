// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Standalone daemon: REST + Streamable HTTP MCP + a small web UI.
 *
 * The plugin's 13 HTTP routes already exist. Rather than rewriting them for a
 * standalone product, this server implements the one thing they ask for — a
 * `webServer` service with `register(route)` — and mounts them unchanged. Same
 * handlers, same validation, same loopback guard.
 *
 * MCP over HTTP reuses the protocol core from mcp/server.mjs, so a client gets
 * byte-identical answers whether it spoke stdio or HTTP.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootHost } from '../shared/boot.mjs';
import { createProtocol, RULES_URI } from '../mcp/server.mjs';
import { RULES_TEXT } from '../shared/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web');

const STATIC_CACHE = new Map();

// Extensionless product entry points. They are still served from WEB_DIR and
// still loopback-only; this is only a pretty-URL alias, not a new route surface.
const STATIC_ALIASES = Object.freeze({
  '/hub': 'hub.html',
  '/hub/': 'hub.html',
  '/m': 'm.html',
  '/m/': 'm.html',
});

export function staticAssetName(pathname) {
  if (pathname === '/') return 'index.html';
  return STATIC_ALIASES[pathname] ?? pathname.replace(/^\/+/, '');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

/** The same socket-only loopback check used by the REST routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Host names this process is willing to answer for (see index.js sameOrigin). */
function trustedHostNames() {
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  const add = raw => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value || value === '0.0.0.0' || value === '::' || value === '*') return;
    const hostname = value.startsWith('[')
      ? value.slice(1, value.indexOf(']'))
      : value.split(':')[0];
    if (hostname) names.add(hostname);
  };
  for (const item of String(process.env.OMNI_TRUSTED_HOSTS ?? '').split(',')) add(item);
  add(process.env.OMNI_HTTP_BIND);
  return names;
}

function requestHostName(req) {
  const raw = String(req.headers?.host ?? '').trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function originAllowed(req) {
  if (String(req.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return true;
  const name = requestHostName(req);
  if (!name || !trustedHostNames().has(name)) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return parsed.host.toLowerCase() === String(req.headers?.host ?? '').trim().toLowerCase();
}

/**
 * Mutating MCP requests need the same protection as REST writes.
 *
 * A browser cannot send `application/json` cross-origin without a preflight,
 * and a form post can only send text/plain. Host and Origin are checked first;
 * an attacker who controls a DNS name cannot make its Host header trusted.
 */
function mcpMutationAllowed(req) {
  if (!originAllowed(req)) return false;
  if (String(req.headers?.['x-omni-csrf'] ?? '') === '1') return true;
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startHttpServer({
  workdir = process.cwd(),
  port = Number(process.env.OMNI_HTTP_PORT ?? 7788),
  bind = process.env.OMNI_HTTP_BIND || '127.0.0.1',
  version = '0.0.0',
  log = message => console.error(`[omni-http] ${message}`),
} = {}) {
  const startedAt = Date.now();
  const counters = { requests: 0, errors: 0, mcpRequests: 0, mcpMessages: 0 };
  const routes = [];
  const webServer = {
    register(route) {
      if (!route || typeof route.path !== 'string') return undefined;
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const { host, project, sessionId, toolContext } = await bootHost({
    workdir,
    services: { webServer },
  });

  const protocol = createProtocol({
    host,
    toolContext,
    serverInfo: { name: 'omni-memory', version },
    instructions: '全息记忆本地服务：REST 在 /omni-memory/*，MCP 在 POST /mcp，规则在 ' + RULES_URI + '。无 prompt hook 的宿主先取 GET /omni-memory/packet?q=<任务>，OpenAPI 在 /omni-memory/openapi.json。',
    rulesText: RULES_TEXT,
  });

  async function serveStatic(req, res, pathname) {
    const name = staticAssetName(pathname);
    if (name.includes('..')) return sendJson(res, 403, { ok: false, error: 'bad path' });

    const file = path.join(WEB_DIR, name);
    if (!file.startsWith(WEB_DIR)) return sendJson(res, 403, { ok: false, error: 'bad path' });

    try {
      const info = await stat(file);
      let entry = STATIC_CACHE.get(file);
      if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
        const body = await readFile(file);
        const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        // The star map is a single 650 KB HTML file with inlined WebGL code.
        // Cache the compressed body once per file version so repeat opens and
        // conditional revalidation do not re-read or re-compress it.
        entry = { mtimeMs: info.mtimeMs, size: info.size, body, etag, gzip: body.length > 1024 ? gzipSync(body, { level: 6 }) : null };
        STATIC_CACHE.set(file, entry);
      }
      const inm = req.headers['if-none-match'];
      if (inm && inm === entry.etag) {
        res.writeHead(304, { 'cache-control': 'no-cache', etag: entry.etag });
        res.end();
        return;
      }
      const type = MIME[path.extname(name)] ?? 'application/octet-stream';
      const useGzip = entry.gzip && /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        etag: entry.etag,
        ...(useGzip ? { 'content-encoding': 'gzip' } : {}),
      });
      res.end(useGzip ? entry.gzip : entry.body);
    } catch {
      sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  async function serveMcp(req, res) {
    counters.mcpRequests += 1;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'use POST' }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `invalid JSON: ${err.message}` } });
      return;
    }

    const batch = Array.isArray(payload);
    const messages = batch ? payload : [payload];
    counters.mcpMessages += messages.length;
    const replies = [];

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        replies.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
        continue;
      }
      const reply = await protocol.handle(message);
      if (reply) replies.push({ jsonrpc: '2.0', ...reply });
    }

    if (!replies.length) {
      res.writeHead(202, { 'mcp-session-id': sessionId });
      res.end();
      return;
    }

    const body = batch ? replies : replies[0];
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'mcp-session-id': sessionId,
    });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    counters.requests += 1;
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${bind}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }

    const pathname = url.pathname;

    try {
      // Health/rules/static are read surfaces too. When the adapter is explicitly
      // bound to 0.0.0.0 they must not become an unauthenticated metadata leak.
      if ((pathname === '/health' || pathname === '/rules' || pathname === '/metrics' || pathname === '/') && !isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, version, project, sessionId, tools: host.tools.size() });
        return;
      }

      if (pathname === '/metrics') {
        const memory = process.memoryUsage();
        sendJson(res, 200, {
          ok: true,
          version,
          project,
          sessionId,
          pid: process.pid,
          node: process.version,
          startedAt: new Date(startedAt).toISOString(),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          requests: counters.requests,
          errors: counters.errors,
          mcpRequests: counters.mcpRequests,
          mcpMessages: counters.mcpMessages,
          tools: host.tools.size(),
          routes: routes.length,
          memory: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
          },
        });
        return;
      }

      if (pathname === '/rules') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
        res.end(RULES_TEXT);
        return;
      }

      if (pathname === '/mcp') {
        // /mcp exposes the whole tool surface. REST routes already require a
        // loopback peer; this route must not become the one unauthenticated
        // door when someone runs `omni serve --bind 0.0.0.0`.
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        if (req.method === 'POST' && !mcpMutationAllowed(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        await serveMcp(req, res);
        return;
      }

      const route = routes.find(item => item.kind === 'exact' && item.path === pathname);
      if (route) {
        await route.handler(req, res);
        return;
      }

      if (req.method === 'GET' && (pathname === '/' || STATIC_ALIASES[pathname] || MIME[path.extname(pathname)])) {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        await serveStatic(req, res, pathname);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      counters.errors += 1;
      log(`request failed ${pathname}: ${err?.message ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });

  const actual = server.address();
  const actualPort = typeof actual === 'object' && actual ? actual.port : port;
  log(`listening http://${bind}:${actualPort} · project ${project ?? 'global'} · ${host.tools.size()} tools · ${routes.length} routes`);

  return {
    host,
    project,
    sessionId,
    port: actualPort,
    url: `http://${bind}:${actualPort}`,
    routes: routes.length,
    close: () => new Promise(resolve => {
      server.close(() => {
        try { host.dispose(); } catch { /* best effort */ }
        resolve();
      });
    }),
  };
}
