import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signUpdateManifest, UPDATE_LAUNCHER_PATH, UPDATE_MANIFEST_SCHEMA } from '../lib/update-signature.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_ID = 'test-key';
const TAG = 'v3.12.3';
const COMMIT = 'a'.repeat(40);
const NOW = new Date().toISOString();
const PACKAGE_BYTES = Buffer.from(`${JSON.stringify({
  name: '@local/omni-memory',
  version: '3.12.3',
  omni: { launcher: { path: UPDATE_LAUNCHER_PATH } },
}, null, 2)}\n`);
const LAUNCHER_BYTES = Buffer.from('fake PE launcher bytes for verify-release tests');
const MANIFEST_URL = 'https://api.github.com/repos/wangzhen110/omni-memory/releases/assets/1';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(overrides = {}) {
  return {
    schema: UPDATE_MANIFEST_SCHEMA,
    keyId: KEY_ID,
    version: '3.12.3',
    packageName: '@local/omni-memory',
    packageVersion: '3.12.3',
    commit: COMMIT,
    packageJsonSha256: hash(PACKAGE_BYTES),
    launcherPath: UPDATE_LAUNCHER_PATH,
    launcherSha256: hash(LAUNCHER_BYTES),
    tag: TAG,
    issuedAt: NOW,
    ...overrides,
  };
}

function signedManifest(overrides = {}) {
  return signUpdateManifest(manifest(overrides), privateKeyPem);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function contentResponse(bytes) {
  return jsonResponse({ encoding: 'base64', content: bytes.toString('base64') });
}

function mockFetch({ manifest: signed, packageBytes = PACKAGE_BYTES, launcherBytes = LAUNCHER_BYTES } = {}) {
  return async url => {
    if (url.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: TAG,
        html_url: `https://github.com/wangzhen110/omni-memory/releases/tag/${TAG}`,
        assets: [{ name: 'omni-update-manifest-v2.json', url: MANIFEST_URL }],
      });
    }
    if (url === MANIFEST_URL) return jsonResponse(signed);
    if (url.includes('/contents/package.json?')) return contentResponse(packageBytes);
    if (url.includes('/contents/scripts/launchers/')) return contentResponse(launcherBytes);
    return jsonResponse({ message: 'not found' }, 404);
  };
}

test('verify-release accepts a signed release and checks the bound package/launcher', async () => {
  const result = await verifyRelease({
    tag: TAG,
    fetchImpl: mockFetch({ manifest: signedManifest() }),
    publicKeyPem,
    keyId: KEY_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(result.tag, TAG);
  assert.equal(result.version, '3.12.3');
  assert.equal(result.commit, COMMIT);
  assert.equal(result.packageJsonSha256, hash(PACKAGE_BYTES));
  assert.equal(result.launcherSha256, hash(LAUNCHER_BYTES));
  assert.equal(result.launcher.bytes, LAUNCHER_BYTES.length);
});

test('verify-release rejects a tampered manifest even when the release endpoint is healthy', async () => {
  const tampered = { ...signedManifest(), commit: 'b'.repeat(40) };
  await assert.rejects(
    verifyRelease({ tag: TAG, fetchImpl: mockFetch({ manifest: tampered }), publicKeyPem, keyId: KEY_ID }),
    /signature verification failed/,
  );
});

test('verify-release rejects a launcher whose bytes do not match the signed hash', async () => {
  await assert.rejects(
    verifyRelease({
      tag: TAG,
      fetchImpl: mockFetch({ manifest: signedManifest(), launcherBytes: Buffer.from('different bytes') }),
      publicKeyPem,
      keyId: KEY_ID,
    }),
    /launcher at .* does not match the signed hash/,
  );
});

test('verify-release compares a separately downloaded launcher and fails closed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-verify-release-'));
  const local = path.join(dir, 'omni-serve-7788.exe');
  try {
    writeFileSync(local, 'not the signed launcher');
    await assert.rejects(
      verifyRelease({
        tag: TAG,
        fetchImpl: mockFetch({ manifest: signedManifest() }),
        publicKeyPem,
        keyId: KEY_ID,
        launcher: local,
      }),
      /local launcher does not match the signed release/,
    );
    writeFileSync(local, LAUNCHER_BYTES);
    const result = await verifyRelease({
      tag: TAG,
      fetchImpl: mockFetch({ manifest: signedManifest() }),
      publicKeyPem,
      keyId: KEY_ID,
      launcher: local,
    });
    assert.equal(result.localLauncher.matched, true);
    assert.equal(readFileSync(local).length, LAUNCHER_BYTES.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
