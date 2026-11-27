// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The optional dream timer is a background interval owned by a host effect.
 * 4.6.8 review asked for proof that disposing the registration really clears
 * it — a leaked interval keeps waking a verifier on a host that already
 * unloaded the plugin. This asserts the timer is created only when
 * OMNI_DREAM_INTERVAL_MS > 0 and that its disposer clears exactly that handle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

async function bootWithTimer(intervalMs) {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-timer-'));
  process.env.OMNI_HOME = home;
  process.env.DSH_HOME = home;
  process.env.OMNI_VERSION_CHECK_DISABLED = '1';
  process.env.OMNI_DISABLE_SEMANTIC = '1';
  if (intervalMs == null) delete process.env.OMNI_DREAM_INTERVAL_MS;
  else process.env.OMNI_DREAM_INTERVAL_MS = String(intervalMs);

  const intervals = new Map();
  const cleared = [];
  let nextHandle = 0;
  globalThis.setInterval = (fn, ms) => {
    const handle = { id: (nextHandle += 1), fn, ms, unref() {} };
    intervals.set(handle.id, handle);
    return handle;
  };
  globalThis.clearInterval = handle => cleared.push(handle?.id ?? handle);

  const disposers = [];
  const ctx = {
    agent: { id: 'timer-test' },
    session: { id: 'timer-test', cwd: home },
    scope: { id: 'timer-test' },
    tools: { register: () => () => {} },
    on: () => () => {},
    get(name) {
      if (name === 'systemPrompt') return { section: () => () => {} };
      if (name === 'webServer') return { register: () => () => {} };
      return undefined;
    },
    effect(fn, label) {
      const dispose = fn();
      disposers.push({ label: String(label ?? ''), dispose });
      return () => {};
    },
  };

  const mod = await import(`../index.js?timer=${intervalMs}-${Date.now()}`);
  mod.apply(ctx);
  return { home, disposers, intervals, cleared };
}

test('dream timer: registered only when enabled and disposed with clearInterval', async () => {
  const disabled = await bootWithTimer(null);
  try {
    assert.equal(disabled.intervals.size, 0, 'no dream interval by default');
    const timerDispose = disabled.disposers.filter(item => item.label.includes('dream timer'));
    assert.ok(timerDispose.every(item => typeof item.dispose !== 'function' || item.dispose() === undefined));
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    rmSync(disabled.home, { recursive: true, force: true });
  }

  const enabled = await bootWithTimer(50);
  try {
    assert.equal(enabled.intervals.size, 1, 'one dream interval when enabled');
    const entry = enabled.disposers.find(item => item.label.includes('dream timer'));
    assert.ok(entry, 'dream timer effect must be registered');
    assert.equal(typeof entry.dispose, 'function');
    entry.dispose();
    const handle = [...enabled.intervals.values()][0];
    assert.deepEqual(enabled.cleared, [handle.id], 'disposer must clear the created interval');
    assert.equal(enabled.intervals.get(handle.id).ms, 50);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    rmSync(enabled.home, { recursive: true, force: true });
  }
});
