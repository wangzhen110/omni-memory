// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Backup drill: write into store A, export, restore the JSON into a brand-new
 * store B, then search B. This is the user-visible recovery path, not just a
 * unit-level snapshot assertion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, copyBackup } from './helpers.mjs';

test('recovery drill: export -> fresh store import -> searchable', async () => {
  const source = await boot();
  const written = await source.call('memory_write', {
    kind: 'note',
    scope: 'proj:drill',
    text: 'RecoveryDrill 备份后必须能在新库检索到。',
    source: 'drill:seed',
  });
  await source.call('memory_write', {
    kind: 'fact',
    scope: 'proj:drill',
    subject: 'RecoveryDrill',
    predicate: 'status',
    object: 'backed-up',
  });
  const exported = await source.call('memory_export', { path: 'drill.json' });
  assert.equal(exported.value.counts.notes, 1);
  assert.equal(exported.value.counts.facts, 1);

  const target = await boot();
  copyBackup(source, target, 'drill.json');
  const dry = await target.call('memory_import', { path: 'drill.json' });
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.notes, 1);

  const imported = await target.call('memory_import', { path: 'drill.json', dryRun: false });
  assert.equal(imported.value.dryRun, false);
  assert.equal(imported.value.notes, 1);
  assert.equal(imported.value.facts, 1);

  const found = await target.call('memory_search', { query: 'RecoveryDrill 备份', scope: 'proj:drill', limit: 5 });
  assert.ok(found.value.hits.some(hit => hit.kind === 'note' && hit.text.includes('RecoveryDrill')));
  assert.ok(written.value.id > 0);
});
