import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyManifestForRepo } from '../scripts/daily-sync.mjs';
import { publicKeyFingerprint, signUpdateManifest, UPDATE_KEY_ID } from '../lib/update-signature.mjs';

const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'git'].find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const TEST_KEY_ID = 'test-key';

test('the signed commit, package hash and launcher bytes are checked before a fast-forward', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-signed-apply-'));
  try {
    const launcher = Buffer.from('test launcher bytes');
    const launcherSha256 = createHash('sha256').update(launcher).digest('hex');
    mkdirSync(path.join(dir, 'scripts', 'launchers'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'launchers', 'omni-serve-7788.exe'), launcher);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.6',
      omni: { launcher: { path: 'scripts/launchers/omni-serve-7788.exe', sha256: launcherSha256 } },
    }));
    const git = args => execFileSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json', 'scripts/launchers/omni-serve-7788.exe']);
    git(['commit', '-q', '-m', 'signed']);
    const commit = git(['rev-parse', 'HEAD']);
    const raw = execFileSync(GIT, ['-C', dir, 'show', `${commit}:package.json`], { maxBuffer: 16 * 1024 * 1024 });

    const base = {
      schema: 'omni-update-manifest-v2',
      keyId: TEST_KEY_ID,
      version: '3.11.6',
      packageName: '@local/omni-memory',
      packageVersion: '3.11.6',
      commit,
      packageJsonSha256: createHash('sha256').update(raw).digest('hex'),
      launcherPath: 'scripts/launchers/omni-serve-7788.exe',
      launcherSha256,
      tag: 'v3.11.6',
      issuedAt: new Date().toISOString(),
    };
    const signed = signUpdateManifest(base, privateKeyPem);
    const options = {
      publicKeyPem,
      keyId: TEST_KEY_ID,
      expectedFingerprint: publicKeyFingerprint(publicKeyPem),
    };

    const verified = verifyManifestForRepo(dir, signed, '3.11.6', options);
    assert.equal(verified.manifest.commit, commit);
    assert.equal(verified.manifest.packageJsonSha256, base.packageJsonSha256);
    assert.equal(verified.manifest.launcherSha256, launcherSha256);

    const tamperedHash = signUpdateManifest({ ...base, packageJsonSha256: '0'.repeat(64) }, privateKeyPem);
    assert.throws(
      () => verifyManifestForRepo(dir, tamperedHash, '3.11.6', options),
      error => error?.code === 'package-hash-mismatch',
    );
    const tamperedLauncher = signUpdateManifest({ ...base, launcherSha256: '0'.repeat(64) }, privateKeyPem);
    assert.throws(
      () => verifyManifestForRepo(dir, tamperedLauncher, '3.11.6', options),
      error => error?.code === 'launcher-hash-mismatch',
    );
    assert.throws(
      () => verifyManifestForRepo(dir, { ...signed, signature: 'AAAA' }, '3.11.6', options),
      error => error?.code === 'signature-invalid',
    );
    assert.throws(
      () => verifyManifestForRepo(dir, signed, '3.11.7', options),
      error => error?.code === 'manifest-version-mismatch',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest with a missing signed commit is rejected before merge', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-missing-commit-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@local/omni-memory',
      version: '3.11.6',
    }));
    const git = args => execFileSync(GIT, ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'package.json']);
    git(['commit', '-q', '-m', 'signed']);

    const signed = signUpdateManifest({
      schema: 'omni-update-manifest-v1',
      keyId: TEST_KEY_ID,
      version: '3.11.6',
      packageName: '@local/omni-memory',
      packageVersion: '3.11.6',
      commit: 'f'.repeat(40),
      packageJsonSha256: 'b'.repeat(64),
      tag: 'v3.11.6',
      issuedAt: new Date().toISOString(),
    }, privateKeyPem);
    assert.throws(
      () => verifyManifestForRepo(dir, signed, '3.11.6', {
        publicKeyPem,
        keyId: TEST_KEY_ID,
        expectedFingerprint: publicKeyFingerprint(publicKeyPem),
      }),
      error => error?.code === 'signed-commit-missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default production manifest key id is still pinned', () => {
  assert.equal(UPDATE_KEY_ID, 'omni-ed25519-2026-01');
});
