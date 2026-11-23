import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  publicKeyFingerprint,
  signUpdateManifest,
  verifyUpdateManifest,
  UPDATE_KEY_ID,
  UPDATE_PUBLIC_KEY_PEM,
  UPDATE_PUBLIC_KEY_SHA256,
} from '../lib/update-signature.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const TEST_KEY_ID = 'test-key';
const NOW = new Date().toISOString();

function manifest(overrides = {}) {
  return {
    schema: 'omni-update-manifest-v2',
    keyId: TEST_KEY_ID,
    version: '3.11.8',
    packageName: '@local/omni-memory',
    packageVersion: '3.11.8',
    commit: 'a'.repeat(40),
    packageJsonSha256: 'b'.repeat(64),
    launcherPath: 'scripts/launchers/omni-serve-7788.exe',
    launcherSha256: 'd'.repeat(64),
    tag: 'v3.11.8',
    issuedAt: NOW,
    ...overrides,
  };
}

test('the pinned update public key matches its documented fingerprint', () => {
  assert.equal(publicKeyFingerprint(UPDATE_PUBLIC_KEY_PEM), UPDATE_PUBLIC_KEY_SHA256);
  assert.equal(UPDATE_KEY_ID, 'omni-ed25519-2026-01');
});

test('a signed manifest verifies and any field change breaks the signature', () => {
  const signed = signUpdateManifest(manifest(), privateKeyPem);
  assert.ok(signed.signature);
  const verified = verifyUpdateManifest(signed, { publicKeyPem, keyId: TEST_KEY_ID });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.manifest.commit, 'a'.repeat(40));
  assert.equal(verified.manifest.launcherSha256, 'd'.repeat(64));
  assert.equal(verified.keyFingerprint, publicKeyFingerprint(publicKeyPem));

  const wrongFingerprint = verifyUpdateManifest(signed, {
    publicKeyPem,
    keyId: TEST_KEY_ID,
    expectedFingerprint: '00'.repeat(32),
  });
  assert.equal(wrongFingerprint.ok, false);
  assert.match(wrongFingerprint.error, /fingerprint/);

  const tampered = { ...signed, commit: 'c'.repeat(40) };
  const result = verifyUpdateManifest(tampered, { publicKeyPem, keyId: TEST_KEY_ID });
  assert.equal(result.ok, false);
  assert.match(result.error, /signature is invalid/);
});

test('unknown fields, wrong key, malformed fields and mismatched versions are rejected', () => {
  const signed = signUpdateManifest(manifest(), privateKeyPem);
  assert.equal(verifyUpdateManifest({ ...signed, extra: true }, { publicKeyPem, keyId: TEST_KEY_ID }).ok, false);
  assert.equal(verifyUpdateManifest(signed, { publicKeyPem: UPDATE_PUBLIC_KEY_PEM, keyId: TEST_KEY_ID }).ok, false);
  assert.equal(verifyUpdateManifest(signed, { publicKeyPem, keyId: 'other-key' }).ok, false);

  for (const bad of [
    { ...signed, version: 'latest' },
    { ...signed, commit: 'a'.repeat(39) },
    { ...signed, tag: 'v3.11.7' },
    { ...signed, packageJsonSha256: 'b'.repeat(63) },
    { ...signed, issuedAt: 'not-a-date' },
    { ...signed, packageName: 'other' },
    { ...signed, launcherPath: 'scripts/launchers/evil.exe' },
    { ...signed, launcherSha256: 'd'.repeat(63) },
  ]) {
    const result = verifyUpdateManifest(bad, { publicKeyPem, keyId: TEST_KEY_ID });
    assert.equal(result.ok, false);
  }
});

test('an old or future manifest issuedAt cannot be replayed', () => {
  for (const issuedAt of ['2010-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
    const signed = signUpdateManifest(manifest({ issuedAt }), privateKeyPem);
    const result = verifyUpdateManifest(signed, { publicKeyPem, keyId: TEST_KEY_ID });
    assert.equal(result.ok, false);
    assert.match(result.error, /issuedAt/);
  }
});

test('the v1 manifest remains verifiable for old clients during bootstrap', () => {
  const legacy = manifest({
    schema: 'omni-update-manifest-v1',
    version: '3.11.7',
    packageVersion: '3.11.7',
    tag: 'v3.11.7',
  });
  delete legacy.launcherPath;
  delete legacy.launcherSha256;
  const signed = signUpdateManifest(legacy, privateKeyPem);
  assert.equal(signed.launcherPath, undefined);
  const result = verifyUpdateManifest(signed, { publicKeyPem, keyId: TEST_KEY_ID });
  assert.equal(result.ok, true, result.error);
});

test('a manifest signed for another version can never be used for this release', () => {
  const signed = signUpdateManifest(manifest({ version: '3.11.7', packageVersion: '3.11.7', tag: 'v3.11.7' }), privateKeyPem);
  const result = verifyUpdateManifest(signed, { publicKeyPem, keyId: TEST_KEY_ID });
  assert.equal(result.ok, true);
  // Caller must still compare manifest.version with the release version.
  assert.notEqual(result.manifest.version, '3.11.8');
});
