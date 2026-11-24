// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Concurrency invariants. These interleave many async tool calls with
 * Promise.all to exercise every await suspension point in write / feedback /
 * recall. They complement test/concurrency.test.mjs (real multi-process
 * workers): here the goal is lost-update and cross-scope leakage detection
 * over many randomized batches, verified against the on-disk SQLite state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

const app = await boot();
const RUNS = 30;
const dbPath = () => path.join(app.home, 'memory', 'omni.db');
const integrity = () => {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return row['integrity_check'] ?? row['integrity_check()'];
  } finally { db.close(); }
};

// ---------------------------------------------------------------------------
// C1. Concurrent writes that share one problemKey must all persist with
//     distinct ids and stay recallable. Guards lost writes / dedup collisions
//     under interleaving.
// ---------------------------------------------------------------------------
test('prop: concurrent same-key writes persist without loss', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), fc.integer({ min: 4, max: 12 }), async (id, n) => {
      const key = `conc-key-${id}`;
      const scope = `proj:conc-${id}`;
      const writes = await Promise.all(
        Array.from({ length: n }, (_, i) => app.call('memory_write', {
          kind: 'note', text: `${id} variant ${i} detail`, problemKey: key, scope,
        })),
      );
      const ids = writes.map(w => Number(w.value.id));
      assert.equal(new Set(ids).size, n, 'each concurrent write gets a distinct id');
      const { value } = await app.call('memory_search', { problemKey: key, scope, limit: 30 });
      for (const written of ids) {
        assert.ok(value.hits.some(h => h.kind === 'note' && h.id === written), `note #${written} survived`);
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// C2. Concurrent feedback votes on one note must all be counted: a lost
//     update would under-count and quietly weaken the ranking signal. Guards
//     the transaction around the counter increment.
// ---------------------------------------------------------------------------
test('prop: concurrent feedback votes have no lost updates', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), fc.integer({ min: 5, max: 15 }), async (id, votes) => {
      const scope = `proj:fbconc-${id}`;
      const written = await app.call('memory_write', {
        kind: 'note', text: `${id} feedback concurrency target`, scope,
      });
      const noteId = written.value.id;
      await Promise.all(
        Array.from({ length: votes }, () => app.call('memory_feedback', {
          kind: 'note', id: noteId, rating: 'useful', scope: 'all',
        })),
      );
      const { value } = await app.call('memory_search', { problemKey: `none-${id}`, query: `${id} feedback concurrency target`, scope, limit: 5 });
      const hit = value.hits.find(h => h.id === noteId);
      assert.ok(hit, 'target remains recallable after concurrent feedback');
      assert.equal(hit.usefulCount, votes, `all ${votes} votes counted, no lost update`);
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// C3. Concurrent writes into different project scopes must not bleed into
//     each other. Each scope sees only its own note (plus global by design).
// ---------------------------------------------------------------------------
test('prop: concurrent cross-scope writes stay isolated', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), fc.integer({ min: 3, max: 6 }), async (id, k) => {
      const scopes = Array.from({ length: k }, (_, i) => `proj:cscope-${id}-${i}`);
      const marker = id.replaceAll('-', '');
      await Promise.all(scopes.map((scope, i) => app.call('memory_write', {
        kind: 'note', text: `scope ${i} secret ${marker} note`, scope,
      })));
      for (let i = 0; i < k; i += 1) {
        const { value } = await app.call('memory_search', { query: `secret ${marker}`, scope: scopes[i], limit: 30 });
        const leaked = value.hits.filter(h => h.kind === 'note' && h.scope && h.scope !== scopes[i]);
        assert.equal(leaked.length, 0, `scope ${i} sees no other project's secret`);
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// C4. A storm of mixed concurrent write/feedback/recall leaves the database
//     structurally intact. Guards transaction boundary corruption.
// ---------------------------------------------------------------------------
test('prop: mixed concurrent operations keep the store consistent', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), fc.integer({ min: 6, max: 16 }), async (id, n) => {
      const scope = `proj:mix-${id}`;
      const ops = [];
      for (let i = 0; i < n; i += 1) {
        if (i % 3 === 0) {
          ops.push(app.call('memory_write', { kind: 'note', text: `${id} mix note ${i}`, scope, solutionStatus: 'verified' }));
        } else if (i % 3 === 1) {
          ops.push(app.call('memory_search', { query: `${id} mix`, scope, limit: 5 }));
        } else {
          ops.push(app.call('memory_write', { kind: 'fact', subject: `${id}-${i}`, relation: 'mix', object: 'value', scope }));
        }
      }
      await Promise.all(ops);
      assert.equal(integrity(), 'ok', 'SQLite integrity_check passes after the storm');
    }),
    { numRuns: Math.min(RUNS, 20) },
  );
});
