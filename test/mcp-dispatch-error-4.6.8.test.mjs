// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * 4.6.7 覆盖率重测报告 §3 的 P0-5 缺口：`serveStdio` 的 dispatch 失败分支
 * （server.mjs:204-209）只在“失败帧带 id”时回 `RPC.internal` 错误帧；上一轮
 * 用 `'null'` 触发只走到 log 分支，等于没验错误回复本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const nodeBin = process.execPath;
const root = path.resolve('.');
const fixture = path.join(root, 'test', 'fixtures', 'mcp-stdio-harness.mjs');

function session(lines) {
  const child = spawn(nodeBin, [fixture], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.stdin.end(lines.map(line => `${line}\n`).join(''));
  return { exited, out: () => out, err: () => err };
}

test('stdio: a dispatch failure on a frame WITH id answers -32603 and keeps the id', async () => {
  // tools/call for `explode` throws inside host.tools.get, before callTool's
  // own try/catch, so protocol.handle rejects and the chain catch must reply.
  const h = session([
    JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'explode', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' }),
  ]);
  const { code } = await h.exited;
  assert.equal(code, 0);

  const frames = h.out().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failed = frames.find(frame => frame.id === 41);
  assert.ok(failed, 'the failed request must still get a reply');
  assert.equal(failed.jsonrpc, '2.0');
  assert.equal(failed.error.code, -32603, 'dispatch failure maps to RPC.internal');
  assert.match(failed.error.message, /tool registry exploded/);
  assert.equal('result' in failed, false, 'an error frame must not carry a result');
  assert.equal(frames.at(-1).id, 42, 'the chain continues after the error reply');
  assert.match(h.err(), /dispatch failed/);
});

test('stdio: a dispatch failure without id logs but writes no frame', async () => {
  const h = session([
    JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'explode', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 43, method: 'ping' }),
  ]);
  await h.exited;
  const frames = h.out().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(frames.length, 1, 'a notification-shaped failure must not be answered');
  assert.equal(frames[0].id, 43);
  assert.match(h.err(), /dispatch failed/);
});
