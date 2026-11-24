// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Ranking invariants for the retrieval pipeline.
 *
 * The 3.9.x audits repeatedly found ranking bugs that fixed examples missed:
 * a reranker burying the exact problemKey hit, feedback signals not moving the
 * score, status boosts inverted. These properties hold the ordering contracts
 * across arbitrary problem keys and text while the deterministic SQL path is
 * active (semantic disabled by boot()).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { boot } from './helpers.mjs';

const app = await boot();
const RUNS = 40;
const token = fc.uuid();

const STATUS_RANK = { verified: 0, unverified: 1, failed: 2, expired: 3 };
const rankOf = hit => STATUS_RANK[hit.solutionStatus ?? 'unverified'] ?? 3;

// ---------------------------------------------------------------------------
// R1. Exact problemKey hits sort by real-world status first: verified above
//     unverified above failed, independent of importance/recency. Guards the
//     CASE ordering in searchProblemKey against a boost regression.
// ---------------------------------------------------------------------------
test('prop: exact problemKey hits are ordered verified > unverified > failed', async () => {
  await fc.assert(
    fc.asyncProperty(token, async (id) => {
      const key = `rank-status-${id}`;
      const scope = `proj:rank-${id}`;
      const specs = [
        { status: 'failed', text: `${id} failed attempt` },
        { status: 'verified', text: `${id} verified solution` },
        { status: 'unverified', text: `${id} unverified note` },
      ];
      for (const spec of specs) {
        await app.call('memory_write', {
          kind: 'note', text: spec.text, problemKey: key, scope, solutionStatus: spec.status,
        });
      }
      const { value } = await app.call('memory_search', { problemKey: key, scope, limit: 10 });
      assert.ok(value.hits.length >= 3, 'all three status variants are returned');
      const exact = value.hits.filter(h => h.exactProblem);
      assert.equal(exact.length, 3, 'all are exact hits');
      for (let i = 1; i < exact.length; i += 1) {
        assert.ok(rankOf(exact[i - 1]) <= rankOf(exact[i]),
          `status rank must be non-decreasing: ${exact.map(rankOf).join(',')}`);
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// R2. An exact problemKey hit is a hard priority: even when a query would
//     rank other notes higher lexically, the exact hit must be first. Guards
//     the [...exact, ...result.hits] merge against a rerank/score regression.
// ---------------------------------------------------------------------------
test('prop: exact problemKey hit outranks lexical query hits', async () => {
  await fc.assert(
    fc.asyncProperty(token, async (id) => {
      const key = `rank-exact-${id}`;
      const scope = `proj:exact-${id}`;
      const shared = `zxq${id.replaceAll('-', '')}`;
      // A lexical note with a high importance and the exact query term.
      await app.call('memory_write', {
        kind: 'note', text: `${shared} lexical decoy importance`, scope, importance: 0.99,
      });
      // The exact-hit note, deliberately ordinary importance.
      const exactWritten = await app.call('memory_write', {
        kind: 'note', text: `${shared} exact anchor`, problemKey: key, scope, importance: 0.1,
      });
      const { value } = await app.call('memory_search', { query: shared, problemKey: key, scope, limit: 10 });
      assert.ok(value.hits.length >= 2, 'both decoy and exact hit are present');
      assert.equal(value.hits[0].exactProblem, true, 'exact hit must be first');
      assert.equal(value.hits[0].id, exactWritten.value.id, 'first hit is the exact note');
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// R3. Feedback signal monotonicity: useful votes raise a note's score,
//     misleading votes lower it. Guards feedbackBoost / Bayesian smoothing.
//     Measured on the exact-hit score which is 2 + solutionBoost + feedback.
// ---------------------------------------------------------------------------
test('prop: useful votes lift score and misleading votes lower it', async () => {
  await fc.assert(
    fc.asyncProperty(token, async (id) => {
      const key = `rank-feedback-${id}`;
      const scope = `proj:fb-${id}`;
      const written = await app.call('memory_write', {
        kind: 'note', text: `${id} feedback target`, problemKey: key, scope, solutionStatus: 'verified',
      });
      const noteId = written.value.id;
      const scoreOf = async () => {
        const { value } = await app.call('memory_search', { problemKey: key, scope, limit: 5 });
        const hit = value.hits.find(h => h.id === noteId);
        assert.ok(hit, 'feedback target remains recallable');
        return Number(hit.score);
      };
      const base = await scoreOf();
      for (let i = 0; i < 3; i += 1) {
        await app.call('memory_feedback', { kind: 'note', id: noteId, rating: 'useful', scope: 'all' });
      }
      const afterUseful = await scoreOf();
      assert.ok(afterUseful > base, `useful votes must lift score: ${base} -> ${afterUseful}`);
      for (let i = 0; i < 4; i += 1) {
        await app.call('memory_feedback', { kind: 'note', id: noteId, rating: 'misleading', scope: 'all' });
      }
      const afterMisleading = await scoreOf();
      assert.ok(afterMisleading < afterUseful, `misleading votes must lower score: ${afterUseful} -> ${afterMisleading}`);
    }),
    { numRuns: Math.min(RUNS, 25) },
  );
});

// ---------------------------------------------------------------------------
// R4. Status filtering is exact: status=verified returns only verified notes,
//     status=failed only failed, even when all share one problemKey. Guards
//     the statusSql parameter binding in searchProblemKey.
// ---------------------------------------------------------------------------
test('prop: status filter restricts to the requested real outcome', async () => {
  await fc.assert(
    fc.asyncProperty(token, fc.constantFrom('verified', 'unverified', 'failed'), async (id, wanted) => {
      const key = `rank-filter-${id}`;
      const scope = `proj:filter-${id}`;
      for (const status of ['verified', 'unverified', 'failed']) {
        await app.call('memory_write', {
          kind: 'note', text: `${id} ${status} variant`, problemKey: key, scope, solutionStatus: status,
        });
      }
      const { value } = await app.call('memory_search', { problemKey: key, scope, status: wanted, limit: 10 });
      assert.ok(value.hits.length >= 1, 'the requested status has a note');
      for (const hit of value.hits) {
        assert.equal(hit.solutionStatus ?? 'unverified', wanted, 'no other status leaks through the filter');
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// R5. Ranking is a pure function of store state: repeating the same query
//     yields the same hit order. Guards nondeterminism from feedback/queue.
// ---------------------------------------------------------------------------
test('prop: repeated searches return a stable order', async () => {
  await fc.assert(
    fc.asyncProperty(token, async (id) => {
      const scope = `proj:stable-${id}`;
      const term = `stable${id.replaceAll('-', '').slice(0, 12)}`;
      for (let i = 0; i < 4; i += 1) {
        await app.call('memory_write', {
          kind: 'note', text: `${term} note number ${i} detail`, scope, importance: 0.1 * i,
        });
      }
      const first = (await app.call('memory_search', { query: term, scope, limit: 10 })).value.hits.map(h => `${h.kind}:${h.id}`);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        const again = (await app.call('memory_search', { query: term, scope, limit: 10 })).value.hits.map(h => `${h.kind}:${h.id}`);
        assert.deepEqual(again, first, 'repeated query returns identical ordering');
      }
    }),
    { numRuns: RUNS },
  );
});
