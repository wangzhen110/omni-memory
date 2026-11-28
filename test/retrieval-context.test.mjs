// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandContext, queryTerms, sourceFamily } from '../lib/search.mjs';

const hit = (id, source, text, score = 0.02, scope = 'proj:x') => ({
  kind: 'note',
  id,
  source,
  text,
  scope,
  score,
  ts: Date.now(),
});

test('sourceFamily strips the last path/colon segment', () => {
  assert.equal(sourceFamily('locomo:1:D3:5'), 'locomo:1:D3');
  assert.equal(sourceFamily('handbook/ch3/part2'), 'handbook/ch3');
  assert.equal(sourceFamily('singleword'), '');
  assert.equal(sourceFamily(''), '');
});

test('queryTerms drops English function words that match every note', () => {
  const terms = queryTerms('What did Alice buy yesterday?');
  assert.equal(terms.includes('what'), false);
  assert.equal(terms.includes('did'), false);
  assert.equal(terms.includes('alice'), true);
  assert.equal(terms.includes('buy'), true);
  // Chinese bigrams are unaffected.
  const zh = queryTerms('昨天买了什么');
  assert.ok(zh.length > 0);
});

test('expandContext reorders the pool without adding or dropping rows', () => {
  const ranked = [
    hit(1, 'locomo:1:D3:5', 'Alice bought a piano in May', 0.030),
    hit(2, 'other/doc/1', 'unrelated line about a piano', 0.015),
    hit(3, 'locomo:1:D3:7', 'Alice paid 500 for the piano', 0.010),
  ];
  const before = ranked.map(row => row.id).sort();
  const out = expandContext({}, ranked, queryTerms('What did Alice buy?'), { expandBoost: 0.3 });
  assert.deepEqual(out.map(row => row.id).sort(), before, 'pool must keep the same rows');
  // Same conversation as the top hit outranks an unrelated hit of similar score.
  assert.equal(out[0].id, 1);
  assert.ok(out.findIndex(row => row.id === 3) < out.findIndex(row => row.id === 2));
});

test('expandContext leaves notes without a source family untouched', () => {
  const ranked = [hit(1, '', 'solo note', 0.02), hit(2, 'plain', 'another', 0.01)];
  const out = expandContext({}, ranked, ['note'], {});
  assert.deepEqual(out.map(row => row.id), [1, 2]);
});
