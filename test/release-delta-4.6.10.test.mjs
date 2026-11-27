// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeHeadDelta } from '../scripts/release-delta.mjs';
import { installLauncherFromCommit } from '../scripts/install-launcher.mjs';

const GIT = [process.env.GIT_BIN, 'C:\\Program Files\\Git\\cmd\\git.exe', 'git']
  .filter(Boolean)
  .find(candidate => candidate === 'git' || existsSync(candidate));

const LAUNCHER_PATH = 'scripts/launchers/omni-serve-7788.exe';
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function git(repo, args) {
  return execFileSync(GIT, args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function gitBytes(repo, spec) {
  return execFileSync(GIT, ['show', spec], { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-release-delta-4610-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'release-delta']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'note.md'), '# base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** A tiny commit-shaped repo with a hash-declared launcher. */
function makeLauncherRepo() {
  const dir = makeRepo();
  const launcher = Buffer.from('#!/bin/sh\necho omni\n');
  mkdirSync(path.join(dir, 'scripts', 'launchers'), { recursive: true });
  writeFileSync(path.join(dir, LAUNCHER_PATH), launcher);
  const pkg = {
    name: '@local/omni-memory',
    version: '1.0.0',
    omni: { launcher: { path: LAUNCHER_PATH, sha256: sha256(launcher) } },
  };
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'release']);
  return { dir, launcher, pkg };
}

test('release delta: a git failure on merge-base is not reported as "not a descendant"', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(repo, 'docs', 'note.md'), '# base\n\nmore\n');
    git(repo, ['commit', '-qam', 'docs: more']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const real = (dir, args) => {
      if (args[0] === 'merge-base') {
        const error = new Error('fatal: unable to read repository');
        error.status = 128;
        throw error;
      }
      return git(dir, args);
    };
    const delta = describeHeadDelta(real, repo, base, head);
    assert.equal(delta.allowed, false);
    assert.equal(delta.reason, 'git-failed');
  } finally {
    cleanup(repo);
  }
});

test('release delta: merge-base exit 1 still means "not an ancestor"', () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const fake = (dir, args) => {
    if (args[0] === 'rev-list') return '1';
    if (args[0] === 'merge-base') {
      const error = new Error('exit 1');
      error.status = 1;
      throw error;
    }
    return '';
  };
  const delta = describeHeadDelta(fake, '.', base, head);
  assert.equal(delta.allowed, false);
  assert.equal(delta.reason, 'not-a-descendant');
});

test('install: launcher bytes come from the release commit even when HEAD is ahead', () => {
  const { dir, launcher } = makeLauncherRepo();
  const home = mkdtempSync(path.join(tmpdir(), 'omni-install-home-'));
  try {
    const release = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(dir, 'docs', 'note.md'), '# base\n\nlater docs\n');
    git(dir, ['commit', '-qam', 'docs: later']);
    const plan = installLauncherFromCommit({
      repo: dir,
      home,
      commit: release,
      expectedPackageJsonSha256: sha256(gitBytes(dir, `${release}:package.json`)),
      expectedLauncherSha256: sha256(launcher),
      apply: false,
      task: 'OmniMemoryTest',
      noTask: true,
      taskQuery: () => ({ state: 'skipped', command: null, error: null }),
    });
    assert.equal(plan.commit, release);
    assert.equal(plan.sha256, sha256(launcher));
    assert.equal(plan.manifestHashMatched, true);
  } finally {
    cleanup(dir);
    cleanup(home);
  }
});

test('install: a launcher hash that disagrees with the release commit is refused', () => {
  const { dir } = makeLauncherRepo();
  try {
    const release = git(dir, ['rev-parse', 'HEAD']);
    assert.throws(
      () => installLauncherFromCommit({
        repo: dir,
        home: dir,
        commit: release,
        expectedLauncherSha256: 'f'.repeat(64),
        apply: false,
        noTask: true,
        taskQuery: () => ({ state: 'skipped', command: null, error: null }),
      }),
      /launcher at .* does not match the signed release manifest/,
    );
  } finally {
    cleanup(dir);
  }
});

test('install: a package.json hash that disagrees with the release commit is refused', () => {
  const { dir } = makeLauncherRepo();
  try {
    const release = git(dir, ['rev-parse', 'HEAD']);
    assert.throws(
      () => installLauncherFromCommit({
        repo: dir,
        home: dir,
        commit: release,
        expectedPackageJsonSha256: 'f'.repeat(64),
        apply: false,
        noTask: true,
        taskQuery: () => ({ state: 'skipped', command: null, error: null }),
      }),
      /package.json at .* does not match the signed release manifest/,
    );
  } finally {
    cleanup(dir);
  }
});
