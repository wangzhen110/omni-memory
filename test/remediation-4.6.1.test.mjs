// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCrossScope } from '../lib/search.mjs';
import { hostHeaderAllowed, isLoopback } from '../hosts/shared/http-guard.mjs';
import { boot, fakeRes } from './helpers.mjs';
import { testModeEnabled } from '../scripts/daily-sync.mjs';

test('host guard accepts loopback names and rejects a rebinding host', () => {
  const old = process.env.OMNI_TRUSTED_HOSTS;
  process.env.OMNI_TRUSTED_HOSTS = 'extra.local';
  try {
    assert.equal(hostHeaderAllowed({ headers: { host: '127.0.0.1:7788' } }), true);
    assert.equal(hostHeaderAllowed({ headers: { host: 'localhost:7788' } }), true);
    assert.equal(hostHeaderAllowed({ headers: { host: '[::1]:7788' } }), true);
    assert.equal(hostHeaderAllowed({ headers: { host: 'extra.local:7788' } }), true);
    assert.equal(hostHeaderAllowed({ headers: { host: 'attacker.example' } }), false);
    assert.equal(hostHeaderAllowed({ headers: {} }), false);
  } finally {
    if (old === undefined) delete process.env.OMNI_TRUSTED_HOSTS;
    else process.env.OMNI_TRUSTED_HOSTS = old;
  }
});

test('host guard treats only loopback sockets as local', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.2' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '10.0.0.8' } }), false);
});

test('test-only daily-sync hooks need both the mode flag and a test runner', () => {
  assert.equal(testModeEnabled({ OMNI_TEST_MODE: '1' }), false);
  assert.equal(testModeEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(testModeEnabled({ OMNI_TEST_MODE: '1', NODE_TEST_CONTEXT: 'child-v8' }), true);
});

test('plugin read routes fail closed when Host is missing', async () => {
  const app = await boot();
  const req = {
    method: 'GET',
    url: '/omni-memory/export',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const { res, json, state } = fakeRes();
  await app.route('/omni-memory/export').handler(req, res);
  assert.equal(state.statusCode, 403);
  assert.match(String(json().error), /forbidden host/i);
});

test('a failed cross-scope audit is logged instead of swallowed', () => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    auditCrossScope({
      prepare() { throw new Error('audit table unavailable'); },
    }, 'memory_write', 7);
  } finally {
    console.error = original;
  }
  assert.ok(lines.some(line => line.includes('cross-scope audit failed')), 'audit failure must leave a diagnostic');
  assert.ok(lines.every(line => !line.includes('secret')), 'diagnostic must not print memory text');
});
