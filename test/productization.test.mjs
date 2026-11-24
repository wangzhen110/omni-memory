// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { runDoctor } from '../hosts/shared/doctor.mjs';
import { staticAssetName } from '../hosts/http/server.mjs';
import { installLauncherFromCommit } from '../scripts/install-launcher.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempHome(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

test('doctor on a fresh home is warning-only and never creates a database', async () => {
  const home = tempHome('omni-doctor');
  try {
    const result = await runDoctor({ repo: ROOT, home, port: false, task: false });
    assert.equal(result.ok, true);
    assert.equal(result.counts.fail, 0);
    assert.equal(result.checks.find(check => check.name === 'database').status, 'warn');
    assert.equal(result.checks.find(check => check.name === 'data-dir').status, 'warn');
    assert.equal(existsSync(path.join(home, 'memory', 'omni.db')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor treats a tiny main database file as a warning, not a failure', async () => {
  const home = tempHome('omni-doctor-small');
  try {
    const memoryDir = path.join(home, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    const dbFile = path.join(memoryDir, 'omni.db');
    const db = new DatabaseSync(dbFile);
    try {
      // 512-byte pages keep the main file below doctor's 4096-byte warning
      // threshold while still being a structurally valid database.
      db.exec(`
        PRAGMA page_size = 512;
        CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT);
        CREATE TABLE facts(id INTEGER PRIMARY KEY);
        CREATE TABLE chunks(id INTEGER PRIMARY KEY);
      `);
    } finally {
      db.close();
    }

    const result = await runDoctor({ repo: ROOT, home, port: false, task: false });
    const database = result.checks.find(check => check.name === 'database');
    assert.equal(result.ok, true);
    assert.equal(database.status, 'warn');
    assert.match(database.detail, /main database file is only/);
    assert.match(database.detail, /WAL may still hold the data/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('extensionless product entry points resolve to real static files', () => {
  assert.equal(staticAssetName('/'), 'index.html');
  assert.equal(staticAssetName('/hub'), 'hub.html');
  assert.equal(staticAssetName('/hub/'), 'hub.html');
  assert.equal(staticAssetName('/m'), 'm.html');
  assert.equal(staticAssetName('/m/'), 'm.html');
  assert.equal(staticAssetName('/panel.html'), 'panel.html');
});

test('launcher dry-run plans a task without writing or creating it', () => {
  const home = tempHome('omni-launcher');
  try {
    const plan = installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      createTask: true,
      apply: false,
      taskQuery: () => ({ state: 'missing', command: null, error: null }),
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.taskMissing, true);
    assert.equal(plan.taskWillBeCreated, true);
    assert.equal(plan.noTask, false);
    assert.equal(plan.launcherIntegrity, 'sha256-in-commit');
    assert.equal(plan.releaseSignatureVerified, false);
    assert.equal(existsSync(plan.target), false);
    assert.equal(existsSync(plan.configFile), false);

    const skip = installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      createTask: false,
      apply: false,
      taskQuery: () => ({ state: 'missing', command: null, error: null }),
    });
    assert.equal(skip.noTask, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('launcher refuses to guess when the task probe is inconclusive', () => {
  const home = tempHome('omni-launcher-unknown');
  try {
    const plan = installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      createTask: true,
      apply: false,
      taskQuery: () => ({ state: 'unknown', command: null, error: 'access denied' }),
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.taskUnknown, true);
    assert.equal(plan.taskWillBeCreated, false);
    assert.equal(plan.taskError, 'access denied');
    assert.throws(() => installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      createTask: true,
      apply: true,
      taskQuery: () => ({ state: 'unknown', command: null, error: 'access denied' }),
    }), /cannot determine whether scheduled task/);
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.json')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('noTask never calls the scheduled-task probe', () => {
  const home = tempHome('omni-launcher-notask');
  try {
    let calls = 0;
    const plan = installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      noTask: true,
      apply: false,
      taskQuery: () => {
        calls += 1;
        return { state: 'unknown', command: null, error: 'should not run' };
      },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.noTask, true);
    assert.equal(plan.taskState, 'skipped');
    assert.equal(calls, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
