// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Contract test for the MCP adapter.
 *
 * It talks to the real server process over real stdio — handshake, tool listing,
 * a write, a recall, and an error path — against a throwaway store. If the
 * adapter drifts from the protocol or from the tool contract, this fails before
 * any client notices.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createProtocol } from '../hosts/mcp/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'hosts', 'mcp', 'bin.mjs');

test('MCP: id:null is a request and notifications never receive a frame', async () => {
  const protocol = createProtocol({
    host: { tools: { get: () => undefined, list: () => [] } },
    serverInfo: { name: 'test', version: '1' },
  });
  const ping = await protocol.handle({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.deepEqual(ping, { id: null, result: {} });
  const initialized = await protocol.handle({ jsonrpc: '2.0', id: null, method: 'initialize', params: {} });
  assert.equal(initialized.id, null);
  assert.ok(initialized.result.protocolVersion);
  assert.equal(await protocol.handle({ jsonrpc: '2.0', method: 'tools/list' }), null);
  assert.equal(await protocol.handle({ jsonrpc: '2.0', method: 'initialize', params: {} }), null);
});

function startServer(home) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, OMNI_HOME: home, OMNI_PROJECT_DIR: root, OMNI_SESSION_ID: 'mcp-contract-test', OMNI_VERSION_CHECK_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const raw = line.trim();
    if (!raw) return;
    const message = JSON.parse(raw);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });

  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: message => { clearTimeout(timer); resolve(message); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const notify = method => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };

  return { child, request, notify };
}

test('mcp adapter: handshake, tool listing, write, recall, error path', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-mcp-'));
  const { child, request, notify } = startServer(home);

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'contract-test', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'omni-memory');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities.tools.listChanged, false);
    notify('notifications/initialized');

    const list = await request('tools/list', {});
    const names = list.result.tools.map(tool => tool.name).sort();
    assert.equal(names.length, 30, `expected 28 memory tools plus memory_context and memory_rules, got ${names.length}`);
    assert.ok(names.includes('memory_context'));
    assert.ok(names.includes('memory_rules'));
    assert.ok(names.includes('memory_write'));
    for (const tool of list.result.tools) {
      assert.ok(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} needs an object schema`);
    }

    const write = await request('tools/call', {
      name: 'memory_write',
      arguments: { kind: 'note', text: 'MCP 适配层契约测试：写入一条作用于 global 层的笔记。', scope: 'global', importance: 0.7 },
    });
    assert.equal(write.result.isError, undefined);
    assert.match(write.result.content[0].text, /stored note #\d+/);

    const context = await request('tools/call', {
      name: 'memory_context',
      arguments: { query: 'MCP 适配层契约测试' },
    });
    assert.equal(context.result.isError, undefined);
    assert.match(context.result.content[0].text, /契约测试/);

    const bad = await request('tools/call', {
      name: 'memory_write',
      arguments: { kind: 'fact', text: 'subject 缺失的事实' },
    });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /subject is required/i);

    const unknown = await request('tools/call', { name: 'memory_nope', arguments: {} });
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /unknown tool/);

    const ping = await request('ping', {});
    assert.deepEqual(ping.result, {});

    // The rules have to be reachable five ways; three of them live in the protocol.
    const prompts = await request('prompts/list', {});
    assert.equal(prompts.result.prompts[0].name, 'omni-bootstrap');

    const prompt = await request('prompts/get', {
      name: 'omni-bootstrap',
      arguments: { task: '排查端口占用' },
    });
    assert.match(prompt.result.messages[0].content.text, /memory_context/);
    assert.match(prompt.result.messages[0].content.text, /排查端口占用/);

    const resources = await request('resources/list', {});
    assert.equal(resources.result.resources[0].uri, 'omni://rules');

    const resource = await request('resources/read', { uri: 'omni://rules' });
    assert.match(resource.result.contents[0].text, /全息记忆使用规则/);
    assert.equal(resource.result.contents[0].mimeType, 'text/markdown');

    const rulesTool = await request('tools/call', { name: 'memory_rules', arguments: {} });
    assert.equal(rulesTool.result.isError, undefined);
    assert.match(rulesTool.result.content[0].text, /problemKey/);
  } finally {
    child.stdin.end();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    // Windows keeps the SQLite file locked until the child really exits; retry
    // instead of failing the test on cleanup.
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
