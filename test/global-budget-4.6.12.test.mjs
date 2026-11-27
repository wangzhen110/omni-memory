// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The always-injected global section is one 1200-character budget. A single
 * oversized rule used to `break` the whole section, silently starving every
 * shorter rule behind it. These cases pin the fix: shorter rules survive, the
 * oversized one leaves a compact pointer, and the profile reports what it kept
 * and what it dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const LONG = '长规则甲：' + '甲'.repeat(1000);
const SHORT_A = '短规则甲：' + '乙'.repeat(150);
const SHORT_B = '短规则乙：' + '丙'.repeat(150);
const SHORT_C = '短规则丙：' + '丁'.repeat(150);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('global budget: an oversized note cannot starve shorter rules', async () => {
  const app = await boot();
  // Oldest first: C (anchor) → long → A → B, so the long rule sits between
  // short rules in the importance/recency order the selector walks.
  const writes = [
    ['anchor', SHORT_C],
    ['long', LONG],
    ['a', SHORT_A],
    ['b', SHORT_B],
  ];
  const ids = {};
  for (const [name, text] of writes) {
    const value = await app.call('memory_write', { kind: 'note', text, scope: 'global', importance: 1 });
    ids[name] = value.value.id;
    await sleep(8);
  }

  const profile = await app.call('memory_profile', { scope: 'global' });
  const text = profile.value.text;
  assert.ok(text.includes('短规则甲'), 'short rule A must survive');
  assert.ok(text.includes('短规则乙'), 'short rule B must survive');
  assert.ok(text.includes('短规则丙'), 'the oldest short rule must not be blocked by the long one');
  assert.ok(text.includes(`note#${ids.long}`), 'the oversized rule leaves a pointer');
  // 3 short rules stay, plus one pointer line. Pin the number instead of
  // re-deriving it from the rendered text (that made the assertion a copy of
  // the implementation).
  assert.equal(profile.value.picked, 4, 'picked must count 3 rules + 1 pointer line');
  assert.ok(profile.value.budgetUsed <= 1200, `budgetUsed ${profile.value.budgetUsed} must stay within 1200`);
  assert.ok(profile.value.budgetUsed >= 450, `budgetUsed ${profile.value.budgetUsed} should keep all short rules and the pointer`);
  assert.deepEqual(profile.value.omitted.map(item => item.id), [ids.long]);
  assert.equal(profile.value.omitted[0].pointer, true);
  assert.ok(profile.value.omitted[0].chars > 1000);
});

test('global budget: separators count, and trimmed rows are reported as omitted', async () => {
  const app = await boot();
  // Line sums: heading 5 + three rules of 396 chars (398 with "- ") = 1199,
  // which passes an accounting that ignores newlines; the joined text is 1202,
  // so the last rule used to be popped silently by capProfileLines.
  const prefix = ['长假安排：', '报销流程：', '值班要求：'];
  const filler = ['甲', '乙', '丙'];
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const text = prefix[i] + filler[i].repeat(396 - prefix[i].length);
    const value = await app.call('memory_write', { kind: 'note', text, scope: 'global', importance: 1 });
    assert.equal(value.value.contested, false, 'distinct rules must not be flagged as contradictions');
    ids.push(value.value.id);
    await sleep(5);
  }

  const profile = await app.call('memory_profile', { scope: 'global' });
  const text = profile.value.text;
  const rulesInText = (text.match(/^- /gm) ?? []).length;
  assert.equal(profile.value.budgetUsed, text.length, 'budgetUsed must be the rendered length, separators included');
  assert.ok(profile.value.budgetUsed <= 1200, `budgetUsed ${profile.value.budgetUsed} must stay within 1200`);
  assert.equal(rulesInText + profile.value.omitted.length - (profile.value.omitted[0]?.pointer ? 1 : 0), 3, 'every rule is either rendered or reported, never silently dropped');
  assert.equal(profile.value.omitted.length, 1, 'the rule that no longer fits must be reported');
  assert.equal(profile.value.omitted[0].id, ids[0], 'the oldest rule is the one that no longer fits');
  assert.equal(profile.value.omitted[0].pointer, true, 'there was still room for a compact pointer');
  assert.ok(text.includes(`note#${ids[0]}`), 'the trimmed rule leaves a pointer');
  // Two rules + one pointer line.
  assert.equal(profile.value.picked, 3, 'picked must count the two rules and the pointer line');
});

test('memory_write hints when a global note is long enough to crowd others out', async () => {
  const app = await boot();
  const long = await app.call('memory_write', { kind: 'note', text: LONG, scope: 'global' });
  assert.equal(typeof long.value.promptBudgetHint, 'string');
  assert.match(long.value.promptBudgetHint, /always-injected global section is 1200 chars/);

  const short = await app.call('memory_write', { kind: 'note', text: SHORT_A, scope: 'global' });
  assert.equal(short.value.promptBudgetHint, undefined, 'short global notes get no hint');
});
