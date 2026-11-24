// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The standalone daemon has to prove three things at once:
 *  - the plugin's own 21 routes mount unchanged through the `webServer` shim
 *  - MCP over HTTP answers with the same protocol objects as stdio
 *  - the panel is actually served
 *
 * Runs on an ephemeral port against a throwaway store, in-process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('http adapter: routes mount, MCP over HTTP works, panel is served', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-http-'));
  // The store path is resolved when index.js is imported, so set it first.
  process.env.OMNI_HOME = home;
  process.env.OMNI_VERSION_CHECK_DISABLED = '1';

  const { startHttpServer } = await import('../hosts/http/server.mjs');
  const server = await startHttpServer({
    workdir: root,
    port: 0,
    version: 'test',
    log: () => {},
  });

  const url = server.url;

  try {
    assert.equal(server.routes, 21, 'all plugin routes should mount through the shim');

    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.tools, 25, '23 plugin tools plus memory_context and memory_rules');
    assert.equal(health.routes ?? server.routes, 21);

    const metrics = await (await fetch(`${url}/metrics`)).json();
    assert.equal(metrics.ok, true);
    assert.equal(metrics.version, 'test');
    assert.equal(metrics.tools, 25);
    assert.equal(metrics.routes, 21);
    assert.ok(metrics.uptimeSeconds >= 0);
    assert.ok(metrics.requests >= 2, 'health and metrics are counted');
    assert.equal(metrics.errors, 0);
    assert.ok(metrics.memory.rss > 0);

    const panel = await fetch(`${url}/`);
    assert.equal(panel.status, 200);
    assert.match(panel.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await panel.text(), /全息记忆/);

    const rules = await (await fetch(`${url}/rules`)).text();
    assert.match(rules, /memory_context/);

    const status = await (await fetch(`${url}/omni-memory/status`)).json();
    assert.equal(status.ok, true);

    const init = await (await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    })).json();
    assert.equal(init.result.serverInfo.name, 'omni-memory');
    assert.equal(init.result.protocolVersion, '2025-06-18');

    await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const write = await (await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'memory_write', arguments: { kind: 'note', text: 'HTTP 适配层：面板与 MCP 共用一个库。', scope: 'global' } },
      }),
    })).json();
    assert.match(write.result.content[0].text, /stored note #\d+/);

    const search = await (await fetch(`${url}/omni-memory/search?q=${encodeURIComponent('HTTP 适配层')}`)).json();
    assert.equal(search.ok, true);
    assert.ok((search.hits ?? []).length >= 1, 'the REST route must see what MCP wrote');

    const list = await (await fetch(`${url}/omni-memory/list?limit=10`)).json();
    assert.equal(list.ok, true);
    assert.ok((list.notes ?? []).length >= 1);

    const graph = await (await fetch(`${url}/omni-memory/graph`)).json();
    assert.equal(graph.ok, true);
    assert.ok(Array.isArray(graph.nodes));

    const spec = await (await fetch(`${url}/omni-memory/openapi.json`)).json();
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(spec.paths['/omni-memory/packet'], 'dotted JSON route must beat static-file dispatch');

    const packet = await fetch(`${url}/omni-memory/packet?q=${encodeURIComponent('HTTP 适配层')}&format=text`);
    assert.equal(packet.status, 200);
    assert.match(packet.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(await packet.text(), /HTTP 适配层/);

    const missing = await fetch(`${url}/omni-memory/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
