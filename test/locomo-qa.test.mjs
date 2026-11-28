// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { allQuestions, extractiveAnswer, readDataset, ruleJudge, subsetQuestions, tokenF1 } from '../bench/locomo-lib.mjs';

const data = readDataset();

test('subsetQuestions is deterministic for a fixed seed and keeps the exact size', () => {
  const rows = allQuestions(data, { granularity: 'turn' });
  const a = subsetQuestions(rows, { size: 120, seed: 42 });
  const b = subsetQuestions(rows, { size: 120, seed: 42 });
  assert.equal(a.length, 120);
  assert.deepEqual(a.map(row => row.question), b.map(row => row.question));
  const c = subsetQuestions(rows, { size: 120, seed: 43 });
  assert.notDeepEqual(a.map(row => row.question), c.map(row => row.question));
});

test('subsetQuestions keeps every category represented', () => {
  const rows = allQuestions(data, { granularity: 'turn' });
  const subset = subsetQuestions(rows, { size: 120, seed: 42 });
  const allCategories = new Set(rows.map(row => row.category));
  assert.deepEqual(new Set(subset.map(row => row.category)), allCategories);
});

test('extractiveAnswer prefers a date for "when" questions', () => {
  const hits = [
    { text: 'Alice: I visited the museum on 7 May 2023 with Bob.' },
    { text: 'Bob: The museum was crowded.' },
  ];
  const answer = extractiveAnswer('When did Alice visit the museum?', hits);
  assert.match(answer, /May 2023/);
});

test('extractiveAnswer prefers a number for "how many" questions', () => {
  const hits = [{ text: 'Alice: We bought 3 tickets for the concert.' }];
  const answer = extractiveAnswer('How many tickets did they buy?', hits);
  assert.match(answer, /\b3\b/);
});

test('ruleJudge accepts verbatim containment but rejects a different answer', () => {
  assert.equal(ruleJudge('She moved on 7 May 2023.', '7 May 2023').correct, true);
  assert.equal(ruleJudge('Alice', '7 May 2023').correct, false);
  assert.equal(ruleJudge('Alice', 'alice').correct, true);
  assert.equal(tokenF1('Alice bought a piano', 'Alice bought a piano'), 1);
});
