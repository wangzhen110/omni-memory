// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Signed release manifests for the update path.
 *
 * The public key is pinned in this file, not fetched from the repository at
 * update time. An attacker who can rewrite `main` can replace a public key
 * stored in the repository, but cannot replace the verifier already running
 * locally. The private key never enters the checkout; it lives in the user's
 * data home and is used only by `scripts/sign-release.mjs` when publishing.
 *
 * The signature covers a fixed, explicitly listed set of fields. Unknown
 * fields are rejected so a future field cannot silently change the meaning of
 * an older signature.
 */
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { parseVersion } from './daily-sync.mjs';

export const UPDATE_MANIFEST_SCHEMA_V1 = 'omni-update-manifest-v1';
export const UPDATE_MANIFEST_SCHEMA = 'omni-update-manifest-v2';
export const UPDATE_KEY_ID = 'omni-ed25519-2026-01';
export const UPDATE_PACKAGE_NAME = '@local/omni-memory';
export const UPDATE_LAUNCHER_PATH = 'scripts/launchers/omni-serve-7788.exe';
export const MAX_MANIFEST_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_MANIFEST_FUTURE_MS = 24 * 60 * 60 * 1000;

export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAX1vG9nQYLltxR/mK/2swBgUkc2osFA7t7IygnzO29oQ=
-----END PUBLIC KEY-----
`;

export const UPDATE_PUBLIC_KEY_SHA256 = '76:f3:5c:2d:c5:d6:f7:7e:a8:4d:9b:03:26:c0:7f:fc:d5:94:70:50:8c:bf:c4:41:75:a5:59:c1:67:a9:10:f1';

const V1_FIELDS = [
  'commit',
  'issuedAt',
  'keyId',
  'packageJsonSha256',
  'packageName',
  'packageVersion',
  'schema',
  'tag',
  'version',
];
const V2_FIELDS = [...V1_FIELDS, 'launcherPath', 'launcherSha256'];

function fieldsForSchema(schema) {
  if (schema === UPDATE_MANIFEST_SCHEMA_V1) return V1_FIELDS;
  if (schema === UPDATE_MANIFEST_SCHEMA) return V2_FIELDS;
  throw new Error(`manifest schema is not supported: ${schema || 'missing'}`);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('manifest is not an object');
  }
  const schema = text(input.schema);
  const fields = fieldsForSchema(schema);
  for (const key of Object.keys(input)) {
    if (key !== 'signature' && !fields.includes(key)) {
      throw new Error(`manifest has unknown field: ${key}`);
    }
  }
  const manifest = {};
  for (const key of fields) manifest[key] = text(input[key]);
  return manifest;
}

function validateFields(manifest, keyId, options = {}) {
  fieldsForSchema(manifest.schema);
  if (manifest.keyId !== keyId) throw new Error(`manifest keyId is ${manifest.keyId || 'missing'}, expected ${keyId}`);
  if (!parseVersion(manifest.version)) throw new Error('manifest version is invalid');
  if (!parseVersion(manifest.packageVersion)) throw new Error('manifest packageVersion is invalid');
  if (manifest.packageVersion !== manifest.version) throw new Error('manifest version and packageVersion differ');
  if (manifest.packageName !== UPDATE_PACKAGE_NAME) throw new Error('manifest packageName is not omni-memory');
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error('manifest commit is not a full lowercase Git SHA');
  if (manifest.tag !== `v${manifest.version}`) throw new Error('manifest tag does not match version');
  if (!/^[0-9a-f]{64}$/.test(manifest.packageJsonSha256)) throw new Error('manifest packageJsonSha256 is invalid');
  if (manifest.schema === UPDATE_MANIFEST_SCHEMA) {
    if (manifest.launcherPath !== UPDATE_LAUNCHER_PATH) throw new Error(`manifest launcherPath must be ${UPDATE_LAUNCHER_PATH}`);
    if (!/^[0-9a-f]{64}$/.test(manifest.launcherSha256)) throw new Error('manifest launcherSha256 is invalid');
  }
  const issuedAtMs = Date.parse(manifest.issuedAt);
  if (!Number.isFinite(issuedAtMs)) throw new Error('manifest issuedAt is invalid');
  if (options.checkAge) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (issuedAtMs > now + MAX_MANIFEST_FUTURE_MS) throw new Error('manifest issuedAt is in the future');
    if (issuedAtMs < now - (options.maxAgeMs ?? MAX_MANIFEST_AGE_MS)) throw new Error('manifest issuedAt is too old');
  }
}

export function canonicalUpdateManifest(manifest) {
  const normalized = normalizeManifest(manifest);
  return JSON.stringify(normalized);
}

export function publicKeyFingerprint(publicKeyPem = UPDATE_PUBLIC_KEY_PEM) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').match(/../g).join(':');
}

/** Sign a manifest with the publisher key. Used by scripts/sign-release.mjs and tests. */
export function signUpdateManifest(input, privateKeyPem) {
  const manifest = normalizeManifest(input);
  validateFields(manifest, manifest.keyId, { checkAge: false });
  const signature = signBytes(null, Buffer.from(canonicalUpdateManifest(manifest)), createPrivateKey(privateKeyPem));
  return { ...manifest, signature: signature.toString('base64') };
}

/**
 * Verify a manifest before any git operation. Returns a normalized manifest
 * only when every field and the Ed25519 signature are valid.
 */
export function verifyUpdateManifest(input, options = {}) {
  try {
    const manifest = normalizeManifest(input);
    const signature = text(input.signature);
    if (!signature) throw new Error('manifest signature is missing');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error('manifest signature is not base64');
    const keyId = options.keyId ?? UPDATE_KEY_ID;
    validateFields(manifest, keyId, {
      checkAge: true,
      now: options.now,
      maxAgeMs: options.maxAgeMs,
    });
    const publicKeyPem = options.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM;
    if (options.expectedFingerprint && publicKeyFingerprint(publicKeyPem) !== options.expectedFingerprint) {
      throw new Error('update public key fingerprint does not match the pinned value');
    }
    const ok = verifyBytes(
      null,
      Buffer.from(canonicalUpdateManifest(manifest)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64'),
    );
    if (!ok) throw new Error('manifest signature is invalid');
    return {
      ok: true,
      manifest: { ...manifest, signature },
      keyId,
      keyFingerprint: publicKeyFingerprint(publicKeyPem),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
