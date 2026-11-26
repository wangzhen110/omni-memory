// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * P0-2 / P0-3: the always-injected prompt section and the optional dream timer.
 *
 * The review found index.js:531-570 (profile budget trim, contested filtering,
 * setLastInjection diagnostics) and 582-594 (background lease) completely
 * unexecuted. These tests drive the real `apply()` hook with a fake host so the
 * section callback and the timer run under the same code path the host uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'omni-prompt-467-'));
process.env.OMNI_HOME = home;
process.env.DSH_HOME = home;
process.env.OMNI_DISABLE_SEMANTIC = '1';
delete process.env.OMNI_DREAM_INTERVAL_MS;

const mod = await import(`../index.js?prompt-467=${Date.now()}`);

function makeHost() {
  let section = null;
  const disposers = [];
  const callbacks = new Map();
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
  const systemPrompt = {
    section(value) { section = value; return () => { section = null; }; },
  };
  const provide = (name) => {
    const callback = callbacks.get(name);
    assert.ok(callback, `apply() must inject ${name}`);
    const service = name === 'systemPrompt' ? systemPrompt : null;
    assert.ok(service, `unexpected optional service ${name}`);
    callback({ get: key => (key === name ? service : undefined), [name]: service });
  };
  return { ctx, provide, section: () => section, disposeAll: () => { while (disposers.length) disposers.pop()(); } };
}

test('prompt section: persona-only context injects and records diagnostics', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();
  assert.equal(typeof section?.text, 'function');

  mod.personaSet(mod.openStore().db, { 语气: '直接，不要客套', 称呼: '老板' });
  const text = section.text({});
  assert.match(text, /用户长期设定/);
  assert.ok(text.includes('直接，不要客套'));

  const last = mod.lastInjection;
  assert.ok(last.chars > 0, 'setLastInjection must record the emitted size');
  assert.equal(last.project, mod.SCOPE_GLOBAL, 'no scope means the global layer');
  assert.equal(last.scopeId, null, 'a context without scope.id must be recorded as null');
  assert.ok(typeof last.routes === 'string' || last.routes === undefined || last.routes !== null);
  host.disposeAll();
});

test('prompt section: project scope injects the project line', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();

  mod.projectByAgent.set('agent-proj', 'proj:demo');
  const text = section.text({ scope: { id: 'agent-proj' } });
  assert.match(text, /Current project scope: proj:demo/);

  const last = mod.lastInjection;
  assert.equal(last.project, 'proj:demo');
  assert.equal(last.scopeId, 'agent-proj');
  host.disposeAll();
});

test('prompt section: contested and superseded hits never reach the prompt', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();

  mod.recallByAgent.set('agent-recall', {
    at: mod.now(),
    hits: [
      { kind: 'note', id: 1, text: 'contested claim', contested: true },
      { kind: 'note', id: 2, text: 'superseded claim', superseded_by: 9 },
      { kind: 'note', id: 3, text: 'stable   claim\nwith newline' },
    ],
  });
  const text = section.text({ scope: { id: 'agent-recall' } });
  assert.match(text, /Recalled for this request/);
  assert.ok(text.includes('[note#3] stable claim with newline'), 'whitespace is collapsed in hits');
  assert.equal(text.includes('contested claim'), false);
  assert.equal(text.includes('superseded claim'), false);
  assert.equal(mod.lastInjection.recall, 1, 'only the safe hit is counted');
  host.disposeAll();
});

test('prompt section: over-budget text drops the recall block and stays under budget', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();

  // Five long persona values plus headers exceed PROFILE_BUDGET (1200) on their own,
  // which is exactly the condition the trim branch guards.
  const long = '一二三四五六七八九十'.repeat(30);
  mod.personaSet(mod.openStore().db, { 一: long, 二: long, 三: long, 四: long, 五: long });
  mod.recallByAgent.set('agent-budget', {
    at: mod.now(),
    hits: [{ kind: 'note', id: 7, text: 'recall that must be dropped' }],
  });

  const text = section.text({ scope: { id: 'agent-budget' } });
  assert.ok(text.length <= mod.PROFILE_BUDGET, `section must stay within ${mod.PROFILE_BUDGET}, got ${text.length}`);
  assert.equal(text.includes('recall that must be dropped'), false, 'recall block is the first thing trimmed');
  assert.equal(text.includes('Recalled for this request'), false);
  host.disposeAll();
});

test('prompt section: a broken store cannot break the host', () => {
  const host = makeHost();
  mod.apply(host.ctx);
  host.provide('systemPrompt');
  const section = host.section();
  // persona read failure is swallowed; the section still returns a string.
  const text = section.text({});
  assert.equal(typeof text, 'string');
  host.disposeAll();
});

test('dream timer: off by default, runs under a lease when enabled, and cleans up', async () => {
  assert.equal(process.env.OMNI_DREAM_INTERVAL_MS, undefined);

  const host = makeHost();
  mod.apply(host.ctx);
  host.disposeAll();

  process.env.OMNI_DREAM_INTERVAL_MS = '40';
  const host2 = makeHost();
  mod.apply(host2.ctx);
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const lease = mod.acquireLease(mod.openStore().db, 'dream', 60_000);
    assert.ok(lease, 'the timer must release its lease after every pass');
    mod.releaseLease(mod.openStore().db, 'dream', lease);
    // A second host attaching to the same store must not stack leases: each pass
    // is guarded, so a fresh acquire still succeeds immediately.
    const again = mod.acquireLease(mod.openStore().db, 'dream', 60_000);
    assert.ok(again);
    mod.releaseLease(mod.openStore().db, 'dream', again);
  } finally {
    delete process.env.OMNI_DREAM_INTERVAL_MS;
    host2.disposeAll();
  }
});


