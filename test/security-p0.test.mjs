// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Regressions for the 2026-11-21 deep audit's P0 findings.
 *
 * These cover the boundaries that used to be missing, not the ordinary
 * happy-path backup/import behavior already tested elsewhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, backupPathOf } from './helpers.mjs';

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('export/import only accept a basename inside the backup directory', async (t) => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'P0Path 可导出' });

  for (const bad of [
    path.join(app.home, 'escape.json'),
    '../escape.json',
    '..\\escape.json',
    'nested/escape.json',
    'C:\\escape.json',
    'omni.db',
  ]) {
    await assert.rejects(
      () => app.call('memory_export', { path: bad }),
      /single file name|backup name must end in .json/,
      `export must reject ${bad}`,
    );
  }

  await app.call('memory_export', { path: 'p0-path.json' });
  await assert.rejects(
    () => app.call('memory_export', { path: 'p0-path.json' }),
    /already exists/,
    'export must not overwrite an existing backup',
  );

  const outside = path.join(app.home, 'secret.txt');
  writeFileSync(outside, 'SECRET-TOKEN-SHOULD-NEVER-ECHO');
  await assert.rejects(
    () => app.call('memory_import', { path: outside }),
    /single file name/,
    'import must reject an absolute path outside the backup directory',
  );

  const badJson = backupPathOf(app, 'bad.json');
  writeFileSync(badJson, 'SECRET-TOKEN-SHOULD-NEVER-ECHO {{{');
  await assert.rejects(
    () => app.call('memory_import', { path: 'bad.json' }),
    error => /cannot read backup/.test(error.message)
      && !error.message.includes('SECRET-TOKEN'),
    'parse failures must not echo the input prefix',
  );

  t.diagnostic(`backup directory: ${path.join(app.home, 'memory', 'backups')}`);
});

test('a symlinked backup name is refused instead of followed', async (t) => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'P0Link 可导出' });
  const target = path.join(app.home, 'linked-target.json');
  writeFileSync(target, '{"format":"omni-memory-backup","version":1}');
  const link = backupPathOf(app, 'link.json');
  try {
    symlinkSync(target, link, 'file');
  } catch (error) {
    t.diagnostic(`symlink unavailable on this host: ${error.message}`);
    return;
  }
  await assert.rejects(
    () => app.call('memory_export', { path: 'link.json' }),
    /symbolic link|already exists/,
  );
  await assert.rejects(
    () => app.call('memory_import', { path: 'link.json' }),
    /symbolic link/,
  );
});

test('by-id writes stay inside the caller project; another project is refused', async () => {
  const app = await boot();
  const projectA = app.mod.attachSession('scope-a', path.join(app.home, 'ProjectA'));
  const projectB = app.mod.attachSession('scope-b', path.join(app.home, 'ProjectB'));
  const ctxA = { agent: { id: 'scope-a' }, session: { id: 'scope-a' } };
  const ctxB = { agent: { id: 'scope-b' }, session: { id: 'scope-b' } };

  const written = await app.tools.get('memory_write').execute(
    { kind: 'note', scope: projectA, text: 'P0Scope only project A may delete this' },
    ctxA,
  );
  assert.ok(written.id > 0);

  const denied = await app.tools.get('memory_forget').execute({ kind: 'note', id: written.id }, ctxB);
  assert.equal(denied.forgotten, false, 'project B must not tombstone project A');

  const allowed = await app.tools.get('memory_forget').execute({ kind: 'note', id: written.id }, ctxA);
  assert.equal(allowed.forgotten, true, 'project A may tombstone its own note');
});

test('import closes the previous active fact for the same single-valued key', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', subject: 'P0Deploy', relation: '方式', object: '裸机',
    text: 'P0Deploy 方式 裸机',
  });

  const snapshot = {
    format: 'omni-memory-backup',
    version: 1,
    exportedAt: Date.now(),
    schema: app.mod.SCHEMA_VERSION,
    notes: [], chunks: [], edges: [], entities: [], relations: [],
    entityAliases: [], persona: [], candidates: [],
    facts: [{
      subject: 'P0Deploy', relation: '方式', object: 'Docker', text: 'P0Deploy 方式 Docker',
      valid_from: Date.now() + 1000, valid_to: null, recorded_at: Date.now(),
      confidence: 0.7, source: 'test:import', contested: 0, scope: 'global',
      deleted_at: null, cardinality: 'single',
    }],
  };
  const file = backupPathOf(app, 'fact-conflict.json');
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  await app.call('memory_import', { path: 'fact-conflict.json', dryRun: false });

  const db = dbOf(app.home);
  try {
    const active = db.prepare(`
      SELECT object FROM facts
      WHERE subject = 'P0Deploy' AND relation = '方式' AND valid_to IS NULL AND deleted_at IS NULL
    `).all();
    assert.equal(active.length, 1, 'single-valued relation must have one active value');
    assert.equal(active[0].object, 'Docker');
  } finally {
    db.close();
  }
});

test('dream cites the matching turn, not the first chunk of a session', async () => {
  const app = await boot();
  app.fire('user/message', '部署端口 1111 的旧结论', 1, 'P0DREAM');
  app.fire('user/message', '部署端口 2222 的新结论', 2, 'P0DREAM');
  const note = await app.call('memory_write', {
    kind: 'note', scope: 'global', text: '部署端口 2222 的新结论', source: 'session:P0DREAM#2',
  });

  const dream = await app.call('memory_dream', { apply: false });
  const action = dream.value.actions.find(item => item.noteId === note.value.id);
  assert.ok(action, 'the note must be scanned');
  assert.notEqual(action.verdict, 'contradicted', `wrong evidence cited: ${JSON.stringify(action)}`);
});

test('test boot never inherits a caller OMNI_HOME', async (t) => {
  const foreign = mkdtempSync(path.join(tmpdir(), 'omni-foreign-home-'));
  const previous = process.env.OMNI_HOME;
  process.env.OMNI_HOME = foreign;
  try {
    const app = await boot();
    await app.call('memory_write', { kind: 'note', scope: 'global', text: 'P0Isolation 只应写临时库' });
    assert.equal(readFileSync(path.join(app.home, 'memory', 'omni.db')).length > 0, true);
    assert.throws(() => readFileSync(path.join(foreign, 'memory', 'omni.db')), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_HOME;
    else process.env.OMNI_HOME = previous;
    rmSync(foreign, { recursive: true, force: true });
  }
  t.diagnostic('boot() pinned OMNI_HOME to its own temp directory');
});
