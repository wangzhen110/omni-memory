// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * DSH starts plugins before optional services. These tests use a host whose
 * `inject()` callback arrives after `apply()` and prove the routes and prompt
 * section are still installed; the old one-shot ctx.get() returned undefined
 * and silently dropped both surfaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function loadModule() {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cold-start-'));
  process.env.OMNI_HOME = home;
  process.env.DSH_HOME = home;
  process.env.OMNI_DISABLE_SEMANTIC = '1';
  return import(`../index.js?cold-start=${Date.now()}-${Math.random()}`);
}

function makeHost() {
  const routes = [];
  let section = null;
  const callbacks = new Map();
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    on() { return () => {}; },
    get() { return undefined; },
    effect(fn) {
      const dispose = fn();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    inject(names, callback) {
      for (const name of names) callbacks.set(name, callback);
      return () => {
        for (const name of names) callbacks.delete(name);
      };
    },
  };
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  };
  const systemPrompt = {
    section(value) {
      section = value;
      return () => { section = null; };
    },
  };
  const provide = name => {
    const service = name === 'webServer' ? webServer : name === 'systemPrompt' ? systemPrompt : null;
    assert.ok(service, `unknown optional service ${name}`);
    const callback = callbacks.get(name);
    assert.ok(callback, `apply() must inject ${name}`);
    callback({
      get(key) { return key === name ? service : undefined; },
      [name]: service,
    });
  };
  return { ctx, routes, provide, section: () => section, tools };
}

test('cold start: routes and prompt attach after optional services arrive', async () => {
  const host = makeHost();
  const mod = await loadModule();
  mod.apply(host.ctx);

  assert.equal(host.routes.length, 0, 'no routes before webServer exists');
  assert.equal(host.section(), null, 'no prompt section before systemPrompt exists');

  host.provide('webServer');
  assert.ok(host.routes.length >= 20, 'all loopback routes mount after webServer');

  host.provide('systemPrompt');
  assert.equal(typeof host.section(), 'object', 'profile section registers after systemPrompt');
});

test('cold start: service order does not matter', async () => {
  const host = makeHost();
  const mod = await loadModule();
  mod.apply(host.ctx);

  host.provide('systemPrompt');
  assert.equal(typeof host.section(), 'object', 'prompt can arrive first');

  host.provide('webServer');
  assert.ok(host.routes.length >= 20, 'routes can arrive second');
});
