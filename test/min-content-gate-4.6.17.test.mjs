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

test('min content: zero-width, symbols, emoji and marks are not letters', async () => {
  const app = await boot();
  // 4.6.17 counted every non-space/non-punctuation code point, so these six
  // cleared the gate while carrying no information at all.
  const junk = [
    '\u200b'.repeat(4),          // zero-width space (Cf)
    '\u200d\u200d\u200d\u200d',  // zero-width joiner (Cf)
    '★★★★',                       // symbols (So)
    '￥￥￥￥',                     // currency symbols (Sc)
    '😀😀😀😀',                    // emoji (So)
    '👨‍👩‍👧',                     // emoji family: So + ZWJ only
  ];
  for (const text of junk) {
    await assert.rejects(
      () => app.call('memory_write', { kind: 'note', text, scope: 'global' }),
      /too short/,
      `"${JSON.stringify(text)}" must not be stored`,
    );
  }
  // A base letter plus combining accents is ONE letter: 3 such graphemes pass the
  // write floor (>=2) but stay out of the profile (>=4).
  const accented = 'e\u0301'.repeat(3);
  const stored = await app.call('memory_write', { kind: 'note', text: accented, scope: 'global', importance: 1 });
  assert.ok(stored.value.id > 0, 'three letters are allowed to be stored');
  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.equal(profile.value.included.length, 0, 'three letters are too thin for a profile slot');
});

test('min content: sixty sub-floor rows cannot crowd a real rule out (E-02)', async () => {
  const app = await boot();
  // The real rule is written first with low importance, so it sorts below every
  // planted row. The old build took 60 rows from SQL and filtered afterwards;
  // 60 three-letter rows (>=2 for write, <4 for profile) then emptied the profile.
  await app.call('memory_write', {
    kind: 'note', text: '值班要求：每天开工先确认机器身份', scope: 'global', importance: 0.1,
  });
  const db = new DatabaseSync(`${app.home}/memory/omni.db`);
  const base = Date.now();
  try {
    const stmt = db.prepare(`
      INSERT INTO notes(ts, scope, text, text_hash, importance, revision, contested)
      VALUES (?, 'global', ?, ?, 1, 1, 0)
    `);
    for (let i = 0; i < 60; i += 1) {
      const text = `a${String(i).padStart(2, '0')}`;
      stmt.run(base + i, text, hash(text));
    }
  } finally {
    db.close();
  }

  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.ok(String(profile.value.text).includes('值班要求'), 'the real rule must survive 60 thin rows');
  assert.equal(profile.value.included.length, 1, 'only the real rule is included');
});

test('min content: a fact needs both ends of its tuple', async () => {
  const app = await boot();
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', subject: '部署方式', relation: '是', object: '', scope: 'global' }),
    /object is required/,
    'an empty object used to render as "- 实体 · is：" and spend profile budget',
  );
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', subject: '部署方式', relation: '', object: '容器', scope: 'global' }),
    /relation is required/,
  );
  // Legacy rows written before the check may still carry an empty object; the
  // profile must drop them, not render a dangling relation.
  const db = new DatabaseSync(`${app.home}/memory/omni.db`);
  try {
    db.prepare(`
      INSERT INTO facts(subject, relation, object, text, valid_from, confidence)
      VALUES ('空值实体', 'is', '', '空值实体 is ', ?, 0.7)
    `).run(Date.now());
  } finally {
    db.close();
  }
  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.ok(!String(profile.value.text).includes('空值实体'), 'a dangling legacy fact must not be rendered');
});

test('min content: candidate accept shares the floor and leaves the queue intact', async () => {
  const app = await boot();
  // Open the store first (a read creates the file); the bare temp home has no DB yet.
  await app.call('memory_profile', { scope: 'global' });
  const db = new DatabaseSync(`${app.home}/memory/omni.db`);
  let candidateId;
  try {
    const info = db.prepare(`
      INSERT INTO note_candidates(ts, scope, text, hash, confidence, status)
      VALUES (?, 'global', 'x', ?, 0.6, 'pending')
    `).run(Date.now(), hash('x'));
    candidateId = Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
  await assert.rejects(
    () => app.call('memory_candidate', { action: 'accept', id: candidateId, scope: 'global' }),
    /candidate text is too short/,
  );
  const listed = await app.call('memory_candidate', { action: 'list', scope: 'global', status: 'pending' });
  assert.ok(listed.value.candidates.some(item => item.id === candidateId), 'a rejected accept must not mark the candidate done');
});
