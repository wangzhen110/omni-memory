// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * 4.6.7 重测报告的 P1 项：prompt 诊断里 `routes` 曾恒为 `'pending'`（代码从不
 * 更新 routeState，测试也只断言“是字符串”），以及 dream 段的两条早退分支。
 * 这里把诊断改成有约束力的断言：状态必须随事件变化，`at`/`auto` 必须落地。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'omni-diag-468-'));
process.env.OMNI_HOME = home;
process.env.DSH_HOME = home;
process.env.OMNI_DISABLE_SEMANTIC = '1';
delete process.env.OMNI_DREAM_INTERVAL_MS;
delete process.env.OMNI_AUTO_RECALL;

const mod = await import(`../index.js?diag-468=${Date.now()}`);

function makeHost() {
  let section = null;
  const disposers = [];
  const callbacks = new Map();
  const routes = [];
  const ctx = {
    tools: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    inject(names, callback) {
      for (const name of names) callbacks.set(name, callback);
      return () => {};
    },
  };
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  const systemPrompt = { section(value) { section = value; return () => { section = null; }; } };
  const provide = (name) => {
    const callback = callbacks.get(name);
    assert.ok(callback, `apply() must inject ${name}`);
    const service = name === 'webServer' ? webServer : name === 'systemPrompt' ? systemPrompt : null;
    assert.ok(service, `unexpected optional service ${name}`);
    callback({ get: key => (key === name ? service : undefined), [name]: service });
  };
  return { ctx, provide, section: () => section, routes, disposeAll: () => { while (disposers.length) disposers.pop()(); } };
}

test('routes diagnostic: pending before mount, mounted (count 1) after, and visible in the prompt', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();

  assert.equal(mod.routeStateSnapshot().status, 'pending', 'no webServer yet');
  const firstPrompt = section.text({});
  assert.equal(typeof firstPrompt, 'string', 'prompt section must render a string');
  assert.equal(mod.lastInjection.chars, firstPrompt.length, 'the chars diagnostic must track the rendered prompt');
  assert.equal(mod.lastInjection.routes, 'pending', 'the prompt must report the real state');

  host.provide('webServer');
  assert.ok(host.routes.length >= 20, 'routes must actually mount');
  const after = mod.routeStateSnapshot();
  assert.equal(after.status, 'mounted');
  assert.equal(after.count, 1, 'mounted exactly once');
  assert.ok(after.at > 0 && after.error === null);
  section.text({});
  assert.equal(mod.lastInjection.routes, 'mounted', 'and the next prompt reflects it');
  host.disposeAll();
});

test('prompt diagnostics: at / auto / chars / recall all carry real values', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();
  const before = Date.now();
  const text = section.text({});
  const last = mod.lastInjection;

  assert.equal(typeof last.chars, 'number');
  assert.equal(last.chars, text.length, 'chars must equal the emitted length exactly');
  assert.equal(typeof last.at, 'number');
  assert.ok(last.at >= before && last.at <= Date.now() + 5, 'at must be a fresh timestamp');
  assert.equal(last.auto, true, 'auto recall defaults on when OMNI_AUTO_RECALL is unset');
  assert.equal(last.recall, 0, 'nothing recalled means 0, not undefined');

  process.env.OMNI_AUTO_RECALL = '0';
  section.text({});
  assert.equal(mod.lastInjection.auto, false, 'the switch must be reflected');
  delete process.env.OMNI_AUTO_RECALL;
  host.disposeAll();
});

test('dream timer: non-numeric and non-positive intervals are inert', async () => {
  for (const value of ['abc', '0', '-5']) {
    process.env.OMNI_DREAM_INTERVAL_MS = value;
    const host = makeHost();
    mod.apply(host.ctx);
    await new Promise(resolve => setTimeout(resolve, 60));
    const lease = mod.acquireLease(mod.openStore().db, 'dream', 60_000);
    assert.ok(lease, `no timer may hold the lease for OMNI_DREAM_INTERVAL_MS=${value}`);
    mod.releaseLease(mod.openStore().db, 'dream', lease);
    host.disposeAll();
  }
  delete process.env.OMNI_DREAM_INTERVAL_MS;
});

test('dream timer: a broken store never escapes into the host', async () => {
  process.env.OMNI_DREAM_INTERVAL_MS = '30';
  const host = makeHost();
  mod.apply(host.ctx);
  try {
    // closeStore() makes the next tick's openStore throw; the timer must swallow it.
    mod.closeStore();
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(typeof mod.lastInjection, 'object', 'the process is still healthy');
  } finally {
    delete process.env.OMNI_DREAM_INTERVAL_MS;
    host.disposeAll();
  }
});

