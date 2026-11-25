// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(ROOT, file), 'utf8');

test('LICENSE is AGPL-3.0 and package metadata agrees', () => {
  const license = read('LICENSE');
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'AGPL-3.0-only');
  assert.equal(pkg.version, '4.3.0');
});

test('governance and onboarding files exist', () => {
  for (const file of [
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'GOVERNANCE.md',
    'docs/QUICKSTART.md',
    'docs/INSTALL-RELEASE.md',
    'docs/PUBLIC-QA.md',
    'docs/VERIFY-RELEASE.md',
  ]) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} is missing`);
  }
});

test('setup defaults to release verification and keeps a dev escape hatch', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.setup, /--require-release/);
  assert.match(pkg.scripts['setup:dev'], /scripts\/install\.mjs/);
  assert.doesNotMatch(pkg.scripts['setup:dev'], /--require-release/);
  assert.match(pkg.scripts.demo, /scripts\/demo\.mjs/);
  assert.match(pkg.scripts.qa, /scripts\/qa\.mjs/);
});

test('install help documents the fail-closed release path', () => {
  const help = execFileSync(process.execPath, ['scripts/install.mjs', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(help, /--require-release/);
  assert.match(help, /npm run setup:dev/);
  assert.match(help, /发布验签安装/);
});
