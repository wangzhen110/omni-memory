import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { boot } from './helpers.mjs';
import { supportsFts5 } from './fts-support.mjs';
import { SCHEMA_VERSION } from '../index.js';

const ROOT = path.resolve(import.meta.dirname, '..');

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

test('v18 bigram index is WITHOUT ROWID and keeps two-character recall', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '全息记忆的本地检索测试' });
  const db = openDb(app.home);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bigrams'").get()?.sql ?? '';
  assert.match(sql, /WITHOUT ROWID/i);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='bigrams_owner'").all().map(row => row.name),
    ['bigrams_owner'],
  );
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM bigrams').get().n) > 0);
  db.close();
  const hit = await app.call('memory_search', { query: '记忆' });
  assert.ok(hit.value.hits.some(row => String(row.text).includes('全息记忆')));
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

test('D-03 note and fact FTS tables are created and populated', async t => {
  if (!supportsFts5()) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }
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

test('D-03 backfill indexes rows that predate the FTS tables', async t => {
  if (!supportsFts5()) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), 'omni-backfill-'));
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

test('a real schema upgrade writes a verified pre-migration backup first', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-migration-backup-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  const legacy = openDb(home);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, source TEXT,
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
  `);
  legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
  legacy.prepare('INSERT INTO notes(ts, text, importance, scope) VALUES (?, ?, ?, ?)')
    .run(1, 'backup me before migration', 0.9, 'global');
  legacy.close();

  const app = await boot({ home });
  await app.call('memory_profile');

  const backupDir = path.join(home, 'memory', 'backups');
  const names = readdirSync(backupDir).filter(name =>
    new RegExp(`^pre-migrate-v1-to-v${SCHEMA_VERSION}-.*\\.db$`).test(name));
  assert.equal(names.length, 1, 'one backup should be written before the upgrade');
  const backup = new DatabaseSync(path.join(backupDir, names[0]), { readOnly: true });
  const check = backup.prepare('PRAGMA integrity_check').get();
  assert.equal(Object.values(check)[0], 'ok');
  assert.equal(String(backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '1');
  assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM notes').get().n), 1);
  backup.close();
});

test('a fresh database does not create a pointless migration backup', async () => {
  const app = await boot();
  await app.call('memory_profile');
  const backupDir = path.join(app.home, 'memory', 'backups');
  assert.equal(existsSync(backupDir) ? readdirSync(backupDir).filter(name => name.endsWith('.db')).length : 0, 0);
});

test('P0 concurrent first opens share one migration owner and keep a verified backup', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-concurrent-migrate-'));
  const env = {
    ...process.env,
    OMNI_HOME: home,
    DSH_HOME: home,
    OMNI_VERSION_CHECK_DISABLED: '1',
    OMNI_DISABLE_SEMANTIC: '1',
    OMNI_MIGRATION_BACKUP_KEEP: '5',
  };
  delete env.OMNI_BACKUP_DIR;
  // Start from a real v17 store, then rewind only the version marker. A
  // minimal hand-built v16 schema would not exercise the actual migration path.
  const seed = spawnSync(process.execPath, [
    path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'seed', '--limit', '1',
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  const legacy = openDb(home);
  legacy.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
  legacy.prepare('INSERT INTO notes(ts, scope, text, importance, text_hash) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'global', 'concurrent migration survivor', 0.9, createHash('sha256').update('concurrent migration survivor').digest('hex').slice(0, 32));
  legacy.close();

  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'concurrency probe', '--limit', '1',
    ], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', error => resolve({ code: -1, stdout, stderr: String(error) }));
  });

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(second.code, 0, second.stderr || second.stdout);

  const db = openDb(home);
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), String(SCHEMA_VERSION));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE text='concurrent migration survivor'").get().n), 1);
  db.close();

  const backupDir = path.join(home, 'memory', 'backups');
  const names = readdirSync(backupDir).filter(name =>
    new RegExp(`^pre-migrate-v16-to-v${SCHEMA_VERSION}-.*\\.db$`).test(name));
  assert.ok(names.length >= 1, 'at least one complete pre-migration backup must survive');
  for (const name of names) {
    const file = path.join(backupDir, name);
    assert.ok(statSync(file).size > 0, `${name} must not be empty`);
    const backup = new DatabaseSync(file, { readOnly: true });
    const check = backup.prepare('PRAGMA integrity_check').get();
    assert.equal(Object.values(check)[0], 'ok');
    assert.equal(String(backup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '16');
    backup.close();
  }
});

test('P1 a backup failure blocks migration by default and only explicit degrade skips it', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-backup-fail-'));
  const env = {
    ...process.env,
    OMNI_HOME: home,
    DSH_HOME: home,
    OMNI_VERSION_CHECK_DISABLED: '1',
    OMNI_DISABLE_SEMANTIC: '1',
  };
  delete env.OMNI_MIGRATION_BACKUP_STRICT;
  delete env.OMNI_MIGRATION_BACKUP_DEGRADE;
  const seed = spawnSync(process.execPath, [
    path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'seed', '--limit', '1',
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  const legacy = openDb(home);
  legacy.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
  legacy.prepare('INSERT INTO notes(ts, scope, text, importance, text_hash) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'global', 'backup failure survivor', 0.9, createHash('sha256').update('backup failure survivor').digest('hex').slice(0, 32));
  legacy.close();

  const blocker = path.join(home, 'backups-is-a-file');
  writeFileSync(blocker, 'not a directory');
  const blocked = spawnSync(process.execPath, [
    path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'backup failure survivor', '--limit', '1',
  ], {
    cwd: ROOT,
    env: { ...env, OMNI_BACKUP_DIR: blocker },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.notEqual(blocked.status, 0, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, /migration backup failed/i);
  const stillLegacy = openDb(home);
  assert.equal(String(stillLegacy.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), '16');
  assert.equal(Number(stillLegacy.prepare("SELECT COUNT(*) AS n FROM notes WHERE text='backup failure survivor'").get().n), 1);
  stillLegacy.close();

  const degraded = spawnSync(process.execPath, [
    path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'backup failure survivor', '--limit', '1',
  ], {
    cwd: ROOT,
    env: { ...env, OMNI_BACKUP_DIR: blocker, OMNI_MIGRATION_BACKUP_DEGRADE: '1' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(degraded.status, 0, degraded.stderr || degraded.stdout);
  assert.match(degraded.stderr, /migration backup skipped/);
  const db = openDb(home);
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), String(SCHEMA_VERSION));
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE text='backup failure survivor'").get().n), 1);
  db.close();
});

test('P1 shared backup pruning only removes backups of the current database', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-shared-backup-'));
  const shared = path.join(home, 'shared-backups');
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  mkdirSync(shared, { recursive: true });
  const legacy = openDb(home);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5, scope TEXT NOT NULL DEFAULT 'global',
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER, contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
  `);
  legacy.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '1')").run();
  legacy.prepare('INSERT INTO notes(ts, text, importance, scope) VALUES (?, ?, ?, ?)')
    .run(1, 'shared backup survivor', 0.9, 'global');
  legacy.close();

  const tag = createHash('sha256').update(path.resolve(path.join(home, 'memory', 'omni.db'))).digest('hex').slice(0, 8);
  const oldCurrent = path.join(shared, `pre-migrate-v1-to-v${SCHEMA_VERSION}-${tag}-old.db`);
  const otherDatabase = path.join(shared, `pre-migrate-v1-to-v${SCHEMA_VERSION}-deadbeef-other.db`);
  writeFileSync(oldCurrent, 'old current database backup');
  writeFileSync(otherDatabase, 'another database backup');

  const run = spawnSync(process.execPath, [
    path.join(ROOT, 'hosts', 'cli.mjs'), 'search', 'shared backup survivor', '--limit', '1',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      OMNI_HOME: home,
      DSH_HOME: home,
      OMNI_BACKUP_DIR: shared,
      OMNI_MIGRATION_BACKUP_KEEP: '1',
      OMNI_VERSION_CHECK_DISABLED: '1',
      OMNI_DISABLE_SEMANTIC: '1',
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const names = readdirSync(shared);
  assert.equal(existsSync(otherDatabase), true, 'another database backup must not be pruned');
  assert.equal(existsSync(oldCurrent), false, 'old backup of the current database is pruned by KEEP=1');
  assert.equal(names.filter(name => name.startsWith(`pre-migrate-v1-to-v${SCHEMA_VERSION}-${tag}-`) && name.endsWith('.db')).length, 1);
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
  assert.equal(String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), String(SCHEMA_VERSION));
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
  assert.equal(String(stable.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), String(SCHEMA_VERSION));
  assert.equal(Number(stable.prepare('SELECT COUNT(*) AS n FROM notes WHERE text_hash IS NULL').get().n), 0);
  stable.close();
});
