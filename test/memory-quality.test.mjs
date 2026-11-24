// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { runQualitySuite } from '../bench/quality-lib.mjs';

test('memory quality: 120 deterministic update/conflict/scope/forget cases', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const result = await runQualitySuite(app, { count: 120 });
  assert.equal(result.count, 120);
  assert.equal(result.failed, 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.equal(result.byCategory['knowledge-update'].passed, 30);
  assert.equal(result.byCategory.conflict.passed, 30);
  assert.equal(result.byCategory['scope-isolation'].passed, 30);
  assert.equal(result.byCategory['forget-restore'].passed, 30);
});
