import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyLockPathForRepo } from '../scripts/daily-sync.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'daily-sync.mjs');
const FETCH_FIXTURE = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'mock-version-fetch.mjs')).href;
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';

function runIn(dir, args = [], extraEnv = {}) {
  const state = path.join(dir, 'state.json');
  const result = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--state', state, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    code: result.status,
    json: JSON.parse(String(result.stdout || '{}').trim().split('\n').at(-1)),
    stderr: result.stderr,
  };
}

test('daily-sync refuses a package that is not omni-memory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'other-project', version: '3.11.0' }));
  try {
    const result = runIn(dir);
    assert.equal(result.code, 2);
    assert.equal(result.json.action, 'not-omni-checkout');
    assert.match(result.json.error, /package name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync reports an invalid package version as structured JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@local/omni-memory', version: 'latest' }));
  try {
    const result = runIn(dir);
    assert.equal(result.code, 2);
    assert.equal(result.json.action, 'bad-version');
    assert.match(result.json.error, /invalid package version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync reports a missing package without crashing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-'));
  try {
    const result = runIn(dir);
    assert.equal(result.code, 2);
    assert.equal(result.json.action, 'not-a-project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync rejects an origin whose host only contains the repo string', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-origin-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.0',
    }));
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['remote', 'add', 'origin', 'https://github.com.evil/wangzhen110/omni-memory.git']);
    const first = runIn(dir);
    assert.equal(first.code, 2);
    assert.equal(first.json.action, 'not-omni-checkout');
    assert.match(first.json.error, /not https:\/\/github\.com\/wangzhen110\/omni-memory/);

    gitIn(['remote', 'set-url', 'origin', 'https://evil.com/github.com/wangzhen110/omni-memory.git']);
    const second = runIn(dir);
    assert.equal(second.code, 2);
    assert.equal(second.json.action, 'not-omni-checkout');
    assert.match(second.json.error, /not https:\/\/github\.com\/wangzhen110\/omni-memory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync refuses a second apply while the lock is held', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-lock-'));
  const home = path.join(dir, 'home');
  const previousHome = process.env.OMNI_HOME;
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.0',
    }));
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['remote', 'add', 'origin', 'https://github.com/wangzhen110/omni-memory.git']);
    process.env.OMNI_HOME = home;
    const lock = applyLockPathForRepo(dir);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    const result = runIn(dir, ['--apply'], { OMNI_HOME: home });
    assert.equal(result.code, 2);
    assert.equal(result.json.action, 'already-running');
  } finally {
    if (previousHome === undefined) delete process.env.OMNI_HOME;
    else process.env.OMNI_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync verifies the release manifest before moving HEAD', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-verify-'));
  const remote = path.join(dir, 'remote.git');
  const home = path.join(dir, 'home');
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.0',
    }));
    writeFileSync(path.join(dir, 'README.md'), 'clean\n');
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['remote', 'add', 'origin', 'https://github.com/wangzhen110/omni-memory.git']);
    gitIn(['add', 'package.json', 'README.md']);
    gitIn(['commit', '-q', '-m', 'init']);
    assert.equal(spawnSync(GIT, ['init', '--bare', '-q', remote], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync(GIT, ['-C', dir, 'push', '-q', remote, 'HEAD:refs/heads/main'], { encoding: 'utf8' }).status, 0);
    const headBefore = spawnSync(GIT, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const state = path.join(dir, 'state.json');
    const result = spawnSync(process.execPath, [
      '--import', FETCH_FIXTURE, SCRIPT, '--dir', dir, '--state', state, '--apply',
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OMNI_HOME: home,
        OMNI_TEST_MODE: '1',
        OMNI_TEST_GIT_FETCH_URL: remote,
        OMNI_TEST_REMOTE_VERSION: '3.11.7',
        OMNI_TEST_MANIFEST_JSON: JSON.stringify({
          schema: 'omni-update-manifest-v2',
          signature: 'not-a-valid-signature',
        }),
        OMNI_HEALTH_URL: 'http://127.0.0.1:1/health',
      },
    });
    const json = JSON.parse(String(result.stdout || '{}').trim().split('\n').at(-1));
    assert.equal(result.status, 2);
    assert.equal(json.action, 'signature-invalid');
    const headAfter = spawnSync(GIT, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(headAfter, headBefore, 'a rejected manifest must not move HEAD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync reports an update without applying or moving HEAD', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-report-'));
  const state = path.join(dir, 'state.json');
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.0',
    }));
    writeFileSync(path.join(dir, 'README.md'), 'clean\n');
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['remote', 'add', 'origin', 'https://github.com/wangzhen110/omni-memory.git']);
    gitIn(['add', 'package.json', 'README.md']);
    gitIn(['commit', '-q', '-m', 'init']);
    const headBefore = spawnSync(GIT, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const result = spawnSync(process.execPath, [
      '--import', FETCH_FIXTURE, SCRIPT, '--dir', dir, '--state', state,
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OMNI_TEST_MODE: '1',
        OMNI_TEST_REMOTE_VERSION: '3.11.5',
        OMNI_HEALTH_URL: 'http://127.0.0.1:1/health',
      },
    });
    const json = JSON.parse(String(result.stdout || '{}').trim().split('\n').at(-1));
    assert.equal(result.status, 0);
    assert.equal(json.action, 'update-available');
    assert.equal(json.reportOnly, true);
    assert.equal(json.signatureRequired, true);
    assert.equal(json.service?.restarted, false);
    const headAfter = spawnSync(GIT, ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(headAfter, headBefore, 'default run must not move HEAD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily-sync keeps a dirty checkout on the same-day gate without restarting', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-git-'));
  const state = path.join(dir, 'state.json');
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.0',
    }));
    writeFileSync(path.join(dir, 'README.md'), 'clean\n');
    const gitIn = args => {
      const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['remote', 'add', 'origin', 'https://github.com/wangzhen110/omni-memory.git']);
    gitIn(['add', 'package.json', 'README.md']);
    gitIn(['commit', '-q', '-m', 'init']);
    writeFileSync(path.join(dir, 'README.md'), 'dirty\n');

    const env = {
      ...process.env,
      OMNI_TEST_MODE: '1',
      OMNI_TEST_REMOTE_VERSION: '3.11.5',
      OMNI_HEALTH_URL: 'http://127.0.0.1:1/health',
    };
    const run = (args = []) => {
      const result = spawnSync(process.execPath, [
        '--import', FETCH_FIXTURE, SCRIPT, '--dir', dir, '--state', state, ...args,
      ], { cwd: dir, encoding: 'utf8', timeout: 15_000, env });
      return {
        code: result.status,
        json: JSON.parse(String(result.stdout || '{}').trim().split('\n').at(-1)),
      };
    };

    const first = run(['--apply']);
    assert.equal(first.code, 2);
    assert.equal(first.json.action, 'blocked-dirty');
    assert.equal(first.json.service?.restarted, false);
    assert.ok(existsSync(state));

    const second = run();
    assert.equal(second.code, 0);
    assert.equal(second.json.action, 'already-ran-today');
    assert.equal(second.json.skipped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
