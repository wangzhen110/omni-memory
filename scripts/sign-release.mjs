// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Publish-side helper: sign the release manifest for one commit.
 *
 * Usage:
 *   node scripts/sign-release.mjs --version 3.11.6 --commit <sha> --tag v3.11.6
 *
 * The private key is read from ~/.dsh/omni-update-signing-key.pem by default,
 * or OMNI_UPDATE_SIGNING_KEY. It is never written into the repository.
 * The resulting manifest is uploaded as a GitHub Release asset named
 * `omni-update-manifest.json`; scripts/daily-sync.mjs refuses to apply without
 * a manifest signed by the pinned public key.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from '../lib/daily-sync.mjs';
import { signUpdateManifest, UPDATE_KEY_ID, UPDATE_LAUNCHER_PATH, UPDATE_MANIFEST_SCHEMA, UPDATE_MANIFEST_SCHEMA_V1, UPDATE_PACKAGE_NAME } from '../lib/update-signature.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');
const GIT = [process.env.GIT_BIN, 'C:\\Program Files\\Git\\cmd\\git.exe', 'git']
  .filter(Boolean)
  .find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';

function argValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_REPO,
    commit: null,
    version: null,
    tag: null,
    schema: UPDATE_MANIFEST_SCHEMA,
    launcher: UPDATE_LAUNCHER_PATH,
    out: null,
    key: process.env.OMNI_UPDATE_SIGNING_KEY
      || path.join(process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'omni-update-signing-key.pem'),
    issuedAt: new Date().toISOString(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      options.dir = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--commit') {
      options.commit = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--version') {
      options.version = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--tag') {
      options.tag = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--schema') {
      options.schema = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--launcher') {
      options.launcher = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--out') {
      options.out = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--key') {
      options.key = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--issued-at') {
      options.issuedAt = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function git(args, cwd) {
  return execFileSync(GIT, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function packageAtCommit(repo, commit) {
  const raw = execFileSync(GIT, ['show', `${commit}:package.json`], {
    cwd: repo,
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = raw.toString('utf8').replace(/^\uFEFF/, '');
  const pkg = JSON.parse(text);
  return { raw, pkg };
}

function fileAtCommit(repo, commit, file) {
  return execFileSync(GIT, ['show', `${commit}:${file}`], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The signing key is the root of the update trust chain. Do not sign with a
 * key that ordinary local users can read; on Windows Node's stat mode is not
 * meaningful, so inspect the ACL instead of pretending 0666 is 0600.
 */
function assertPrivateKeyPermissions(keyPath) {
  if (process.platform === 'win32') {
    let acl;
    try {
      acl = execFileSync('C:\\Windows\\System32\\icacls.exe', [keyPath], { encoding: 'utf8' });
    } catch (error) {
      throw new Error(`cannot verify signing key ACL: ${error.message}`);
    }
    const broadPrincipals = [
      /BUILTIN\\Users/i,
      /BUILTIN\\Guests/i,
      /Everyone/i,
      /Authenticated Users/i,
      /\bINTERACTIVE\b/i,
      /Remote Desktop Users/i,
    ];
    if (broadPrincipals.some(pattern => pattern.test(acl))) {
      throw new Error(`signing key ACL is too broad; remove Users/Everyone/Interactive grants: ${keyPath}`);
    }
    return;
  }
  const mode = statSync(keyPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`signing key permissions are ${mode.toString(8)}; chmod 600 is required: ${keyPath}`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: node scripts/sign-release.mjs --version <version> [--schema v1|v2] [--commit <sha>] [--tag <tag>] [--key <pem>] [--out <file>]');
    return;
  }

  const repo = path.resolve(options.dir);
  const commit = (options.commit || git(['rev-parse', 'HEAD'], repo)).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid commit: ${commit}`);
  if (options.schema === 'v1') options.schema = UPDATE_MANIFEST_SCHEMA_V1;
  if (options.schema === 'v2') options.schema = UPDATE_MANIFEST_SCHEMA;
  if (options.schema !== UPDATE_MANIFEST_SCHEMA_V1 && options.schema !== UPDATE_MANIFEST_SCHEMA) {
    throw new Error(`unsupported schema: ${options.schema}`);
  }
  const { raw, pkg } = packageAtCommit(repo, commit);
  const version = String(options.version || pkg.version || '').trim().replace(/^[vV]/, '');
  if (!parseVersion(version)) throw new Error(`invalid version: ${version}`);
  if (String(pkg.version || '').trim().replace(/^[vV]/, '') !== version) {
    throw new Error(`package.json at ${commit} is ${pkg.version}, not ${version}`);
  }
  if (pkg.name !== UPDATE_PACKAGE_NAME) throw new Error(`package.json name is ${pkg.name}, not ${UPDATE_PACKAGE_NAME}`);
  const tag = String(options.tag || `v${version}`).trim();
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match version ${version}`);
  if (!existsSync(options.key)) throw new Error(`signing key not found: ${options.key}`);
  assertPrivateKeyPermissions(options.key);

  let launcher = null;
  if (options.schema === UPDATE_MANIFEST_SCHEMA) {
    if (options.launcher !== UPDATE_LAUNCHER_PATH) {
      throw new Error(`launcher path must be ${UPDATE_LAUNCHER_PATH}`);
    }
    const launcherRaw = fileAtCommit(repo, commit, options.launcher);
    launcher = {
      launcherPath: options.launcher,
      launcherSha256: createHash('sha256').update(launcherRaw).digest('hex'),
    };
  }

  const manifest = {
    schema: options.schema,
    keyId: UPDATE_KEY_ID,
    version,
    packageName: pkg.name,
    packageVersion: version,
    commit,
    packageJsonSha256: createHash('sha256').update(raw).digest('hex'),
    ...(launcher ? launcher : {}),
    tag,
    issuedAt: options.issuedAt,
  };
  const signed = signUpdateManifest(manifest, readFileSync(options.key, 'utf8'));
  const out = path.resolve(options.out || (options.schema === UPDATE_MANIFEST_SCHEMA
    ? 'omni-update-manifest-v2.json'
    : 'omni-update-manifest.json'));
  writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  console.log(JSON.stringify({
    ok: true,
    manifest: out,
    schema: options.schema,
    version,
    commit,
    tag,
    packageJsonSha256: signed.packageJsonSha256,
    ...(launcher ? { launcherSha256: launcher.launcherSha256 } : {}),
    signatureBytes: Buffer.from(signed.signature, 'base64').length,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 2;
}
