import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyUpdateManifest, UPDATE_KEY_ID } from '../lib/update-signature.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sign-release.mjs');
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const LAUNCHER = path.join(ROOT, 'scripts', 'launchers', 'omni-serve-7788.exe');

test('sign-release binds a commit and the launcher bytes into a verifiable manifest', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0 || !existsSync(LAUNCHER)) {
    t.skip('git or the launcher binary is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-sign-release-'));
  const out = path.join(dir, 'omni-update-manifest-v2.json');
  const legacyOut = path.join(dir, 'omni-update-manifest.json');
  const keyPath = path.join(dir, 'signing-key.pem');
  const launcherSha256 = createHash('sha256').update(readFileSync(LAUNCHER)).digest('hex');
  const pkg = {
    name: '@local/omni-memory',
    version: '3.11.8',
    omni: { launcher: { path: 'scripts/launchers/omni-serve-7788.exe', sha256: launcherSha256 } },
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  mkdirSync(path.join(dir, 'scripts', 'launchers'), { recursive: true });
  copyFileSync(LAUNCHER, path.join(dir, 'scripts', 'launchers', 'omni-serve-7788.exe'));
  const gitIn = args => {
    const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['add', 'package.json', 'scripts/launchers/omni-serve-7788.exe']);
    gitIn(['commit', '-q', '-m', 'release 3.11.8']);
    const commit = gitIn(['rev-parse', 'HEAD']);
    const result = spawnSync(process.execPath, [
      SCRIPT, '--dir', dir, '--version', '3.11.8', '--commit', commit, '--tag', 'v3.11.8',
      '--key', keyPath, '--out', out,
    ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(manifest.schema, 'omni-update-manifest-v2');
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.version, '3.11.8');
    assert.equal(manifest.tag, 'v3.11.8');
    assert.equal(manifest.launcherSha256, launcherSha256);
    assert.equal(manifest.packageJsonSha256, createHash('sha256').update(readFileSync(path.join(dir, 'package.json'))).digest('hex'));
    const verified = verifyUpdateManifest(manifest, {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      keyId: UPDATE_KEY_ID,
    });
    assert.equal(verified.ok, true, verified.error);

    const legacy = spawnSync(process.execPath, [
      SCRIPT, '--dir', dir, '--version', '3.11.8', '--commit', commit, '--tag', 'v3.11.8',
      '--key', keyPath, '--schema', 'v1', '--out', legacyOut,
    ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
    const legacyManifest = JSON.parse(readFileSync(legacyOut, 'utf8'));
    assert.equal(legacyManifest.schema, 'omni-update-manifest-v1');
    assert.equal(legacyManifest.launcherPath, undefined);
    assert.equal(verifyUpdateManifest(legacyManifest, {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      keyId: UPDATE_KEY_ID,
    }).ok, true);

    const mismatch = spawnSync(process.execPath, [
      SCRIPT, '--dir', dir, '--version', '3.11.9', '--commit', commit, '--tag', 'v3.11.9',
      '--key', keyPath, '--out', path.join(dir, 'bad.json'),
    ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(mismatch.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
