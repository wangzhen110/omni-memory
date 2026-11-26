import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('all twenty-eight model tools are registered', async () => {
  const app = await boot();
  const names = [...app.tools.keys()].sort();
  assert.deepEqual(names, [
    'memory_amend',
    'memory_candidate',
    'memory_compact',
    'memory_consolidate',
    'memory_dream',
    'memory_dream_proposals',
    'memory_dream_replace',
    'memory_dream_rollback',
    'memory_export',
    'memory_feedback',
    'memory_forget',
    'memory_get',
    'memory_import',
    'memory_ingest',
    'memory_link_entity',
    'memory_persona',
    'memory_profile',
    'memory_reindex',
    'memory_restore',
    'memory_search',
    'memory_solution_report',
    'memory_timeline',
    'memory_write',
    'project_context',
    'project_impact',
    'project_search',
    'project_status',
    'project_sync',
  ]);
});

test('FR-11 profile reports the budget and store statistics', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '画像测试' });
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.budget, 1200);
  assert.equal(profile.value.stats.notes, 1);
  assert.match(profile.value.stats.db, /omni\.db$/);
  assert.ok(['trigram', 'unicode61', 'like'].includes(profile.value.stats.fts));
});

test('FR-13 forget tombstones a note and hides it from recall', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '待遗忘的条目' });
  const before = await app.call('memory_search', { query: '待遗忘' });
  assert.equal(before.value.hits.length, 1);
  const forgotten = await app.call('memory_forget', { kind: 'note', id: written.value.id });
  assert.equal(forgotten.value.forgotten, true);
  const after = await app.call('memory_search', { query: '待遗忘' });
  assert.equal(after.value.hits.length, 0);
});

test('FR-13 forgetting twice reports nothing to forget', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '重复遗忘' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });
  const again = await app.call('memory_forget', { kind: 'note', id: written.value.id });
  assert.equal(again.value.forgotten, false);
});

test('FR-13 forget rejects an unknown kind', async () => {
  const app = await boot();
  await assert.rejects(() => app.call('memory_forget', { kind: 'bogus', id: 1 }));
});
