// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * A profile slot is injected on every turn, yet older builds ranked candidates by
 * importance alone. A note whose whole body was "x" therefore won a slot and
 * pushed real rules out. Two layers now guard it: memory_write rejects text with
 * fewer than two meaningful characters (whitespace/punctuation do not count), and
 * the profile ignores anything thinner than four meaningful characters -- so junk
 * that is already in the database cannot spend the budget either.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

const hash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);

test('min content: degenerate notes are rejected at the door', async () => {
  const app = await boot();
  for (const text of ['x', '中', '...', ' · ', '?']) {
    await assert.rejects(
      () => app.call('memory_write', { kind: 'note', text, scope: 'global' }),
      /too short/,
      `"${text}" must not be stored as a note`,
    );
  }
  // Two meaningful characters clear the write floor; the boundary is deliberate,
  // so a short sentence such as "已确认" is still allowed to be stored (search),
  // even though a two-character fragment is not eligible for the profile.
  const ok = await app.call('memory_write', { kind: 'note', text: 'ab', scope: 'global' });
  assert.ok(ok.value.id > 0);
  // Episodes take the same floor; facts stay exempt because their text may be
  // derived from subject/relation/object.
  await assert.rejects(
    () => app.call('memory_write', { kind: 'episode', text: 'x', scope: 'global' }),
    /too short/,
  );
  const fact = await app.call('memory_write', { kind: 'fact', subject: '服务端口', relation: 'is', object: '7788', scope: 'global' });
  assert.ok(fact.value.id > 0);
});

test('min content: amend cannot shrink a real note into junk', async () => {
  const app = await boot();
  const note = await app.call('memory_write', {
    kind: 'note',
    text: '发布前必须在最终 HEAD 上跑一遍 check',
    scope: 'global',
  });
  await assert.rejects(
    () => app.call('memory_amend', { id: note.value.id, text: 'x' }),
    /too short/,
  );
});

test('min content: a pre-existing thin row cannot take a profile slot', async () => {
  const app = await boot();
  // Write the real rule first, then plant a legacy row directly: the gate must
  // protect databases that already contain junk written by a previous version.
  await app.call('memory_write', {
    kind: 'note',
    text: '例行回复一律使用简体中文，不夹杂英文术语',
    scope: 'global',
    importance: 0.35,
  });
  await sleep(5);
  const db = new DatabaseSync(`${app.home}/memory/omni.db`);
  try {
    db.prepare(`
      INSERT INTO notes(ts, scope, text, text_hash, importance, revision, contested)
      VALUES (?, 'global', 'x', ?, 1, 1, 0)
    `).run(Date.now() + 10, hash('x'));
  } finally {
    db.close();
  }

  const profile = await app.call('memory_profile', { scope: 'global' });
  const text = String(profile.value.text ?? '');
  assert.ok(text.includes('例行回复'), 'the real rule must keep its slot');
  assert.ok(!/(?:^|\n)- x($|\n)/.test(text), 'a one-character legacy note must not be rendered');
  assert.equal(profile.value.included.length, 1,
    'only the real rule counts as included');

  // Filtering the profile must not hide the row from search: it is junk, but it
  // is still an existing record and deletion is a separate, explicit decision.
  const search = await app.call('memory_search', { query: 'x', scope: 'global', limit: 5 });
  assert.ok(search.value.hits.some(hit => hit.text === 'x'), 'thin rows remain searchable');
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
