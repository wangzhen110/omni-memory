// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Multi-process contract: several AI hosts each spawn their own server process
 * and all of them write into the same SQLite file. The store must survive that
 * without losing a row, without deadlocking, and without duplicating text that
 * two processes happened to write at the same moment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKER = path.join(ROOT, 'test', 'fixtures', 'concurrency-worker.mjs');

function runWorker(home, label, count, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', WORKER, label, String(count), mode], {
      cwd: home,
      env: { ...process.env, OMNI_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${label} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function removeTree(dir) {
  // Windows can keep a just-exited worker's SQLite handle for a short while.
  // rmSync's maxRetries does not cover every rmdir EBUSY path, so retry here.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

test('concurrent processes write to one store without losing rows', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-concurrency-'));
  try {
    await Promise.all([
      // Distinct texts: every one of them must survive.
      runWorker(home, 'a', 8, 'unique'),
      runWorker(home, 'b', 8, 'unique'),
      runWorker(home, 'c', 8, 'unique'),
      // Identical text: the dedupe check must hold across processes, so these
      // three writers collapse into exactly one note.
      runWorker(home, 's1', 8, 'same'),
      runWorker(home, 's2', 8, 'same'),
      runWorker(home, 's3', 8, 'same'),
    ]);

    const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
    const unique = db.prepare(
      "SELECT COUNT(*) AS n FROM notes WHERE text LIKE 'concurrent note %' AND deleted_at IS NULL"
    ).get();
    const same = db.prepare(
      "SELECT COUNT(*) AS n FROM notes WHERE text = 'concurrent identical note' AND deleted_at IS NULL"
    ).get();
    const lease = db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lease:%'").get();
    db.close();

    assert.equal(Number(unique.n), 24, 'all distinct writes must be present');
    assert.equal(Number(same.n), 1, 'identical text from three processes must collapse to one row');
    assert.equal(Number(lease.n), 0, 'maintenance lease must be released after boot');
  } finally {
    await removeTree(home);
  }
});
