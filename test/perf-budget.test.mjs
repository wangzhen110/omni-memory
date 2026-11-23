/**
 * ADR-020 performance budget as a repeatable CI gate.
 *
 * Turns the 10k / 100k p95 numbers that used to live only in bench/bench.mjs
 * into assertions: p95 < 300ms (NFR-01 / ADR-020) AND the query must return
 * real hits (the old bench wrote scope='bench' and silently hit 0 rows).
 *
 * Run: node --test test/perf-budget.test.mjs
 *   OMNI_PERF_100K=1  force the 100k scenario on
 *   OMNI_PERF_100K=0  force the 100k scenario off
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { boot } from './helpers.mjs';
import { supportsFts5 } from './fts-support.mjs';

const P95_BUDGET_MS = 300; // ADR-020 / NFR-01 — never replace with a per-machine number
const WARMUP = 3;
const QUERIES = 25; // within the requested 20–30 range

// ADR-020 "未来" asks to put the 10k/100k p95 thresholds into CI while keeping
// 1M record-only so CI time stays bounded. Reference measurement (Node 22,
// Windows): 100k seed + 25 queries ≈ 1.2s total, far below the suggested 30s,
// so it runs by default. Flip to false (or set OMNI_PERF_100K=0) on a slower CI.
const ENABLE_100K_BY_DEFAULT = true;
const env100k = process.env.OMNI_PERF_100K;
const run100k = env100k === '1' ? true : env100k === '0' ? false : ENABLE_100K_BY_DEFAULT;
const skip100k = run100k
  ? false
  : '100k 场景耗时较长（见 OMNI_PERF_100K），默认跳过；设置 OMNI_PERF_100K=1 可显式启用';

const noteText = i => `压力测试条目 ${i} 关键词 alpha beta gamma 说明文字用于模拟真实长度`;
const queryFor = i => (i % 3 === 0 ? 'alpha beta' : i % 3 === 1 ? '压力测试条目' : `条目 ${i}`);

/** Bulk-insert rows + FTS in one transaction (single memory_write per row is too slow). */
function seed(app, rows) {
  const started = Date.now();
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    const insertNote = db.prepare('INSERT INTO notes(ts, scope, text, importance, source) VALUES (?, ?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO notes_fts(rowid, text) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < rows; i += 1) {
      const text = noteText(i);
      const info = insertNote.run(Date.now() - i * 1000, 'global', text, (i % 100) / 100, 'perf-budget');
      try { insertFts.run(Number(info.lastInsertRowid), text); } catch { /* ignore duplicate rowid */ }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw err;
  } finally {
    db.close();
  }
  return Date.now() - started;
}

/** Warm up, then time memory_search and return the measured p95 / hit total. */
async function measure(app) {
  for (let i = 0; i < WARMUP; i += 1) {
    await app.call('memory_search', { query: queryFor(i), limit: 8 });
  }
  const samples = [];
  let hitTotal = 0;
  for (let i = 0; i < QUERIES; i += 1) {
    const t0 = process.hrtime.bigint();
    const result = await app.call('memory_search', { query: queryFor(i), limit: 8 });
    const t1 = process.hrtime.bigint();
    hitTotal += result.value?.hits?.length ?? 0;
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const at = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  return {
    p95: Number(at(0.95).toFixed(1)),
    max: Number(samples[samples.length - 1].toFixed(1)),
    hitTotal,
  };
}

async function runScenario(rows) {
  const app = await boot();
  const started = Date.now();
  try {
    await app.call('memory_profile'); // open + migrate before touching omni.db
    const seedMs = await seed(app, rows);
    const stats = await measure(app);
    return { seedMs, totalMs: Date.now() - started, ...stats };
  } finally {
    try {
      rmSync(app.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort: a still-open handle may hold the file on Windows */ }
  }
}

test('ADR-020 p95 budget: 10k rows < 300ms with real hits', { timeout: 120_000 }, async t => {
  if (!supportsFts5()) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }
  const r = await runScenario(10_000);
  t.diagnostic(`10k rows: seed=${r.seedMs}ms p95=${r.p95}ms max=${r.max}ms hitTotal=${r.hitTotal} total=${r.totalMs}ms`);
  assert.ok(
    r.p95 < P95_BUDGET_MS,
    `10k p95 ${r.p95}ms exceeded the ADR-020 budget of ${P95_BUDGET_MS}ms`,
  );
  assert.ok(r.hitTotal > 0, '10k queries must return real hits (not an empty-index pass)');
});

test('ADR-020 p95 budget: 100k rows < 300ms with real hits', { timeout: 120_000, skip: skip100k }, async t => {
  if (!supportsFts5()) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }
  const r = await runScenario(100_000);
  t.diagnostic(`100k rows: seed=${r.seedMs}ms p95=${r.p95}ms max=${r.max}ms hitTotal=${r.hitTotal} total=${r.totalMs}ms`);
  assert.ok(
    r.p95 < P95_BUDGET_MS,
    `100k p95 ${r.p95}ms exceeded the ADR-020 budget of ${P95_BUDGET_MS}ms`,
  );
  assert.ok(r.hitTotal > 0, '100k queries must return real hits (not an empty-index pass)');
});
