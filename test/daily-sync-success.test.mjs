import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publicKeyFingerprint, signUpdateManifest, UPDATE_KEY_ID } from '../lib/update-signature.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'daily-sync.mjs');
const FIXTURE = pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'mock-version-fetch.mjs')).href;
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const LAUNCHER = path.join(ROOT, 'scripts', 'launchers', 'omni-serve-7788.exe');

function gitIn(dir, args) {
  const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('daily-sync apply verifies, fast-forwards, gates syntax and installs the launcher', t => {
  if (process.platform !== 'win32') {
    t.skip('launcher installation is Windows-only');
    return;
  }
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0 || !existsSync(LAUNCHER)) {
    t.skip('git or the launcher binary is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-success-'));
  const targetDir = mkdtempSync(path.join(tmpdir(), 'omni-daily-sync-target-'));
  const remote = path.join(dir, 'remote.git');
  const home = path.join(dir, 'home');
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@local/omni-memory', version: '3.11.7' }, null, 2));
    writeFileSync(path.join(dir, 'README.md'), 'clean\n');
    gitIn(dir, ['init', '-q']);
    gitIn(dir, ['config', 'user.email', 'test@example.com']);
    gitIn(dir, ['config', 'user.name', 'Test']);
    gitIn(dir, ['remote', 'add', 'origin', 'https://github.com/wangzhen110/omni-memory.git']);
    gitIn(dir, ['add', 'package.json', 'README.md']);
    gitIn(dir, ['commit', '-q', '-m', 'base']);
    const baseCommit = gitIn(dir, ['rev-parse', 'HEAD']);
    assert.equal(spawnSync(GIT, ['init', '--bare', '-q', remote], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync(GIT, ['-C', dir, 'push', '-q', remote, 'HEAD:refs/heads/main'], { encoding: 'utf8' }).status, 0);

    assert.equal(spawnSync(GIT, ['clone', '-q', remote, targetDir], { encoding: 'utf8' }).status, 0);
    gitIn(targetDir, ['checkout', '-B', 'main', 'origin/main']);
    const launcherBytes = readFileSync(LAUNCHER);
    const launcherSha256 = createHash('sha256').update(launcherBytes).digest('hex');
    mkdirSync(path.join(targetDir, 'scripts', 'launchers'), { recursive: true });
    copyFileSync(LAUNCHER, path.join(targetDir, 'scripts', 'launchers', 'omni-serve-7788.exe'));
    writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.8',
      omni: { launcher: { path: 'scripts/launchers/omni-serve-7788.exe', sha256: launcherSha256 } },
    }, null, 2));
    gitIn(targetDir, ['config', 'user.email', 'test@example.com']);
    gitIn(targetDir, ['config', 'user.name', 'Test']);
    gitIn(targetDir, ['add', 'package.json', 'scripts/launchers/omni-serve-7788.exe']);
    gitIn(targetDir, ['commit', '-q', '-m', 'release 3.11.8']);
    const targetCommit = gitIn(targetDir, ['rev-parse', 'HEAD']);
    const targetPush = spawnSync(GIT, ['-C', targetDir, 'push', '-q', 'origin', 'HEAD:main'], { encoding: 'utf8' });
    assert.equal(targetPush.status, 0, targetPush.stderr);

    const packageRaw = spawnSync(GIT, ['-C', targetDir, 'show', `${targetCommit}:package.json`], { encoding: 'buffer' }).stdout;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const keyFile = path.join(dir, 'test-key.pem');
    writeFileSync(keyFile, publicKeyPem);
    const manifest = signUpdateManifest({
      schema: 'omni-update-manifest-v2',
      keyId: UPDATE_KEY_ID,
      version: '3.11.8',
      packageName: '@local/omni-memory',
      packageVersion: '3.11.8',
      commit: targetCommit,
      packageJsonSha256: createHash('sha256').update(packageRaw).digest('hex'),
      launcherPath: 'scripts/launchers/omni-serve-7788.exe',
      launcherSha256,
      tag: 'v3.11.8',
      issuedAt: new Date().toISOString(),
    }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const result = spawnSync(process.execPath, [
      '--import', FIXTURE, SCRIPT, '--dir', dir, '--state', path.join(dir, 'state.json'), '--apply', '--skip-tests',
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        OMNI_HOME: home,
        OMNI_SERVICE_TASK: 'OmniMemory7788NoTask',
        OMNI_HEALTH_URL: 'http://127.0.0.1:1/health',
        OMNI_TEST_GIT_FETCH_URL: remote,
        OMNI_TEST_REMOTE_VERSION: '3.11.8',
        OMNI_TEST_MANIFEST_JSON: JSON.stringify(manifest),
        OMNI_TEST_UPDATE_PUBLIC_KEY_FILE: keyFile,
        OMNI_TEST_UPDATE_PUBLIC_KEY_SHA256: publicKeyFingerprint(publicKeyPem),
        OMNI_TEST_UPDATE_KEY_ID: UPDATE_KEY_ID,
      },
    });
    const json = JSON.parse(String(result.stdout || '{}').trim().split('\n').at(-1));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(json.action, 'updated');
    assert.equal(json.ok, true);
    assert.equal(json.signature.verified, true);
    assert.equal(json.headBefore, baseCommit);
    assert.equal(json.headAfter, targetCommit);
    assert.equal(json.localVersionAfter, '3.11.8');
    assert.equal(json.launcher.ok, true);
    assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), targetCommit);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '3.11.8');
    assert.equal(existsSync(path.join(home, 'omni-serve-7788.json')), true);
    const sidecar = JSON.parse(readFileSync(path.join(home, 'omni-serve-7788.json'), 'utf8'));
    assert.equal(sidecar.repo, dir);
    assert.equal(existsSync(path.join(home, `omni-serve-7788-${launcherSha256.slice(0, 8)}.exe`)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});
