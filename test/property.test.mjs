import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { boot } from './helpers.mjs';

/**
 * Property-based invariants for the memory kernel.
 *
 * These four properties encode the invariant violations that the manual audit
 * rounds actually found (stale vectors after amend, scope leakage, tombstoned
 * rows resurfacing, and unvalidated input). Fixed examples prove one case;
 * properties hold the invariant across hundreds of arbitrary inputs so a
 * regression cannot hide in an untested corner.
 *
 * Semantic embedding is disabled by boot() (default), so exact recall runs the
 * deterministic SQL path and stays fast. Each value carries a fresh uuid so
 * dedup never collapses two generated samples onto the same stored row.
 */
const app = await boot();
const RUNS = 60;
const prose = fc.string({ maxLength: 160 });

// ---------------------------------------------------------------------------
// 1. Round-trip: a stored note must be exactly recallable by its problemKey.
//    Guards "write succeeded but is not retrievable" (stale/missing derived
//    index) and "recall returns a different row than the one stored".
// ---------------------------------------------------------------------------
test('prop: write -> problemKey recall returns the same row', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), prose, async (id, body) => {
      const key = `prop-roundtrip-${id}`;
      const text = `样本 ${id} ${body}`;
      const scope = `proj:prop-${id}`;
      const { value: written } = await app.call('memory_write', {
        kind: 'note', text, problemKey: key, scope, solutionStatus: 'verified',
      });
      assert.ok(Number.isInteger(written.id) && written.id > 0, 'write must return a positive id');

      const { value: found } = await app.call('memory_search', { problemKey: key, scope, limit: 5 });
      const hit = found.hits.find(h => h.kind === 'note' && h.id === written.id);
      assert.ok(hit, `stored note #${written.id} must be recallable by its problemKey`);
      assert.match(hit.text, new RegExp(id), 'recalled row must carry the stored content');
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// 2. Isolation: a private project note must never surface under another
//    project scope. Only global/NULL rows are cross-project visible by design.
//    Guards scope-bypass regressions in scopeClause / JOIN filters.
// ---------------------------------------------------------------------------
test('prop: project scope does not leak across projects', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), prose, async (id, body) => {
      const key = `prop-isolation-${id}`;
      const owner = `proj:owner-${id}`;
      const other = `proj:other-${id}`;
      await app.call('memory_write', {
        kind: 'note', text: `私有 ${id} ${body}`, problemKey: key, scope: owner,
      });

      const { value: foreign } = await app.call('memory_search', { problemKey: key, scope: other, limit: 10 });
      assert.equal(
        foreign.hits.filter(h => h.kind === 'note' && h.scope === owner).length,
        0,
        `scope ${other} must not recall the private note of ${owner}`,
      );

      const { value: own } = await app.call('memory_search', { problemKey: key, scope: owner, limit: 10 });
      assert.ok(
        own.hits.some(h => h.kind === 'note' && h.scope === owner),
        `owner scope ${owner} must still recall its own note`,
      );
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// 3. Tombstone: once forgotten, a note must stop appearing in exact recall.
//    Guards derived-index GC gaps (FTS/vector/bigram rows resurfacing a dead
//    note) and any future reader that forgets the deleted_at filter.
// ---------------------------------------------------------------------------
test('prop: forgotten note is no longer recallable', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), prose, async (id, body) => {
      const key = `prop-tombstone-${id}`;
      const scope = 'global';
      const { value: written } = await app.call('memory_write', {
        kind: 'note', text: `待遗忘 ${id} ${body}`, problemKey: key, scope,
      });
      assert.ok((await app.call('memory_search', { problemKey: key, scope })).value.hits.length > 0);

      const { value: forgot } = await app.call('memory_forget', { kind: 'note', id: written.id });
      assert.equal(forgot.forgotten, true, 'forget must tombstone an active note');

      const { value: after } = await app.call('memory_search', { problemKey: key, scope, limit: 10 });
      assert.equal(
        after.hits.filter(h => h.kind === 'note' && h.id === written.id).length,
        0,
        `forgotten note #${written.id} must not be recalled`,
      );
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// 4. Robustness: arbitrary strings (quotes, SQL fragments, control chars,
//    CJK) must be stored without throwing, and out-of-range parameters must
//    be rejected. Guards input-validation and parameterized-SQL regressions.
// ---------------------------------------------------------------------------
const nasty = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.constantFrom(
    "'; DROP TABLE notes; --",
    'x ESCAPE \' AND 1=1 --',
    '中文混排\t换行\n制表\0结束',
    '  '.repeat(40),
    'a'.repeat(3900),
  ),
);

test('prop: arbitrary text is stored safely and invalid bounds are rejected', async () => {
  await fc.assert(
    fc.asyncProperty(nasty, fc.uuid(), async (body, id) => {
      const key = `prop-robust-${id}`;
      const scope = `proj:robust-${id}`;
      const { value: written } = await app.call('memory_write', {
        kind: 'note', text: `鲁棒 ${id} ${body}`, problemKey: key, scope,
      });
      assert.ok(Number.isInteger(written.id) && written.id > 0, 'arbitrary text must store a valid id');
      const { value: found } = await app.call('memory_search', { problemKey: key, scope });
      assert.ok(found.hits.some(h => h.id === written.id), 'arbitrary text must still be recallable');
    }),
    { numRuns: RUNS },
  );

  for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => app.call('memory_write', { kind: 'note', text: '一条任意内容的观察记录', importance: bad }),
      /importance/, `importance ${bad} must be rejected`);
  }
  for (const bad of [0, 31, Number.NaN]) {
    await assert.rejects(() => app.call('memory_search', { query: 'x', limit: bad }),
      /limit/, `limit ${bad} must be rejected`);
  }
  await assert.rejects(() => app.call('memory_write', { kind: 'note', text: '一条任意内容的观察记录', scope: 'all' }),
    /read-only/, 'scope=all must be rejected on write');
});
