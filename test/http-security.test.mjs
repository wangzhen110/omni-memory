// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * HTTP 适配层安全边界的自动测试。
 *
 * 全部在临时 DSH_HOME 上用 startHttpServer 起真实的 ephemeral server，
 * 绝不碰生产库。覆盖：
 *   1. 静态路径穿越变体不会泄漏项目文件；
 *   2. 非 loopback 的变更请求在数据被触碰之前就被拒绝；
 *   3. CSRF/Origin 变体（ evil Origin、缺 CSRF 头 ）被拒绝，同源 + CSRF 成功；
 *   4. 畸形 / 超大请求体不拖垮服务，后续健康路由仍 200。
 *
 * 说明：非 loopback 无法靠普通 fetch 从 127.0.0.1 产生（服务端只看
 * socket.remoteAddress），因此用本地 127.0.0.2 作为源地址发原始 HTTP 请求，
 * 让 isLoopback() 真实地看到非 loopback 对端。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// package.json 独有的内容标记；穿越成功时会在响应体里出现。
const PROJECT_FILE_MARKERS = [/"name"\s*:\s*"@local\/omni-memory"/, /"private"\s*:\s*true/];

let ctx;
let home;
let base;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'omni-http-sec-'));
  // index.js 在求值时解析 store 路径，OMNI_HOME 优先于 DSH_HOME；
  // 两个都指向临时目录，确保测试永远不会落到真实 ~/.dsh。
  process.env.OMNI_HOME = home;
  process.env.DSH_HOME = home;
  process.env.OMNI_DISABLE_SEMANTIC = '1';

  const { startHttpServer } = await import('../hosts/http/server.mjs');
  ctx = await startHttpServer({ workdir: root, port: 0, version: 'sec', log: () => {} });
  base = ctx.url;
  await mcpInit();
});

after(async () => {
  try {
    if (ctx) await ctx.close();
  } finally {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** 统一的超时信号，避免任何请求把测试挂死。 */
function timed(ms = 8000) {
  return AbortSignal.timeout(ms);
}

/** 初始化 MCP 会话，便于用 memory_write 写入可验证的数据。 */
async function mcpInit() {
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]) {
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: timed(),
    });
  }
}

/** 写一条全局 note，返回其数字 id。 */
async function writeNote(text) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'memory_write', arguments: { kind: 'note', text, scope: 'global' } },
    }),
    signal: timed(),
  });
  const body = await res.json();
  const rendered = body?.result?.content?.[0]?.text ?? '';
  const match = /stored note #(\d+)/.exec(rendered);
  assert.ok(match, `memory_write 未返回 note id：${JSON.stringify(body)}`);
  return match[1];
}

/** 通过真实 REST 搜索路由验证某条记忆是否仍可召回。 */
async function search(text) {
  const res = await fetch(`${base}/omni-memory/search?q=${encodeURIComponent(text)}`, { signal: timed() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.hits ?? [];
}

/** 极简 chunked 解码，仅在原始响应用到 transfer-encoding 时调用。 */
function dechunk(text) {
  const out = [];
  let rest = text;
  while (rest.length) {
    const at = rest.indexOf('\r\n');
    if (at < 0) break;
    const size = Number.parseInt(rest.slice(0, at), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(rest.slice(at + 2, at + 2 + size));
    rest = rest.slice(at + 2 + size + 2);
  }
  return out.join('');
}

/**
 * 发原始 HTTP 请求。相对于 fetch 的好处是 target 不会被 URL 规范化，
 * 且能指定 localAddress 来伪造非 loopback 对端。
 */
function rawRequest({ target, method = 'GET', headers = {}, body = '', localAddress }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: ctx.port, ...(localAddress ? { localAddress } : {}) });
    const chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(10000, () => finish(new Error('raw request timeout')));
    socket.on('error', err => finish(err));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split >= 0 ? text.slice(0, split) : text;
      let payload = split >= 0 ? text.slice(split + 4) : '';
      if (/transfer-encoding:\s*chunked/i.test(head)) payload = dechunk(payload);
      const statusLine = head.split('\r\n')[0] ?? '';
      const match = /HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine);
      finish(null, { status: match ? Number(match[1]) : 0, body: payload });
    });
    socket.on('connect', () => {
      const host = String(headers.host ?? `127.0.0.1:${ctx.port}`);
      const extra = Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'host');
      const lines = [
        `${method} ${target} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: close',
        ...extra.map(([key, value]) => `${key}: ${value}`),
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ];
      // 不能在此 socket.end()：serveStatic 走异步 stat()，若此时半关闭写端，
      // 服务端在异步回调里写响应会失败，客户端收到空响应。让服务端用
      // Connection: close 主动结束连接。
      socket.write(lines.join('\r\n') + body);
    });
  });
}

test('forged Host cannot read the export or search surfaces', async () => {
  for (const target of ['/omni-memory/export', '/omni-memory/search?q=HostProbe', '/omni-memory/status']) {
    const response = await rawRequest({ target, headers: { host: 'attacker.example' } });
    assert.equal(response.status, 403, `${target} must reject a rebinding Host`);
    assert.match(response.body, /forbidden|error/i, `${target} must return an error payload`);
  }
});

test('export is a GET-only surface', async () => {
  const response = await rawRequest({
    target: '/omni-memory/export',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omni-csrf': '1' },
    body: '{}',
  });
  assert.equal(response.status, 405);
  assert.match(response.body, /export requires GET/);
});

test('health, metrics, rules and static pages reject non-loopback peers', async () => {
  for (const target of ['/health', '/metrics', '/rules', '/', '/index.html']) {
    const response = await rawRequest({ target, localAddress: '127.0.0.2' });
    assert.equal(response.status, 403, `${target} must not be readable from a LAN peer`);
  }
});

test('static path traversal variants are rejected without leaking project files', async () => {
  // 既包含会被 new URL() 规范化的形式，也包含保留编码、真正命中
  // serveStatic 的 `name.includes("..")` 分支的形式。
  const variants = [
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/package.json',
    '/..%2fpackage.json',
    '/a/../../package.json',
    '/..\\package.json',
    '/..\\..\\package.json',
    '/..%5cpackage.json',
    '/%2e%2e%5cpackage.json',
    '/....//package.json',
  ];

  for (const target of variants) {
    const res = await rawRequest({ target });
    assert.ok(
      res.status === 403 || res.status === 404,
      `${target} 应被拒绝，实际 ${res.status}`,
    );
    for (const marker of PROJECT_FILE_MARKERS) {
      assert.doesNotMatch(res.body, marker, `${target} 的响应体泄漏了项目文件内容`);
    }
  }
});

test('non-loopback POST mutation is refused before any data change', async () => {
  const marker = `远程遗忘-${Date.now()}`;
  const id = await writeNote(marker);
  assert.ok((await search(marker)).length >= 1, '前置条件：note 应可召回');

  // 即使带上正确的 CSRF 头，非 loopback 也必须被 isLoopback() 挡在变更之前。
  const res = await rawRequest({
    target: `/omni-memory/forget?kind=note&id=${id}`,
    method: 'POST',
    localAddress: '127.0.0.2',
    headers: { 'content-type': 'application/json', 'x-omni-csrf': '1' },
    body: '{}',
  });
  assert.equal(res.status, 403, '非 loopback 的变更请求应返回 403');
  assert.equal((await search(marker)).length, 1, 'note 必须仍可召回，数据未被改动');
});

test('CSRF/Origin variants: only same-origin plus x-omni-csrf mutates', async () => {
  const marker = `csrf-${Date.now()}`;
  const id = await writeNote(marker);
  const target = `${base}/omni-memory/forget?kind=note&id=${id}`;
  const goodOrigin = `http://127.0.0.1:${ctx.port}`;
  const post = (headers) => fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
    signal: timed(),
  });

  // evil Origin，有 / 无 CSRF 头：sameOrigin() 直接否决。
  assert.equal((await post({ origin: 'https://evil.example', 'x-omni-csrf': '1' })).status, 403);
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  // 正确 Origin 但缺 CSRF 头：mutationAllowed() 否决。
  assert.equal((await post({ origin: goodOrigin })).status, 403);
  // 上述拒绝都没有改动数据。
  assert.equal((await search(marker)).length, 1);

  // 正确 loopback Origin + CSRF 头：遗忘成功，且搜索不再召回。
  const ok = await post({ origin: goodOrigin, 'x-omni-csrf': '1' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).forgotten, true);
  assert.equal((await search(marker)).length, 0, '遗忘后不应再被搜索召回');
});

test('forged Host cannot authenticate a matching Origin', async () => {
  const marker = `dns-rebind-${Date.now()}`;
  const id = await writeNote(marker);

  const forge = await rawRequest({
    target: `/omni-memory/forget?kind=note&id=${id}`,
    method: 'POST',
    headers: {
      host: 'attacker.example',
      origin: 'http://attacker.example',
      'content-type': 'application/json',
      'x-omni-csrf': '1',
    },
    body: '{}',
  });
  assert.equal(forge.status, 403, 'a non-loopback Host must not authenticate its own Origin');
  assert.equal((await search(marker)).length, 1, 'the forged request must not change data');

  const mcp = await rawRequest({
    target: '/mcp',
    method: 'POST',
    headers: {
      host: 'attacker.example',
      origin: 'http://attacker.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
  });
  assert.equal(mcp.status, 403, 'MCP must not accept a forged Host either');
});

test('malformed and oversized bodies are contained; server stays healthy', async (t) => {
  // 畸形 JSON：/mcp 明确返回 -32700 的受控错误。
  const bad = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":',
    signal: timed(),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error?.code, -32700);

  // 超大 body：超过 readBody 的 4MB 上限。真实实现是 reject 后 req.destroy()，
  // 因此客户端可能收到 4xx，也可能直接被断连；两种都算受控，只要服务不崩。
  let oversizeOutcome = 'no-response';
  try {
    const big = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 9, method: 'tools/call',
        params: { name: 'memory_write', arguments: { kind: 'note', text: 'x'.repeat(4 * 1024 * 1024 + 64) } },
      }),
      signal: timed(),
    });
    oversizeOutcome = `HTTP ${big.status}`;
    assert.ok(big.status >= 400 && big.status < 500, `超大 body 应返回 4xx，实际 ${big.status}`);
  } catch (err) {
    oversizeOutcome = `connection dropped: ${err.name}: ${err.message}`;
    assert.match(String(err.message), /(?:fetch failed|socket|terminated|reset|aborted|closed)/i);
  }

  // 关键断言：服务没崩，健康路由照常 200。
  const health = await fetch(`${base}/health`, { signal: timed() });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  t.diagnostic(`超大 body 结果：${oversizeOutcome}（实现为超限即断连，非显式 4xx）`);
});
