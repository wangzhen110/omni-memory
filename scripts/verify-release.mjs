#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Public release verifier for an open-source distribution.
 *
 * It verifies the Ed25519 signature on the official GitHub Release manifest,
 * then checks that `package.json` and the Windows launcher at the signed commit
 * match the hashes bound into that manifest. A separately downloaded launcher
 * can be compared with `--launcher <path>`.
 *
 * This command is not a replacement for `daily-sync --apply`: it is a read-only
 * verification tool for users and mirrors. It deliberately does not move HEAD,
 * install files, or create scheduled tasks.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  verifyUpdateManifest,
  UPDATE_KEY_ID,
  UPDATE_LAUNCHER_PATH,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_MANIFEST_SCHEMA_V1,
  MAX_MANIFEST_FUTURE_MS,
  UPDATE_PUBLIC_KEY_PEM,
} from '../lib/update-signature.mjs';

export const RELEASE_REPO = 'wangzhen110/omni-memory';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = `https://api.github.com/repos/${RELEASE_REPO}`;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '';
  }
}

function argValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    tag: '',
    latest: false,
    launcher: '',
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag') {
      options.tag = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--latest') {
      options.latest = true;
    } else if (arg === '--launcher') {
      options.launcher = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.latest && options.tag) throw new Error('--latest and --tag are mutually exclusive');
  if (!options.tag) {
    const version = readPackageVersion();
    options.tag = options.latest ? '' : (version ? `v${version}` : '');
  }
  if (!options.latest && options.tag && !/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.tag)) {
    throw new Error(`invalid tag: ${options.tag}; expected vX.Y.Z`);
  }
  return options;
}

async function request(url, { fetchImpl = fetch, token = '', binary = false, timeoutMs = 30_000 } = {}) {
  const headers = {
    'User-Agent': 'omni-memory-verify-release',
    Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.text();
      detail = body ? `: ${body.slice(0, 160)}` : '';
    } catch {
      detail = '';
    }
    throw new Error(`HTTP ${response.status} for ${url}${detail}`);
  }
  if (binary) return Buffer.from(await response.arrayBuffer());
  return response.json();
}

function manifestUrlForRelease(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find(item => item?.name === 'omni-update-manifest-v2.json')
    || assets.find(item => item?.name === 'omni-update-manifest.json');
  if (!asset?.url && !asset?.browser_download_url) {
    throw new Error(`release ${text(release.tag_name) || '?'} has no signed update manifest asset`);
  }
  // Prefer the api.github.com asset endpoint; github.com download URLs are
  // blocked or reset on some networks. The API endpoint still redirects to
  // release-assets.githubusercontent.com, which is reachable when raw GitHub
  // is not.
  return { asset, url: asset.url || asset.browser_download_url };
}

async function fileAtCommit(filePath, commit, options) {
  const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const data = await request(`${API_ROOT}/contents/${encodedPath}?ref=${encodeURIComponent(commit)}`, options);
  if (Array.isArray(data) || typeof data?.content !== 'string' || data.encoding !== 'base64') {
    throw new Error(`GitHub contents API returned no base64 content for ${filePath} at ${commit}`);
  }
  return Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
}

/**
 * Verify one release. Tests inject fetchImpl/publicKeyPem/keyId; the CLI uses
 * the pinned production key and the official GitHub API.
 */
export async function verifyRelease(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? '';
  const publicKeyPem = options.publicKeyPem ?? UPDATE_PUBLIC_KEY_PEM;
  const keyId = options.keyId ?? UPDATE_KEY_ID;
  let tag = text(options.tag);

  if (options.latest || !tag) {
    const latest = await request(`${API_ROOT}/releases/latest`, { fetchImpl, token });
    tag = text(latest.tag_name);
    if (!tag) throw new Error('latest release has no tag_name');
    return verifyRelease({ ...options, latest: false, tag, fetchImpl, token, publicKeyPem, keyId });
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`invalid tag: ${tag}; expected vX.Y.Z`);
  }

  const release = await request(`${API_ROOT}/releases/tags/${encodeURIComponent(tag)}`, { fetchImpl, token });
  if (text(release.tag_name) !== tag) throw new Error(`release tag is ${text(release.tag_name) || 'missing'}, expected ${tag}`);
  const { asset, url } = manifestUrlForRelease(release);
  const manifestBytes = await request(url, { fetchImpl, token, binary: true });
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const issuedAtMs = Date.parse(text(manifest.issuedAt));
  if (!Number.isFinite(issuedAtMs)) throw new Error('manifest issuedAt is invalid');
  if (issuedAtMs > Date.now() + MAX_MANIFEST_FUTURE_MS) throw new Error('manifest issuedAt is in the future');

  // Historical releases must remain verifiable after the 180-day update
  // freshness window. Pin verification "now" to the signed issue time; the
  // future check above still uses the real clock.
  const verdict = verifyUpdateManifest(manifest, {
    publicKeyPem,
    keyId,
    now: issuedAtMs + 1,
  });
  if (!verdict.ok) throw new Error(`manifest signature verification failed: ${verdict.error}`);

  const signed = verdict.manifest;
  if (signed.tag !== tag) throw new Error(`manifest tag is ${signed.tag}, expected ${tag}`);
  if (signed.schema !== UPDATE_MANIFEST_SCHEMA && signed.schema !== UPDATE_MANIFEST_SCHEMA_V1) {
    throw new Error(`manifest schema is ${signed.schema}`);
  }

  const packageBytes = await fileAtCommit('package.json', signed.commit, { fetchImpl, token });
  const packageHash = sha256(packageBytes);
  if (packageHash !== signed.packageJsonSha256) {
    throw new Error(`package.json at ${signed.commit} does not match the signed hash`);
  }
  try {
    const pkg = JSON.parse(packageBytes.toString('utf8'));
    if (pkg.name !== signed.packageName || pkg.version !== signed.version) {
      throw new Error(`package.json name/version is ${pkg.name}@${pkg.version}, expected ${signed.packageName}@${signed.version}`);
    }
  } catch (error) {
    if (error?.message?.includes('expected')) throw error;
    throw new Error(`signed package.json is not valid JSON: ${error.message}`);
  }

  let launcher = null;
  if (signed.schema === UPDATE_MANIFEST_SCHEMA) {
    if (signed.launcherPath !== UPDATE_LAUNCHER_PATH) throw new Error(`manifest launcherPath is ${signed.launcherPath}`);
    const launcherBytes = await fileAtCommit(signed.launcherPath, signed.commit, { fetchImpl, token });
    const launcherHash = sha256(launcherBytes);
    if (launcherHash !== signed.launcherSha256) {
      throw new Error(`launcher at ${signed.commit} does not match the signed hash`);
    }
    launcher = { path: signed.launcherPath, sha256: launcherHash, bytes: launcherBytes.length };
  }

  let localLauncher = null;
  if (options.launcher) {
    if (signed.schema !== UPDATE_MANIFEST_SCHEMA) throw new Error('manifest v1 has no launcher hash to compare');
    if (!existsSync(options.launcher)) throw new Error(`launcher file not found: ${options.launcher}`);
    const bytes = readFileSync(options.launcher);
    const hash = sha256(bytes);
    if (hash !== signed.launcherSha256) {
      throw new Error(`local launcher does not match the signed release: ${hash}`);
    }
    localLauncher = { path: path.resolve(options.launcher), sha256: hash, bytes: bytes.length, matched: true };
  }

  return {
    ok: true,
    repo: RELEASE_REPO,
    tag,
    releaseUrl: text(release.html_url),
    manifestAsset: asset.name,
    schema: signed.schema,
    version: signed.version,
    commit: signed.commit,
    keyId: verdict.keyId,
    keyFingerprint: verdict.keyFingerprint,
    packageJsonSha256: signed.packageJsonSha256,
    launcherSha256: signed.launcherSha256 || null,
    launcher,
    localLauncher,
    issuedAt: signed.issuedAt,
  };
}

function printHuman(result) {
  console.log(`Release ${result.tag}  ${result.releaseUrl}`);
  console.log(`  schema       ${result.schema}`);
  console.log(`  version      ${result.version}`);
  console.log(`  commit       ${result.commit}`);
  console.log(`  key          ${result.keyId}  ${result.keyFingerprint}`);
  console.log(`  package.json ${result.packageJsonSha256}`);
  if (result.launcherSha256) console.log(`  launcher     ${result.launcherSha256}  ${result.launcher?.bytes ?? '?'} bytes`);
  if (result.localLauncher) console.log(`  local file   ${result.localLauncher.path}  MATCH`);
  console.log('OK: signature, package hash, and launcher hash are consistent');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: node scripts/verify-release.mjs [--tag vX.Y.Z | --latest] [--launcher <path>] [--json]');
    console.log('Default tag is the package.json version. Read-only; never installs or restarts anything.');
    return;
  }
  try {
    const result = await verifyRelease(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } catch (error) {
    const result = { ok: false, tag: options.tag || null, error: String(error?.message ?? error) };
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
