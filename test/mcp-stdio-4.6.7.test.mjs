// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * P0-6: the MCP stdio transport (hosts/mcp/server.mjs:180-226) plus a spawn-level
 * smoke test of hosts/mcp/bin.mjs.
 *
 * This is the path every MCP client actually uses, and it had 47 consecutive
 * uncovered lines: invalid-JSON replies, method-not-found, serialisation, stdin
 * end and stop(). Frames are written by a parent process and read back as JSON,
 * so a broken write shows up as an unparsable line, not as a silent success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const nodeBin = process.execPath;
const root = path.resolve('.');
const fixture = path.join(root, 'test', 'fixtures', 'mcp-stdio-harness.mjs');

function startHarness() {
  const child = spawn(nodeBin, [fixture], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => out, err: () => err };
}

/** Send one raw line (may be invalid JSON) and wait for the child to exit on stdin end. */
function session(lines) {
  const h = startHarness();
  h.child.stdin.end(lines.map(line => `${line}\n`).join(''));
  return h;
}

function frames(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('stdio: initialize answers a real protocol frame and only frames go to stdout', async () => {
  const h = session([JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  })]);
  const { code } = await h.exited;
  assert.equal(code, 0);
  const [frame] = frames(h.out());
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.id, 1);
  assert.ok(frame.result.protocolVersion);
  assert.equal(frame.result.serverInfo.name, 'omni-memory');
  for (const line of h.out().split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line), `stdout must be protocol JSON only: ${line}`);
  }
});

test('stdio: invalid JSON gets a parse error with a null id', async () => {
  const h = session(['not json at all']);
  const { code } = await h.exited;
  assert.equal(code, 0);
  const [frame] = frames(h.out());
  assert.equal(frame.id, null);
  assert.equal(frame.error.code, -32700);
});

test('stdio: unknown method answers -32601, notifications answer nothing', async () => {
  const h = session([
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope/nothing' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ]);
  await h.exited;
  const parsed = frames(h.out());
  assert.equal(parsed.length, 1, 'a notification must not produce a frame');
  assert.equal(parsed[0].id, 2);
  assert.equal(parsed[0].error.code, -32601);
});

test('stdio: tools/call success and tool failure both answer in order', async () => {
  const h = session([
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ok', arguments: { value: 'x' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'missing', arguments: {} } }),
  ]);
  const { code } = await h.exited;
  assert.equal(code, 0);
  const parsed = frames(h.out());
  assert.deepEqual(parsed.map(frame => frame.id), [3, 4, 5], 'replies keep frame order');
  assert.equal(parsed[1].result.isError, true);
  assert.match(parsed[1].result.content[0].text, /intentional failure/);
  assert.match(parsed[2].result.content[0].text, /unknown tool: missing/);
});

test('stdio: a frame that cannot be dispatched is logged and does not hang the chain', async () => {
  const h = session([
    'null',
    JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }),
  ]);
  const { code } = await h.exited;
  assert.equal(code, 0);
  assert.match(h.err(), /dispatch failed/);
  const parsed = frames(h.out());
  assert.equal(parsed.at(-1).id, 6, 'the chain continues after a failed frame');
});

test('stdio: SIGINT resolves closed and stop() exits cleanly', async () => {
  const h = startHarness();
  h.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  await new Promise(resolve => setTimeout(resolve, 300));
  h.child.kill('SIGINT');
  const { code, signal } = await h.exited;
  assert.ok(code === 0 || code === 130 || signal === 'SIGINT',
    `expected a clean or signal exit, got code=${code} signal=${signal}`);
  const parsed = frames(h.out());
  assert.equal(parsed.at(-1).id, 7);
});

test('bin.mjs smoke: real entry boots, answers initialize, and keeps stderr clean', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-mcp-bin-467-'));
  const child = spawn(nodeBin, [path.join(root, 'hosts', 'mcp', 'bin.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      OMNI_HOME: home,
      DSH_HOME: home,
      OMNI_PROJECT_DIR: root,
      OMNI_DISABLE_SEMANTIC: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n');
  const exitCode = await new Promise(resolve => child.on('exit', resolve));

  assert.equal(exitCode, 0, `bin.mjs exited ${exitCode}; stderr: ${err.slice(0, 300)}`);
  assert.equal(/ExperimentalWarning/.test(err), false, 'the SQLite experimental banner must be suppressed');
  const parsed = frames(out);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].result.serverInfo.version, JSON.parse(
    (await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).version);
  assert.ok(parsed[1].result.tools.length > 0, 'tools/list must return the real tool set');
});
