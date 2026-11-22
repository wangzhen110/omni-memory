/**
 * v16 -> v17 legacy hash backfill benchmark.
 *
 * Usage: node bench/migrate.mjs [rows]
 *
 * Builds a v17-shape store, then removes notes.text_hash and rewrites the schema
 * marker to 16 so a fresh module performs the real v17 migration. FTS/bigram/
 * vector markers are left current, isolating the hash backfill cost.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ROWS = Number(process.argv[2] ?? 100000);
const NOTES = Math.max(1, Math.round(ROWS * 0.8));
const hash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);

const app = await boot();
await app.call('memory_profile');
const dbPath = path.join(app.home, 'memory', 'omni.db');

const db = new DatabaseSync(dbPath);
db.exec('DROP INDEX IF EXISTS notes_scope_text_hash');
db.exec('DROP INDEX IF EXISTS notes_text_hash_missing');
const insertNote = db.prepare('INSERT INTO notes(ts, scope, text, importance, source) VALUES (?, ?, ?, ?, ?)');
const seedStarted = performance.now();
db.exec('BEGIN');
for (let i = 0; i < NOTES; i += 1) {
  insertNote.run(Date.now() - i * 1000, i % 5 === 0 ? 'proj:migrate#a' : 'global', `迁移存量笔记 ${i} alpha beta gamma`, 0.5, 'bench');
}
db.exec('COMMIT');
const seedMs = performance.now() - seedStarted;

db.exec('ALTER TABLE notes DROP COLUMN text_hash');
db.prepare("UPDATE meta SET value = '16' WHERE key = 'schema_version'").run();
db.close();
app.mod.openStore().db.close();

const rssBefore = process.memoryUsage().rss;
const started = performance.now();
const fresh = await import(`../index.js?migrate=${Date.now()}`);
const opened = fresh.openStore();
const migrationMs = performance.now() - started;
const rssAfter = process.memoryUsage().rss;
const nulls = Number(opened.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE text_hash IS NULL').get().n);
const samples = opened.db.prepare('SELECT id, text, text_hash FROM notes ORDER BY id LIMIT 5').all();
const valid = samples.every(row => row.text_hash === hash(row.text));
const schema = opened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
const missingIndex = Boolean(opened.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='notes_text_hash_missing'").get());
opened.db.close();

console.log(JSON.stringify({
  version: pkg.version,
  rows: ROWS,
  notes: NOTES,
  migration: 'v16 -> v17 hash-only',
  machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model ?? 'unknown' },
  node: process.version,
  sqlite: process.versions.sqlite,
  seedMs: Number(seedMs.toFixed(1)),
  migrationMs: Number(migrationMs.toFixed(1)),
  per100kMs: Number((migrationMs / (NOTES / 100000)).toFixed(1)),
  rssDeltaMb: Number(((rssAfter - rssBefore) / 1024 ** 2).toFixed(1)),
  schema: String(schema ?? ''),
  nullHashes: nulls,
  sampleHashValid: valid,
  missingIndex,
}, null, 2));
