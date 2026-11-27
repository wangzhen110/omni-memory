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
  // Pin the rendered length from parts: heading, two 396-char rules with "- ",
  // separators, and the pointer line built from this note's id.
  const pointerLine = `- note#${ids[0]} 超长已省略（memory_search 取回）`;
  assert.equal(profile.value.budgetUsed, 5 + 1 + 398 + 1 + 398 + 1 + pointerLine.length, 'budgetUsed must equal the joined length of the kept lines');
});

test('global budget: a newest oversized note no longer drops the whole section', async () => {
  const app = await boot();
  // Oldest first, then a 2005-char note as the newest row: it becomes items[0]
  // of the section. The old heading guard returned before the loop and dropped
  // all three notes with `omitted: []`.
  const oldA = '短规则丁：' + '戊'.repeat(150);
  const oldB = '短规则戊：' + '己'.repeat(150);
  const huge = '长规则乙：' + '庚'.repeat(1995);
  const shortIds = [];
  for (const text of [oldA, oldB]) {
    const value = await app.call('memory_write', { kind: 'note', text, scope: 'global', importance: 1 });
    shortIds.push(value.value.id);
    await sleep(8);
  }
  const longId = (await app.call('memory_write', { kind: 'note', text: huge, scope: 'global', importance: 1 })).value.id;

  const profile = await app.call('memory_profile', { scope: 'global' });
  const text = profile.value.text;
  assert.ok(text.includes('短规则丁') && text.includes('短规则戊'), 'the older short rules must still render');
  assert.ok(text.includes(`note#${longId}`), 'the oversized newest note leaves a pointer');
  assert.deepEqual(profile.value.omitted.map(item => item.id), [longId], 'exactly the oversized note is reported');
  assert.equal(profile.value.omitted[0].pointer, true);
  assert.ok(profile.value.included.includes(shortIds[0]) && profile.value.included.includes(shortIds[1]), 'included must list the rendered note ids');
  assert.equal(profile.value.picked, 3, 'picked must count two rules plus the pointer');
  assert.equal(profile.value.budgetUsed, text.length, 'budgetUsed must equal the rendered length');
  assert.ok(profile.value.budgetUsed <= 1200);
});

test('global budget: a short row survives beside an oversized first row when only the short row fits', async () => {
  const app = await boot();
  // Global anchor takes the budget up to 1166. The "other projects" section
  // then has just 26 chars left: the 2005-char first row cannot even hold a
  // pointer (34 chars), but the 12-char second row fits. Using only items[0]
  // for the pre-check dropped the section, so the short row never rendered.
  const anchor = '长规则丙：' + '辛'.repeat(1152);
  await app.call('memory_write', { kind: 'note', text: anchor, scope: 'global', importance: 1 });
  await sleep(8);
  const huge = '长规则丁：' + '壬'.repeat(1997);
  const hugeId = (await app.call('memory_write', { kind: 'note', text: huge, scope: 'proj:other', importance: 1 })).value.id;
  await sleep(8);
  const short = '短规则己：' + '癸'.repeat(6);
  const shortId = (await app.call('memory_write', { kind: 'note', text: short, scope: 'proj:other', importance: 1 })).value.id;

  const profile = await app.call('memory_profile', { scope: 'all' });
  const text = profile.value.text;
  assert.ok(text.includes('短规则己'), 'the short row still fits and must render');
  assert.ok(!text.includes(`note#${hugeId}`), 'no pointer fits for the oversized row');
  assert.deepEqual(profile.value.omitted.map(item => item.id), [hugeId], 'the oversized row is reported');
  assert.equal(profile.value.omitted[0].pointer, false);
  assert.ok(profile.value.included.includes(shortId), 'included lists the rendered short row');
  assert.equal(profile.value.picked, 2, 'anchor + short row');
  assert.equal(profile.value.budgetUsed, text.length);
  assert.ok(profile.value.budgetUsed <= 1200);
});

test('global budget: a section that cannot open still reports every note', async () => {
  const app = await boot();
  // The anchor leaves 34 chars. The project section needs a 7-char heading and
  // a 34-char pointer, which does not fit: the early branch must still report
  // every note (pointer:false) instead of dropping them with omitted=[].
  const anchor = '长规则戊：' + '子'.repeat(1158);
  await app.call('memory_write', { kind: 'note', text: anchor, scope: 'global', importance: 1 });
  await sleep(8);
  const huge = '长规则己：' + '丑'.repeat(1997);
  const hugeId = (await app.call('memory_write', { kind: 'note', text: huge, scope: 'proj:other', importance: 1 })).value.id;

  const profile = await app.call('memory_profile', { scope: 'all' });
  assert.ok(profile.value.text.includes('长规则戊'), 'the global anchor still renders');
  assert.deepEqual(profile.value.omitted.map(item => item.id), [hugeId], 'the whole section is reported, not silently dropped');
  assert.equal(profile.value.omitted[0].pointer, false);
  assert.equal(profile.value.omitted[0].chars, huge.length);
  assert.equal(profile.value.budgetUsed, profile.value.text.length);
});

test('capProfileLines trims the tail, strips a stranded heading, and reports owners', async () => {
  const { capProfileLines } = await import('../lib/profile.mjs');
  const owners = [null, { id: 21, chars: 1200, pointer: false }];
  const lines = ['## 当前项目', '- ' + '甲'.repeat(1200)];
  const trimmed = [];
  const text = capProfileLines(lines, owners, (owner, line) => trimmed.push({ owner, line }));
  assert.equal(trimmed.length, 1, 'exactly the oversized row is trimmed');
  assert.equal(trimmed[0].owner.id, 21, 'the callback receives the owner of the trimmed line');
  assert.equal(text, '', 'a heading with no rows beneath it is removed too');
  assert.equal(owners.length, 0, 'owners are popped alongside lines');
});

test('memory_write hints when a global note is long enough to crowd others out', async () => {
  const app = await boot();
  const long = await app.call('memory_write', { kind: 'note', text: LONG, scope: 'global' });
  assert.equal(typeof long.value.promptBudgetHint, 'string');
  assert.match(long.value.promptBudgetHint, /always-injected global section is 1200 chars/);

  const short = await app.call('memory_write', { kind: 'note', text: SHORT_A, scope: 'global' });
  assert.equal(short.value.promptBudgetHint, undefined, 'short global notes get no hint');
});
