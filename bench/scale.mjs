// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Scale + token-volume benchmark.
 *
 * Usage:
 *   node bench/scale.mjs [rows] [chars-per-note] [queries]
 *
 * Examples:
 *   node bench/scale.mjs 100000 100 100   # 100k notes, ~10M CJK characters
 *   node bench/scale.mjs 10000 1000 100   # 10k notes, ~10M CJK characters
 *
 * It uses an isolated OMNI_HOME, inserts directly through the same tables the
 * writer uses, then measures the public search path. It never opens the user's
 * real memory database.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ROWS = Number(process.argv[2] ?? 100000);
const CHARS = Math.max(32, Number(process.argv[3] ?? 100));
const QUERIES = Math.max(10, Number(process.argv[4] ?? 100));
const textHash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);

function noteText(index) {
  const target = index % QUERIES;
  const head = `scale-${String(index).padStart(6, '0')} scale-target-${target}`;
  const tail = ' 说明文字用于模拟真实长度，包含部署、检索、数据库、并发和故障恢复等主题。';
  let text = head + tail;
  while (text.length < CHARS) text += tail;
  return text.slice(0, CHARS);
}

const app = await boot();
await app.call('memory_profile');
const dbPath = path.join(app.home, 'memory', 'omni.db');
const rssBefore = process.memoryUsage().rss;

const db = new DatabaseSync(dbPath);
const insertNote = db.prepare('INSERT INTO notes(ts, scope, text, text_hash, importance, source) VALUES (?, ?, ?, ?, ?, ?)');
const insertFts = db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)');
const baseTs = Date.now() - ROWS * 1000;
const seedStarted = performance.now();
db.exec('BEGIN');
for (let i = 0; i < ROWS; i += 1) {
  const text = noteText(i);
  const info = insertNote.run(baseTs + i * 1000, 'global', text, textHash(text), 0.5, 'scale');
  insertFts.run(Number(info.lastInsertRowid), text);
}
db.exec('COMMIT');
const seedMs = performance.now() - seedStarted;
const rssAfter = process.memoryUsage().rss;
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
db.close();
const dbBytes = statSync(dbPath).size;

const samples = [];
let hitTotal = 0;
let minHits = Infinity;
for (let i = 0; i < QUERIES; i += 1) {
  const query = `scale-target-${i}`;
  const start = performance.now();
  const result = await app.call('memory_search', { query, limit: 8, scope: 'all' });
  samples.push(performance.now() - start);
  const hits = result.value?.hits?.length ?? 0;
  hitTotal += hits;
  minHits = Math.min(minHits, hits);
}

samples.sort((a, b) => a - b);
const at = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const totalChars = ROWS * CHARS;

console.log(JSON.stringify({
  version: pkg.version,
  rows: ROWS,
  charsPerNote: CHARS,
  totalChars,
  approxTokens: totalChars,
  queries: QUERIES,
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  },
  node: process.version,
  sqlite: process.versions.sqlite,
  seedMs: Number(seedMs.toFixed(1)),
  dbBytes,
  dbMiB: Number((dbBytes / 1024 ** 2).toFixed(1)),
  rssBeforeMiB: Number((rssBefore / 1024 ** 2).toFixed(1)),
  rssAfterMiB: Number((rssAfter / 1024 ** 2).toFixed(1)),
  rssDeltaMiB: Number(((rssAfter - rssBefore) / 1024 ** 2).toFixed(1)),
  hitTotal,
  minHitsPerQuery: minHits === Infinity ? 0 : minHits,
  p50: Number(at(0.5).toFixed(1)),
  p95: Number(at(0.95).toFixed(1)),
  max: Number(samples[samples.length - 1].toFixed(1)),
  pass: hitTotal > 0 && at(0.95) < 300,
}, null, 2));
