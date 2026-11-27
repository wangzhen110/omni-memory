// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeHeadDelta } from '../scripts/release-delta.mjs';

const GIT = [process.env.GIT_BIN, 'C:\\Program Files\\Git\\cmd\\git.exe', 'git']
  .filter(Boolean)
  .find(candidate => candidate === 'git' || existsSync(candidate));

function git(repo, args) {
  return execFileSync(GIT, args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-release-delta-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'release-delta']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'note.md'), '# base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('release delta: HEAD equal to the signed commit is allowed', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    const delta = describeHeadDelta(git, repo, base, base);
    assert.equal(delta.allowed, true);
    assert.equal(delta.reason, 'head-is-release');
    assert.deepEqual(delta.files, []);
  } finally {
    cleanup(repo);
  }
});

test('release delta: docs-only descendants are allowed and counted', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(repo, 'docs', 'note.md'), '# base\n\nround 1\n');
    git(repo, ['commit', '-qam', 'docs: round 1']);
    writeFileSync(path.join(repo, 'docs', 'second.md'), '# second\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'docs: round 2']);
    const delta = describeHeadDelta(git, repo, base, git(repo, ['rev-parse', 'HEAD']));
    assert.equal(delta.allowed, true);
    assert.equal(delta.reason, 'docs-only-descendant');
    assert.equal(delta.commits, 2);
    assert.deepEqual(delta.files.sort(), ['docs/note.md', 'docs/second.md']);
  } finally {
    cleanup(repo);
  }
});

test('release delta: a source change after the release is refused', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'index.js'), 'export const x = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'src: change']);
    const delta = describeHeadDelta(git, repo, base, git(repo, ['rev-parse', 'HEAD']));
    assert.equal(delta.allowed, false);
    assert.equal(delta.reason, 'non-doc-change');
    assert.deepEqual(delta.files, ['src/index.js']);
  } finally {
    cleanup(repo);
  }
});

test('release delta: renaming a doc out of docs/ is not treated as documentation', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    renameSync(path.join(repo, 'docs', 'note.md'), path.join(repo, 'note.md'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'move note out of docs']);
    const delta = describeHeadDelta(git, repo, base, git(repo, ['rev-parse', 'HEAD']));
    assert.equal(delta.allowed, false);
    assert.equal(delta.reason, 'non-doc-change');
    assert.ok(delta.files.includes('note.md'), `expected the new path in ${delta.files.join(', ')}`);
  } finally {
    cleanup(repo);
  }
});

test('release delta: missing commits are refused instead of guessed', () => {
  const repo = makeRepo();
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    assert.equal(describeHeadDelta(git, repo, '', base).reason, 'missing-commit');
    assert.equal(describeHeadDelta(git, repo, base, '').reason, 'missing-commit');
  } finally {
    cleanup(repo);
  }
});
