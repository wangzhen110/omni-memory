import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.js');
const HOME = mkdtempSync(path.join(tmpdir(), 'omni-open-lease-'));
const DB_DIR = path.join(HOME, 'memory');
const DB_FILE = path.join(DB_DIR, 'omni.db');
mkdirSync(DB_DIR, { recursive: true });

function holdLease() {
  const db = new DatabaseSync(DB_FILE);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('lease:open-maintenance', ?)")
    .run(String(Date.now() + 120_000));
  db.close();
}

test('a second opener waits past the old 5s lease window instead of failing', async () => {
  holdLease();
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { openStore } from ${JSON.stringify(pathToFileURL(INDEX).href)}; const s = openStore(); s.db.close(); console.log('OPENED');`,
  ], {
    env: {
      ...process.env,
      OMNI_HOME: HOME,
      OMNI_OPEN_LEASE_WAIT_MS: '15000',
      OMNI_DISABLE_SEMANTIC: '1',
      OMNI_DISABLE_VECTOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  // The old implementation gave up after 25 × 200ms (~5.2s). Release just
  // after that point: a 15s waiter succeeds, the old code has already failed.
  const releaseTimer = setTimeout(() => {
    const db = new DatabaseSync(DB_FILE);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare("DELETE FROM meta WHERE key = 'lease:open-maintenance'").run();
    db.close();
  }, 6000);
  const exitCode = await new Promise((resolve, reject) => {
    const hardTimeout = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit; output=${output}`));
    }, 25_000);
    child.once('exit', code => {
      clearTimeout(hardTimeout);
      resolve(code);
    });
  }).finally(() => clearTimeout(releaseTimer));

  try {
    assert.equal(exitCode, 0, output);
    assert.match(output, /OPENED/);
  } finally {
    rmSync(HOME, { recursive: true, force: true });
  }
});
