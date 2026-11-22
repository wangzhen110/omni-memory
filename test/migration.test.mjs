import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { boot } from './helpers.mjs';
import { SCHEMA_VERSION } from '../index.js';

function openDb(home) {
  return new DatabaseSync(path.join(home, 'memory', 'omni.db'));
}

test('D-08 a fresh database records the current schema version', async () => {
  const app = await boot();
  await app.call('memory_profile'); // force the store open, which runs migrations
  const db = openDb(app.home);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(String(row.value), String(SCHEMA_VERSION));
  db.close();
});

test('D-08 fresh databases already carry the scope columns', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const db = openDb(app.home);
  const factColumns = db.prepare('PRAGMA table_info(facts)').all().map(row => row.name);
  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map(row => row.name);
  assert.ok(factColumns.includes('scope'));
  assert.ok(chunkColumns.includes('scope'));
  db.close();
});

test('D-08 an unversioned legacy database is migrated in place', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-legacy-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  const legacy = openDb(home);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT,
      role TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, source TEXT,
      importance REAL NOT NULL DEFAULT 0.5, deleted_at INTEGER);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, source TEXT,
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
    CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, relation TEXT NOT NULL,
      object TEXT NOT NULL, text TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7, source TEXT, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
    CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, rel TEXT NOT NULL,
      dst TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, source TEXT);
  `);
  legacy.prepare('INSERT INTO facts(subject, relation, object, text, valid_from) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-entity', 'legacy-relation', 'legacy-object', 'legacy fact row', 1);
  legacy.close();

  const app = await boot({ home });
  await app.call('memory_profile');

  const db = openDb(home);
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), String(SCHEMA_VERSION));
  const factColumns = db.prepare('PRAGMA table_info(facts)').all().map(row => row.name);
  assert.ok(factColumns.includes('scope'), 'scope column should be added by migration');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM facts').get().n), 1, 'legacy rows must survive');
  db.close();

  const hit = await app.call('memory_search', { query: 'legacy fact row' });
  assert.equal(hit.value.hits.length, 1);
});

test('D-08 v6 turns legacy manual project scopes into the global layer', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-scope-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });

  const first = await boot({ home }); // creates the current schema
  await first.call('memory_profile');
  const db = openDb(home);
  db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
  db.prepare('INSERT INTO notes(ts, scope, text, importance) VALUES (?, ?, ?, ?)')
    .run(Date.now(), 'proj:legacy-name', 'legacy manual scope note', 0.9);
  db.close();

  const second = await boot({ home }); // opening the store runs the v6 migration
  await second.call('memory_profile');

  const check = openDb(home);
  const row = check.prepare("SELECT scope FROM notes WHERE text = 'legacy manual scope note'").get();
  assert.equal(row.scope, 'global');
  assert.equal(
    String(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value),
    String(SCHEMA_VERSION),
  );
  check.close();
});

test('D-03 note and fact FTS tables are created and populated', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: 'fts note row' });
  await app.call('memory_write', {
    kind: 'fact', subject: 'fts-entity', relation: 'state', object: 'indexed', text: 'fts fact row',
  });
  const db = openDb(app.home);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all().map(row => row.name);
  assert.ok(tables.includes('notes_fts'));
  assert.ok(tables.includes('facts_fts'));
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM notes_fts').get().n) >= 1);
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM facts_fts').get().n) >= 1);
  db.close();
});

test('D-03 backfill indexes rows that predate the FTS tables', async () => {  const home = mkdtempSync(path.join(tmpdir(), 'omni-backfill-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  const legacy = openDb(home);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, source TEXT,
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
  `);
  legacy.prepare('INSERT INTO notes(ts, text, importance, scope) VALUES (?, ?, ?, ?)')
    .run(1, 'backfill-me note row', 0.9, 'global');
  legacy.close();

  const app = await boot({ home });
  await app.call('memory_profile'); // opening the store creates + backfills the index
  const db = openDb(home);
  const row = db.prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE notes_fts MATCH '\"backfill-me\"'").get();
  assert.equal(Number(row.n), 1);
  db.close();
});

test('v17 backfills in batches, indexes the empty probe and keeps collisions distinct', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-v17-'));
  const first = await boot({ home });
  await first.call('memory_write', { kind: 'note', text: 'v17 legacy note' });
  const seed = openDb(home);
  const insert = seed.prepare('INSERT INTO notes(ts, scope, text, importance) VALUES (?, ?, ?, ?)');
  seed.exec('BEGIN');
  for (let i = 0; i < 2500; i += 1) insert.run(Date.now() + i, 'global', `v17 bulk note ${i}`, 0.5);
  seed.exec('COMMIT');
  seed.close();
  const legacy = openDb(home);
  legacy.exec('DROP INDEX IF EXISTS notes_scope_text_hash');
  legacy.exec('DROP INDEX IF EXISTS notes_text_hash_missing');
  legacy.exec('ALTER TABLE notes DROP COLUMN text_hash');
  legacy.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
  legacy.close();

  const second = await boot({ home });
  await second.call('memory_profile');
  const db = openDb(home);
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '17');
  assert.ok(db.prepare('PRAGMA table_info(notes)').all().some(row => row.name === 'text_hash'));
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM notes WHERE text_hash IS NULL').get().n), 0);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='notes_scope_text_hash'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='notes_text_hash_missing'").get());
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id, text FROM notes WHERE text_hash IS NULL ORDER BY id LIMIT 1000').all()
    .map(row => row.detail).join('\n');
  assert.match(plan, /SCAN notes USING INDEX notes_text_hash_missing/);
  assert.doesNotMatch(plan, /^SCAN notes$/m);

  const deduped = await second.call('memory_write', { kind: 'note', text: 'v17 legacy note' });
  assert.equal(deduped.value.deduped, true);

  // Same hash, different text: the indexed lookup still compares text and must
  // insert a new row instead of reporting a duplicate.
  const collisionHash = createHash('sha256').update('collision other text').digest('hex').slice(0, 32);
  db.prepare('INSERT INTO notes(ts, scope, text, text_hash, importance) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), 'global', 'collision first text', collisionHash, 0.5);
  const collision = await second.call('memory_write', { kind: 'note', text: 'collision other text' });
  assert.equal(collision.value.deduped, false);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE text IN ('collision first text', 'collision other text')").get().n), 2);
  db.close();

  // Reopening a current store reruns the repair path; it must stay a no-op.
  const third = await boot({ home });
  await third.call('memory_profile');
  const stable = openDb(home);
  assert.equal(String(stable.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '17');
  assert.equal(Number(stable.prepare('SELECT COUNT(*) AS n FROM notes WHERE text_hash IS NULL').get().n), 0);
  stable.close();
});
