import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installLauncherFromCommit, launcherTargetPath } from '../scripts/install-launcher.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';

function gitIn(dir, args) {
  const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('install-launcher stages a content-addressed binary and a sidecar config', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'omni-install-launcher-repo-'));
  const home = mkdtempSync(path.join(tmpdir(), 'omni-install-launcher-home-'));
  try {
    const launcher = Buffer.from('content addressed launcher');
    const sha256 = createHash('sha256').update(launcher).digest('hex');
    mkdirSync(path.join(repo, 'scripts', 'launchers'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts', 'launchers', 'omni-serve-7788.exe'), launcher);
    writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.8',
      omni: { launcher: { path: 'scripts/launchers/omni-serve-7788.exe', sha256 } },
    }, null, 2)}\n`);
    gitIn(repo, ['init', '-q']);
    gitIn(repo, ['config', 'user.email', 'test@example.com']);
    gitIn(repo, ['config', 'user.name', 'Test']);
    gitIn(repo, ['add', 'package.json', 'scripts/launchers/omni-serve-7788.exe']);
    gitIn(repo, ['commit', '-q', '-m', 'release']);
    const commit = gitIn(repo, ['rev-parse', 'HEAD']);

    const plan = installLauncherFromCommit({ repo, commit, home, task: 'NoSuchTask', noTask: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.target, launcherTargetPath(home, sha256));
    assert.equal(existsSync(plan.target), false);

    const applied = installLauncherFromCommit({ repo, commit, home, task: 'NoSuchTask', noTask: true, apply: true });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.dryRun, false);
    assert.equal(readFileSync(applied.target).equals(launcher), true);
    const sidecar = JSON.parse(readFileSync(applied.configFile, 'utf8'));
    assert.equal(sidecar.repo, repo);
    assert.equal(sidecar.port, 7788);
    assert.ok(path.isAbsolute(sidecar.node));

    const again = installLauncherFromCommit({ repo, commit, home, task: 'NoSuchTask', noTask: true, apply: true });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.installed, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('install-launcher refuses a commit whose package hash disagrees with the bytes', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'omni-install-launcher-bad-'));
  const home = mkdtempSync(path.join(tmpdir(), 'omni-install-launcher-bad-home-'));
  try {
    const launcher = Buffer.from('launcher payload');
    mkdirSync(path.join(repo, 'scripts', 'launchers'), { recursive: true });
    writeFileSync(path.join(repo, 'scripts', 'launchers', 'omni-serve-7788.exe'), launcher);
    writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.8',
      omni: { launcher: { path: 'scripts/launchers/omni-serve-7788.exe', sha256: '0'.repeat(64) } },
    }, null, 2)}\n`);
    gitIn(repo, ['init', '-q']);
    gitIn(repo, ['config', 'user.email', 'test@example.com']);
    gitIn(repo, ['config', 'user.name', 'Test']);
    gitIn(repo, ['add', 'package.json', 'scripts/launchers/omni-serve-7788.exe']);
    gitIn(repo, ['commit', '-q', '-m', 'bad release']);
    const commit = gitIn(repo, ['rev-parse', 'HEAD']);
    assert.throws(
      () => installLauncherFromCommit({ repo, commit, home, task: 'NoSuchTask', noTask: true, apply: true }),
      /launcher hash mismatch/,
    );
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.json')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
