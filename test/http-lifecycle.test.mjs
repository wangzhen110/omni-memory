// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * HTTP daemon 生命周期边界的自动测试。
 *
 * 在临时 home 上用 startHttpServer 起真实 ephemeral server，覆盖：
 *   1. ephemeral 端口启动 → /health 200 → close() → 用同一具体端口重启 → 再次 200；
 *   2. 端口被占用时第二个 startHttpServer 受控 reject（EADDRINUSE），第一个仍健康；
 *   3. 同一 home 顺序启动两个实例，A 写入并 close 后 B 能召回 A 的数据。
 *
 * 不碰生产库：OMNI_HOME / DSH_HOME 都指向临时目录；所有请求带超时；
 * 每个启动成功的 server 都在 finally 中 close。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let home;
let startHttpServer;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'omni-http-lc-'));
  // index.js 在求值时解析 store 路径；必须在动态 import 之前把 home 指到临时目录。
  process.env.OMNI_HOME = home;
  process.env.DSH_HOME = home;
  process.env.OMNI_DISABLE_SEMANTIC = '1';
  ({ startHttpServer } = await import('../hosts/http/server.mjs'));
});

after(async () => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function timed(ms = 8000) {
  return AbortSignal.timeout(ms);
}

// fetch 默认复用 keep-alive 连接；同一端口重启后可能命中上一实例的陈旧 socket。
// connection: close 让每次请求各自断开，避免测试偶发失败。
const REQ_HEADERS = { 'content-type': 'application/json', connection: 'close' };

async function assertHealthy(url, message = '/health 应返回 200') {
  const res = await fetch(`${url}/health`, { headers: { connection: 'close' }, signal: timed() });
  assert.equal(res.status, 200, message);
  const body = await res.json();
  assert.equal(body.ok, true, message);
  return body;
}

async function mcpInit(url) {
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]) {
    await fetch(`${url}/mcp`, {
      method: 'POST', headers: REQ_HEADERS, body: JSON.stringify(body), signal: timed(),
    });
  }
}

async function writeNote(url, text) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: REQ_HEADERS,
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

async function search(url, q) {
  const res = await fetch(`${url}/omni-memory/search?q=${encodeURIComponent(q)}`, {
    headers: { connection: 'close' }, signal: timed(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  return body.hits ?? [];
}

test('ephemeral port -> health -> close -> restart on the same concrete port', async () => {
  let first;
  let second;
  try {
    first = await startHttpServer({ workdir: root, port: 0, version: 'lc', log: () => {} });
    const port = first.port;
    assert.ok(port > 0, 'ephemeral 端口应解析为具体正整数');
    await assertHealthy(first.url);

    await first.close();
    first = null;

    second = await startHttpServer({ workdir: root, port, version: 'lc', log: () => {} });
    assert.equal(second.port, port, '重启应绑定到完全相同的端口');
    await assertHealthy(second.url, '同一端口重启后 /health 应再次 200');
  } finally {
    if (first) await first.close();
    if (second) await second.close();
  }
});

test('occupied port: second startHttpServer rejects in a controlled way, first stays healthy', async () => {
  let first;
  try {
    first = await startHttpServer({ workdir: root, port: 0, version: 'lc', log: () => {} });
    const port = first.port;
    await assertHealthy(first.url);

    // 第二个实例尝试绑定已被占用的端口：startHttpServer 内部是
    // `server.once('error', reject); server.listen(...)`，因此应受控 reject，
    // 而不是抛出未捕获异常。
    await assert.rejects(
      startHttpServer({ workdir: root, port, version: 'lc', log: () => {} }),
      err => {
        assert.ok(err instanceof Error, '应以 Error 拒绝');
        assert.ok(
          err.code === 'EADDRINUSE' || /EADDRINUSE|address already in use|port.*in use/i.test(String(err.message)),
          `拒绝原因应为端口占用，实际：${err?.code} ${err?.message}`,
        );
        return true;
      },
      '第二个实例在同一端口必须受控失败',
    );

    await assertHealthy(first.url, '失败启动后第一个服务应仍健康');
  } finally {
    if (first) await first.close();
  }
});

test('HTTP /tool resolves the boot workdir project layer, same as MCP', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = `HTTP工具落层 ${nonce}`;
  let server;
  try {
    server = await startHttpServer({ workdir: root, port: 0, version: 'lc', log: () => {} });
    const write = await fetch(`${server.url}/omni-memory/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-omni-csrf': '1', connection: 'close' },
      body: JSON.stringify({ name: 'memory_write', arguments: { kind: 'note', text: marker } }),
      signal: timed(),
    });
    assert.equal(write.status, 200);
    const body = await write.json();
    assert.match(String(body.value.scope), /^proj:/, 'HTTP /tool must land in the boot project layer');

    const search = async scope => {
      const res = await fetch(`${server.url}/omni-memory/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-omni-csrf': '1', connection: 'close' },
        body: JSON.stringify({ name: 'memory_search', arguments: { query: nonce, ...(scope ? { scope } : {}) } }),
        signal: timed(),
      });
      assert.equal(res.status, 200);
      return (await res.json()).value.hits ?? [];
    };
    assert.ok((await search()).some(hit => String(hit.text).includes(nonce)), 'default search should see the project note');
    assert.equal((await search('global')).length, 0, 'global search must not see a project-only note');
  } finally {
    if (server) await server.close();
  }
});

test('sequential instances share one home: A writes, closes, B recalls the data', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = `生命周期落盘回召验证 ${nonce}`;
  let a;
  let b;
  try {
    a = await startHttpServer({ workdir: root, port: 0, version: 'lc', log: () => {} });
    await mcpInit(a.url);
    const noteId = await writeNote(a.url, marker);
    assert.ok(noteId, 'A 应写入一条 note');
    assert.ok(
      (await search(a.url, marker)).some(hit => String(hit.text).includes(nonce)),
      'A 应能召回自己写入的 note',
    );

    // 顺序关闭后再启动，避免两个进程同时写同一个 SQLite 库。
    await a.close();
    a = null;

    b = await startHttpServer({ workdir: root, port: 0, version: 'lc', log: () => {} });
    await assertHealthy(b.url);
    const hits = await search(b.url, marker);
    assert.ok(
      hits.some(hit => String(hit.text).includes(nonce)),
      'B 重启后应能召回 A 已落盘的数据',
    );
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }
});
