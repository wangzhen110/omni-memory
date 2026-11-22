/**
 * Release benchmark for 3.11.0: write/list/overview/search at 100k and 1M rows.
 *
 * Usage: node bench/release.mjs [rows]
 * Output: JSON with machine, Node, fixture, five raw samples per metric and the
 * median. Uses boot()'s isolated temp OMNI_HOME; it never opens ~/.dsh/memory.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from '../test/helpers.mjs';

const ROWS = Number(process.argv[2] ?? 100000);
const SAMPLES = 5;
const noteRows = Math.max(1, Math.round(ROWS * 0.8));
const factRows = Math.max(0, Math.round(ROWS * 0.15));
const chunkRows = Math.max(0, ROWS - noteRows - factRows);
const textHash = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);

const app = await boot();
await app.call('memory_profile');
const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
const insertNote = db.prepare('INSERT INTO notes(ts, scope, text, text_hash, importance, source) VALUES (?, ?, ?, ?, ?, ?)');
const insertFts = db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)');
const insertFact = db.prepare('INSERT INTO facts(subject, relation, object, text, valid_from, scope, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertChunk = db.prepare('INSERT INTO chunks(ts, session_id, role, text, hash, source, scope) VALUES (?, ?, ?, ?, ?, ?, ?)');
const baseTs = Date.now() - ROWS * 2 * 1000;
const seedStarted = performance.now();
db.exec('BEGIN');
for (let i = 0; i < noteRows; i += 1) {
  const scope = i % 6 === 0 ? 'proj:bench#a' : i % 11 === 0 ? 'proj:bench#b' : 'global';
  const text = `压力测试条目 ${i} 关键词 alpha beta gamma 说明文字用于模拟真实长度`;
  const info = insertNote.run(baseTs + i * 2 * 1000, scope, text, textHash(text), 0.5, 'bench');
  insertFts.run(Number(info.lastInsertRowid), text);
}
for (let i = 0; i < factRows; i += 1) {
  const scope = i % 4 === 0 ? 'proj:bench#a' : 'global';
  insertFact.run(`主体${i}`, '属于', `对象${i}`, `压测事实 ${i} alpha beta`, baseTs + i * 3 * 1000, scope, 0.7);
}
for (let i = 0; i < chunkRows; i += 1) {
  const scope = i % 3 === 0 ? 'proj:bench#b' : 'global';
  insertChunk.run(baseTs + i * 4 * 1000, `bench-${i}`, 'user', `压测会话 ${i} 关键词 alpha`, `bench-${i}`, 'bench', scope);
}
db.exec('COMMIT');
const seedMs = performance.now() - seedStarted;
db.close();

const measure = async (fn) => {
  await fn(); // warm-up
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(Number((performance.now() - started).toFixed(1)));
  }
  samples.sort((a, b) => a - b);
  return { samples, median: samples[Math.floor(samples.length / 2)] };
};

const list = await measure(async () => {
  const { res } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=20&scope=all'), res);
});
const overview = await measure(async () => {
  const { res } = fakeRes();
  await app.route('/omni-memory/overview').handler(fakeReq('/omni-memory/overview?range=12w&scope=all'), res);
});
const search = await measure(async () => {
  const result = await app.call('memory_search', { query: 'alpha beta', limit: 8, scope: 'all' });
  if (!result.value?.hits?.length) throw new Error('benchmark search returned no hits');
});
const write = await measure(async () => {
  await app.call('memory_write', { kind: 'note', text: `压测写入 ${Date.now()} ${Math.random()}`, scope: 'global' });
});

const cpu = os.cpus()[0]?.model ?? 'unknown';
console.log(JSON.stringify({
  version: '3.11.0',
  rows: ROWS,
  fixture: { notes: noteRows, facts: factRows, chunks: chunkRows },
  machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu, totalMemGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)) },
  node: process.version,
  sqlite: process.versions.sqlite,
  seedMs: Number(seedMs.toFixed(1)),
  samples: SAMPLES,
  metrics: {
    write: { medianMs: write.median, samples: write.samples },
    list: { medianMs: list.median, samples: list.samples },
    overview: { medianMs: overview.median, samples: overview.samples },
    search: { medianMs: search.median, samples: search.samples },
  },
}, null, 2));
