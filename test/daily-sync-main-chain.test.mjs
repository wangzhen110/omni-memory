import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyLockPathForRepo, isGitHubApiUrl, safeResetToBefore } from '../scripts/daily-sync.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';

test('the apply lock is keyed by the real checkout, not by --state', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-lock-key-'));
  try {
    const one = applyLockPathForRepo(dir);
    const two = applyLockPathForRepo(dir);
    assert.equal(one, two);
    assert.match(path.basename(one), /^omni-daily-sync-[0-9a-f]{16}\.apply\.lock$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub bearer-token gate rejects lookalike hostnames', () => {
  assert.equal(isGitHubApiUrl('https://api.github.com/repos/x/y'), true);
  assert.equal(isGitHubApiUrl('https://api.github.com.attacker.example/repos/x/y'), false);
  assert.equal(isGitHubApiUrl('https://evil.example/api.github.com/repos/x/y'), false);
  assert.equal(isGitHubApiUrl('http://api.github.com/repos/x/y'), false);
});

test('rollback refuses to discard tracked changes made after merge', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-safe-reset-'));
  try {
    writeFileSync(path.join(dir, 'tracked.txt'), 'clean\n');
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['add', 'tracked.txt']);
    gitIn(['commit', '-q', '-m', 'init']);
    const before = spawnSync(GIT, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(dir, 'tracked.txt'), 'user change\n');
    const result = safeResetToBefore(dir, before);
    assert.equal(result.ok, false);
    assert.match(result.error, /refusing rollback/);
    const text = spawnSync(GIT, ['-C', dir, 'show', 'HEAD:tracked.txt'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(text, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
