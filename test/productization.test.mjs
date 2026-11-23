// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.taskMissing, true);
    assert.equal(plan.taskWillBeCreated, true);
    assert.equal(plan.noTask, false);
    assert.equal(existsSync(plan.target), false);
    assert.equal(existsSync(plan.configFile), false);

    const skip = installLauncherFromCommit({
      repo: ROOT,
      home,
      task: 'OmniMemoryProductizationTest',
      createTask: false,
      apply: false,
    });
    assert.equal(skip.noTask, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
