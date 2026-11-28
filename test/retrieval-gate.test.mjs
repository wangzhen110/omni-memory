// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE, evaluateGate } from '../scripts/retrieval-gate-lib.mjs';

const report = (recall, ndcg) => ({ metrics: { evidenceRecall: recall, ndcg }, questions: 500 });

test('evaluateGate passes the recorded 4.7.0 numbers with margin', () => {
  const verdict = evaluateGate({
    session: report(0.7444, 0.5698),
    turn: report(0.5238, 0.3008),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.lines.length, 2);
});

test('evaluateGate fails a turn regression below 0.40', () => {
  const verdict = evaluateGate({
    session: report(0.7444, 0.5698),
    turn: report(0.39, 0.25),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /turn recall/);
});

test('evaluateGate fails session nDCG below 0.55', () => {
  const verdict = evaluateGate({
    session: report(0.72, 0.54),
    turn: report(0.52, 0.29),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /session nDCG/);
});

test('gate thresholds match docs/BENCHMARKS.md §6.3', () => {
  assert.deepEqual(GATE, { session: { recall: 0.70, ndcg: 0.55 }, turn: { recall: 0.40, ndcg: null } });
});

test('evaluateGate reports a missing granularity instead of crashing', () => {
  const verdict = evaluateGate({ session: report(0.75, 0.57) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /turn: no benchmark report/);
});
