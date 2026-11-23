import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyUpdateManifest, UPDATE_KEY_ID } from '../lib/update-signature.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sign-release.mjs');
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';

test('sign-release binds a commit, package hash, version and tag into a verifiable manifest', t => {
  const git = spawnSync(GIT, ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip('git is unavailable');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-sign-release-'));
  const out = path.join(dir, 'omni-update-manifest.json');
  const keyPath = path.join(dir, 'signing-key.pem');
  const pkg = { name: '@local/omni-memory', version: '3.11.6' };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg)}\n`);
  const gitIn = args => {
    const result = spawnSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    gitIn(['init', '-q']);
    gitIn(['config', 'user.email', 'test@example.com']);
    gitIn(['config', 'user.name', 'Test']);
    gitIn(['add', 'package.json']);
    gitIn(['commit', '-q', '-m', 'release 3.11.6']);
    const commit = gitIn(['rev-parse', 'HEAD']);
    const result = spawnSync(process.execPath, [
      SCRIPT, '--dir', dir, '--version', '3.11.6', '--commit', commit, '--tag', 'v3.11.6',
      '--key', keyPath, '--out', out,
    ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.version, '3.11.6');
    assert.equal(manifest.tag, 'v3.11.6');
    assert.equal(manifest.packageJsonSha256, createHash('sha256').update(readFileSync(path.join(dir, 'package.json'))).digest('hex'));
    const verified = verifyUpdateManifest(manifest, {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      keyId: UPDATE_KEY_ID,
    });
    assert.equal(verified.ok, true, verified.error);

    const mismatch = spawnSync(process.execPath, [
      SCRIPT, '--dir', dir, '--version', '3.11.7', '--commit', commit, '--tag', 'v3.11.7',
      '--key', keyPath, '--out', path.join(dir, 'bad.json'),
    ], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(mismatch.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
