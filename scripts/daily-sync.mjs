// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Once-a-day cloud version report for this checkout.
 *
 * The default run only reports `update-available` / `up-to-date`. It never
 * merges code and never restarts 7788. A real update requires `--apply`, which
 * verifies the Ed25519 release manifest, package hash and signed-commit
 * ancestry before fast-forwarding to the signed commit. `--restart` is a
 * separate opt-in. Every attempt is recorded in `~/.dsh/omni-daily-sync.json`,
 * so later report-only calls that day return `already-ran-today`.
 *
 * It deliberately refuses to update a dirty tracked tree. Untracked docs are
 * allowed; `git merge --ff-only` will still stop if a remote file would collide.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GITHUB_REPO,
  SERVICE_TASK,
  UPDATE_BRANCH,
  defaultStatePath,
  isNewerVersion,
  isSyncDue,
  localDateKey,
  parseVersion,
} from '../lib/daily-sync.mjs';
import {
  UPDATE_LAUNCHER_PATH,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_PACKAGE_NAME,
  UPDATE_PUBLIC_KEY_SHA256,
  verifyUpdateManifest,
} from '../lib/update-signature.mjs';
import { installLauncherFromCommit } from './install-launcher.mjs';

const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'git',
].filter(Boolean);
const GIT = GIT_CANDIDATES.find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');
const TASK_NAME = process.env.OMNI_SERVICE_TASK || SERVICE_TASK;
const HEALTH_URL = process.env.OMNI_HEALTH_URL || 'http://127.0.0.1:7788/health';
const GITHUB_TOKEN = process.env.OMNI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
/**
 * Test-only hooks are double-gated: OMNI_TEST_MODE alone is not enough, because
 * a stray `OMNI_TEST_MODE=1` in a deployed task could swap the release key or
 * git remote. `NODE_TEST_CONTEXT` is only set by `node --test` and inherited by
 * its child processes.
 */
export function testModeEnabled(env = process.env) {
  return env.OMNI_TEST_MODE === '1' && Boolean(env.NODE_TEST_CONTEXT);
}
const TEST_MODE = testModeEnabled();
const TEST_ENV_NAMES = [
  'OMNI_TEST_GIT_FETCH_URL',
  'OMNI_TEST_UPDATE_PUBLIC_KEY_FILE',
  'OMNI_TEST_UPDATE_KEY_ID',
  'OMNI_TEST_UPDATE_PUBLIC_KEY_SHA256',
];
if (process.env.OMNI_TEST_MODE === '1' && !TEST_MODE) {
  console.error('[omni] ignoring OMNI_TEST_MODE=1: test-only hooks require the Node test runner context (NODE_TEST_CONTEXT)');
}
if (!TEST_MODE) {
  const injected = TEST_ENV_NAMES.filter(name => process.env[name]);
  if (injected.length) {
    console.error(`[omni] ignoring test-only env without OMNI_TEST_MODE=1: ${injected.join(', ')}`);
  }
}
const TEST_GIT_FETCH_URL = TEST_MODE ? (process.env.OMNI_TEST_GIT_FETCH_URL || '') : '';
const SCHTASKS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe')
  : 'schtasks.exe';
const NPM = [process.env.NPM_BIN, process.platform === 'win32' ? 'npm.cmd' : 'npm']
  .filter(Boolean)
  .find(candidate => candidate === 'npm.cmd' || candidate === 'npm' || existsSync(candidate))
  || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const NPM_CLI = [process.env.NPM_CLI, process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  .filter(Boolean)
  .find(candidate => existsSync(candidate)) || null;

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      status: Number.isInteger(error.status) ? error.status : null,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? '').trim(),
    };
  }
}

function runGit(args, options = {}) {
  return run(GIT, args, options);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function readPackage(dir) {
  return readJson(path.join(dir, 'package.json'));
}

function readPackageVersion(dir) {
  const pkg = readPackage(dir);
  if (!parseVersion(pkg.version)) throw new Error(`invalid package version: ${pkg.version}`);
  return String(pkg.version).trim().replace(/^[vV]/, '');
}

function readState(file) {
  try {
    const value = readJson(file);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

// One updater at a time per real checkout. A lock keyed only by --state lets
// two invocations with different state files reset the same tree underneath
// each other; keying by the resolved repository removes that bypass.
let applyLockPath = null;

export function applyLockPathForRepo(repo) {
  const resolved = realpathSync(repo);
  const key = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(path.dirname(defaultStatePath()), `omni-daily-sync-${key}.apply.lock`);
}

function acquireApplyLock(repo) {
  const lockPath = applyLockPathForRepo(repo);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      closeSync(fd);
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A killed updater leaves a lock behind. Recover only after it is clearly
      // stale; a live updater may legitimately take longer than a few minutes.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30 * 60 * 1000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* the owner may have removed it between stat and unlink */ }
      return null;
    }
  }
  return null;
}

function releaseApplyLock(lockPath) {
  if (!lockPath) return;
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (Number(owner?.pid) !== process.pid) return;
  } catch { /* empty or already removed: fall through to unlink */ }
  try { unlinkSync(lockPath); } catch { /* already removed */ }
}

process.on('exit', () => releaseApplyLock(applyLockPath));

function argValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_REPO,
    state: defaultStatePath(),
    force: false,
    check: false,
    apply: false,
    restart: false,
    noRestart: false,
    skipTests: false,
    runTests: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      options.dir = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--state') {
      options.state = argValue(argv, index, arg);
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--restart') {
      options.restart = true;
    } else if (arg === '--no-restart') {
      options.noRestart = true;
    } else if (arg === '--skip-tests') {
      options.skipTests = true;
      options.runTests = false;
    } else if (arg === '--run-tests') {
      options.runTests = true;
      options.skipTests = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function isGitHubApiUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:' && parsed.hostname === 'api.github.com';
  } catch {
    return false;
  }
}

async function fetchText(url, options = {}) {
  const headers = {
    'user-agent': 'omni-memory',
    accept: options.accept || 'application/vnd.github+json',
  };
  if (GITHUB_TOKEN && isGitHubApiUrl(url)) {
    headers.authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Number(options.timeoutMs ?? 8000)),
  });
  if (!response.ok) throw new UpdateError(`http-${response.status}`, `HTTP ${response.status}`);
  return response.text();
}

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

async function remotePackageVersion() {
  // GitHub's contents API reflects a fresh push immediately; raw.githubusercontent
  // can serve a stale CDN copy for minutes. Daily volume is tiny, so API first.
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/package.json?ref=${UPDATE_BRANCH}`;
  try {
    const envelope = JSON.parse(await fetchText(api));
    const pkg = JSON.parse(Buffer.from(String(envelope.content ?? ''), 'base64').toString('utf8'));
    const version = String(pkg.version ?? '').trim().replace(/^[vV]/, '');
    if (parseVersion(version)) return { version, source: 'contents-api' };
  } catch {
    // Fall back to the raw CDN below.
  }
  const raw = `https://raw.githubusercontent.com/${GITHUB_REPO}/${UPDATE_BRANCH}/package.json`;
  const pkg = JSON.parse(await fetchText(raw));
  const version = String(pkg.version ?? '').trim().replace(/^[vV]/, '');
  if (!parseVersion(version)) throw new Error('remote package.json has no valid version');
  return { version, source: 'raw-main' };
}

async function fetchReleaseManifest(version) {
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`;
  let release;
  try {
    release = JSON.parse(await fetchText(releaseUrl));
  } catch (error) {
    if (error?.code === 'http-404') {
      throw new UpdateError('unsigned-release', `release v${version} does not exist`);
    }
    throw error;
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find(item => item?.name === 'omni-update-manifest-v2.json')
    || assets.find(item => item?.name === 'omni-update-manifest.json');
  if (!asset?.url) {
    throw new UpdateError('unsigned-release', `release v${version} has no signed update manifest asset`);
  }
  const body = await fetchText(asset.url, { accept: 'application/octet-stream' });
  try {
    return JSON.parse(body);
  } catch {
    throw new UpdateError('manifest-invalid', `release v${version} manifest is not valid JSON`);
  }
}

function gitBlob(dir, commit, file) {
  try {
    return {
      ok: true,
      data: execFileSync(GIT, ['show', `${commit}:${file}`], {
        cwd: dir,
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (error) {
    return { ok: false, error: String(error?.stderr ?? error?.message ?? error) };
  }
}

export function verifyManifestForRepo(repo, candidate, expectedVersion, options = {}) {
  const verdict = verifyUpdateManifest(candidate, {
    expectedFingerprint: options.expectedFingerprint ?? UPDATE_PUBLIC_KEY_SHA256,
    ...(options.publicKeyPem ? { publicKeyPem: options.publicKeyPem } : {}),
    ...(options.keyId ? { keyId: options.keyId } : {}),
  });
  if (!verdict.ok) throw new UpdateError('signature-invalid', verdict.error);
  const manifest = verdict.manifest;
  if (manifest.version !== expectedVersion) {
    throw new UpdateError('manifest-version-mismatch', `manifest is ${manifest.version}, remote package is ${expectedVersion}`);
  }
  const blob = gitBlob(repo, manifest.commit, 'package.json');
  if (!blob.ok) throw new UpdateError('signed-commit-missing', blob.error);
  const actualHash = createHash('sha256').update(blob.data).digest('hex');
  if (actualHash !== manifest.packageJsonSha256) {
    throw new UpdateError('package-hash-mismatch', `package.json at ${manifest.commit} does not match the signed hash`);
  }
  let pkg;
  try {
    pkg = JSON.parse(blob.data.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new UpdateError('package-json-invalid', `package.json at ${manifest.commit} is not valid JSON`);
  }
  if (pkg.name !== UPDATE_PACKAGE_NAME) throw new UpdateError('package-name-mismatch', String(pkg.name));
  const packageVersion = String(pkg.version ?? '').trim().replace(/^[vV]/, '');
  if (packageVersion !== manifest.version) {
    throw new UpdateError('package-version-mismatch', `package.json says ${packageVersion}`);
  }
  let launcher = null;
  if (manifest.schema === UPDATE_MANIFEST_SCHEMA) {
    if (manifest.launcherPath !== UPDATE_LAUNCHER_PATH) {
      throw new UpdateError('launcher-path-mismatch', `manifest launcherPath is ${manifest.launcherPath}`);
    }
    const launcherBlob = gitBlob(repo, manifest.commit, manifest.launcherPath);
    if (!launcherBlob.ok) throw new UpdateError('launcher-missing', launcherBlob.error);
    if (launcherBlob.data.length === 0) throw new UpdateError('launcher-missing', 'launcher binary is empty');
    const launcherHash = createHash('sha256').update(launcherBlob.data).digest('hex');
    if (launcherHash !== manifest.launcherSha256) {
      throw new UpdateError('launcher-hash-mismatch', `launcher at ${manifest.commit} does not match the signed hash`);
    }
    launcher = { path: manifest.launcherPath, sha256: launcherHash, bytes: launcherBlob.data.length };
  }
  return { ...verdict, manifest, ...(launcher ? { launcher } : {}) };
}

function gitFetch(dir) {
  if (TEST_GIT_FETCH_URL) {
    // Test-only: keep the GitHub identity gate intact while fetching from a
    // local bare repository, so the CLI main chain can be exercised offline.
    return runGit(['fetch', TEST_GIT_FETCH_URL, `${UPDATE_BRANCH}:refs/remotes/origin/${UPDATE_BRANCH}`, '--prune'], { cwd: dir });
  }
  let result = runGit(['fetch', 'origin', UPDATE_BRANCH, '--prune'], { cwd: dir });
  if (!result.ok) {
    // Windows often resets github.com:443; the resolved IP fallback is known
    // to work on the target machine and is scoped to this git invocation.
    result = runGit([
      '-c', 'http.curloptResolve=github.com:443:140.82.113.3',
      'fetch', 'origin', UPDATE_BRANCH, '--prune',
    ], { cwd: dir });
  }
  return result;
}

function trackedDirty(dir) {
  return runGit(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: dir });
}

function currentHead(dir) {
  return runGit(['rev-parse', 'HEAD'], { cwd: dir });
}

function remoteHead(dir) {
  return runGit(['rev-parse', `origin/${UPDATE_BRANCH}`], { cwd: dir });
}

function collectSyntaxFiles(dir) {
  const files = [
    path.join(dir, 'index.js'),
    path.join(dir, 'client.js'),
  ].filter(file => existsSync(file));
  const walk = relative => {
    const absolute = path.join(dir, relative);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(path.join(dir, child));
    }
  };
  for (const root of ['lib', 'hosts', 'scripts']) walk(root);
  return files;
}

function verifySyntax(dir) {
  const files = collectSyntaxFiles(dir);
  for (const file of files) {
    const result = run(process.execPath, ['--check', file], { cwd: dir });
    if (!result.ok) return { ...result, file: path.relative(dir, file) };
  }
  return { ok: true, checked: files.length };
}

async function healthVersion(timeout = 1500) {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.version ?? null;
  } catch {
    return null;
  }
}

function taskExists() {
  if (process.platform !== 'win32') return false;
  return run(SCHTASKS, ['/Query', '/TN', TASK_NAME, '/FO', 'LIST']);
}

async function probeService(expectedVersion) {
  if (process.platform !== 'win32') {
    return { exists: false, restarted: false, version: null, healthy: false, error: 'unsupported platform' };
  }
  const task = taskExists();
  if (!task.ok) {
    return { exists: false, restarted: false, version: null, healthy: false, error: task.stderr || 'scheduled task not found' };
  }
  const observed = await healthVersion();
  const healthy = observed === expectedVersion;
  return {
    exists: true,
    restarted: false,
    version: observed,
    healthy,
    ...(healthy ? {} : { error: `service reports ${observed ?? 'no version'}, expected ${expectedVersion}` }),
  };
}

async function restartService(version) {
  if (process.platform !== 'win32') {
    return { exists: false, restarted: false, version: null, healthy: false, error: 'unsupported platform' };
  }
  const task = taskExists();
  if (!task.ok) {
    return { exists: false, restarted: false, version: null, healthy: false, error: task.stderr || 'scheduled task not found' };
  }
  run(SCHTASKS, ['/End', '/TN', TASK_NAME]);
  const start = run(SCHTASKS, ['/Run', '/TN', TASK_NAME]);
  if (!start.ok) {
    return { exists: true, restarted: false, version: await healthVersion(), healthy: false, error: start.stderr || 'schtasks /Run failed' };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const observed = await healthVersion();
    if (observed === version) {
      return { exists: true, restarted: true, version: observed, healthy: true };
    }
  }
  return {
    exists: true, restarted: true, version: await healthVersion(), healthy: false,
    error: `service did not report ${version} after restart`,
  };
}

function projectRoot(dir) {
  const root = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
  return root.ok ? path.resolve(root.stdout) : null;
}

function originUrl(dir) {
  const remote = runGit(['remote', 'get-url', 'origin'], { cwd: dir });
  return remote.ok ? remote.stdout.trim() : null;
}

/**
 * The updater may only touch this project's checkout. Without this gate,
 * `--dir` on any repository with a package.json would fetch and merge that
 * repository's origin/main, while still sharing this project's global state.
 */
/**
 * Parse a Git remote URL into an exact host + repository path. Substring
 * matching would accept `github.com.evil/...` or `evil.com/github.com/...`.
 */
function parseGitHubOrigin(origin) {
  const raw = String(origin ?? '').trim();
  let host;
  let repoPath;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      host = url.hostname;
      repoPath = decodeURIComponent(url.pathname);
    } else if (/^ssh:\/\//i.test(raw)) {
      const url = new URL(raw);
      host = url.hostname;
      repoPath = decodeURIComponent(url.pathname);
    } else {
      const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
      if (scp) {
        host = scp[1];
        repoPath = scp[2];
      }
    }
  } catch {
    return null;
  }
  if (!host || !repoPath) return null;
  return {
    host: host.toLowerCase(),
    repo: repoPath.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/i, '').toLowerCase(),
  };
}

function checkoutIdentityError(dir) {
  let pkg;
  try {
    pkg = readPackage(dir);
  } catch (error) {
    return `package.json unreadable: ${error.message}`;
  }
  if (pkg.name !== UPDATE_PACKAGE_NAME) {
    return `package name is ${String(pkg.name ?? 'missing')}, expected ${UPDATE_PACKAGE_NAME}`;
  }
  const root = projectRoot(dir);
  if (!root) return 'not a git checkout';
  const origin = originUrl(dir);
  if (!origin) return 'git origin is missing';
  const parsed = parseGitHubOrigin(origin);
  if (!parsed || parsed.host !== 'github.com' || parsed.repo !== GITHUB_REPO.toLowerCase()) {
    return `git origin ${origin} is not https://github.com/${GITHUB_REPO}`;
  }
  return null;
}

export function safeResetToBefore(repo, before) {
  const status = trackedDirty(repo);
  if (!status.ok) return { ok: false, error: `refusing rollback; git status failed: ${status.stderr}` };
  if (status.stdout) {
    return {
      ok: false,
      error: `refusing rollback; tracked files changed after merge: ${status.stdout.split('\n').slice(0, 5).join('; ')}`,
    };
  }
  return runGit(['reset', '--hard', before], { cwd: repo });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, action: 'bad-arguments', error: error.message }));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: node scripts/daily-sync.mjs [--dir <repo>] [--check] [--apply] [--restart] [--force] [--run-tests] [--state <file>]');
    console.log('Default is report-only. --apply requires a signed release manifest; --restart is explicit.');
    return;
  }

  const repo = path.resolve(options.dir);
  const today = localDateKey();
  const checkedAt = new Date().toISOString();
  const state = readState(options.state);

  if (!existsSync(path.join(repo, 'package.json'))) {
    console.log(JSON.stringify({ ok: false, action: 'not-a-project', repo, error: 'package.json missing' }));
    process.exitCode = 2;
    return;
  }

  let localVersion;
  try {
    localVersion = readPackageVersion(repo);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, action: 'bad-version', repo, error: error.message }));
    process.exitCode = 2;
    return;
  }

  const identityError = checkoutIdentityError(repo);
  if (identityError) {
    console.log(JSON.stringify({ ok: false, action: 'not-omni-checkout', repo, error: identityError }));
    process.exitCode = 2;
    return;
  }

  if (options.apply) {
    applyLockPath = acquireApplyLock(repo);
    if (!applyLockPath) {
      console.log(JSON.stringify({
        ok: false,
        action: 'already-running',
        repo,
        error: `another update is already in progress: ${options.state}.apply.lock`,
      }));
      process.exitCode = 2;
      return;
    }
  }

  if (!options.apply && !options.check && !options.force && !isSyncDue(state, today)) {
    console.log(JSON.stringify({
      ok: true,
      action: 'already-ran-today',
      skipped: true,
      date: today,
      lastCheckDate: state.lastCheckDate,
      localVersion,
      remoteVersion: state.remoteVersion,
    }));
    return;
  }

  const gitRoot = projectRoot(repo);
  const base = { date: today, lastCheckDate: today, checkedAt, repo, localVersion, gitRoot };

  let remote;
  try {
    remote = await remotePackageVersion();
  } catch (error) {
    const service = await probeService(localVersion);
    const result = { ...base, ok: false, action: 'network-error', remoteVersion: null, service, error: error.message };
    if (!options.check) writeState(options.state, result);
    console.log(JSON.stringify(result));
    process.exitCode = 2;
    return;
  }

  const output = {
    ...base,
    ok: true,
    remoteVersion: remote.version,
    source: remote.source,
    updateAvailable: isNewerVersion(remote.version, localVersion),
  };

  if (options.check) {
    output.action = output.updateAvailable ? 'update-available' : 'up-to-date';
    console.log(JSON.stringify(output));
    return;
  }

  if (!output.updateAvailable) {
    output.action = 'up-to-date';
    output.service = await probeService(localVersion);
    output.restartRequired = !output.service.healthy;
    if (options.restart) {
      output.service = await restartService(localVersion);
      output.restartRequired = !output.service.healthy;
      if (!output.service.healthy) {
        output.ok = false;
        output.action = 'service-restart-failed';
      }
    }
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    if (!output.ok) process.exitCode = 2;
    return;
  }

  if (!options.apply) {
    output.action = 'update-available';
    output.signatureRequired = true;
    output.reportOnly = true;
    output.applyCommand = `node scripts/daily-sync.mjs --dir "${repo}" --apply`;
    output.note = '更新只在显式 --apply 且 Ed25519 签名、包哈希和提交谱系全部通过后执行；不会自动重启 7788。';
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    return;
  }

  if (!gitRoot) {
    output.ok = false;
    output.action = 'not-a-git-checkout';
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const dirty = trackedDirty(repo);
  if (!dirty.ok) {
    output.ok = false;
    output.action = 'git-status-failed';
    output.error = dirty.stderr;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }
  if (dirty.stdout) {
    output.ok = false;
    output.action = 'blocked-dirty';
    output.dirty = dirty.stdout.split('\n').slice(0, 20);
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const before = currentHead(repo);
  if (!before.ok) {
    output.ok = false;
    output.action = 'git-head-failed';
    output.error = before.stderr;
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const fetchResult = gitFetch(repo);
  if (!fetchResult.ok) {
    output.ok = false;
    output.action = 'fetch-failed';
    output.error = fetchResult.stderr;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const target = remoteHead(repo);
  if (!target.ok) {
    output.ok = false;
    output.action = 'remote-head-failed';
    output.error = target.stderr;
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  output.headBefore = before.stdout;
  output.headRemote = target.stdout;

  let verified;
  try {
    const candidate = await fetchReleaseManifest(remote.version);
    // Test-only key injection for the offline CLI integration test. Production
    // runs leave this unset and stay pinned to UPDATE_PUBLIC_KEY_SHA256.
    const testKeyFile = TEST_MODE ? process.env.OMNI_TEST_UPDATE_PUBLIC_KEY_FILE : null;
    const testOptions = testKeyFile
      ? {
          publicKeyPem: readFileSync(testKeyFile, 'utf8'),
          keyId: process.env.OMNI_TEST_UPDATE_KEY_ID || undefined,
          expectedFingerprint: process.env.OMNI_TEST_UPDATE_PUBLIC_KEY_SHA256 || undefined,
        }
      : {};
    verified = verifyManifestForRepo(repo, candidate, remote.version, testOptions);
  } catch (error) {
    output.ok = false;
    output.action = error?.code || 'signature-verification-failed';
    output.error = String(error?.message ?? error);
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const ancestry = runGit(['merge-base', '--is-ancestor', verified.manifest.commit, `origin/${UPDATE_BRANCH}`], { cwd: repo });
  if (!ancestry.ok) {
    output.ok = false;
    output.action = 'signed-commit-not-on-main';
    output.error = `signed commit ${verified.manifest.commit} is not an ancestor of origin/${UPDATE_BRANCH}`;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  output.signature = {
    verified: true,
    keyId: verified.keyId,
    keyFingerprint: verified.keyFingerprint,
    manifestCommit: verified.manifest.commit,
    manifestVersion: verified.manifest.version,
    packageJsonSha256: verified.manifest.packageJsonSha256,
  };
  output.headSigned = verified.manifest.commit;
  output.remoteMainAhead = target.stdout !== verified.manifest.commit;

  const merge = runGit(['merge', '--ff-only', verified.manifest.commit], { cwd: repo });
  if (!merge.ok) {
    output.ok = false;
    output.action = 'blocked-diverged';
    output.error = merge.stderr;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const afterMerge = currentHead(repo);
  if (!afterMerge.ok || afterMerge.stdout !== verified.manifest.commit) {
    safeResetToBefore(repo, before.stdout);
    output.ok = false;
    output.action = 'signed-commit-mismatch';
    output.error = afterMerge.ok
      ? `HEAD is ${afterMerge.stdout}, signed commit is ${verified.manifest.commit}`
      : afterMerge.stderr;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const syntax = verifySyntax(repo);
  if (!syntax.ok) {
    safeResetToBefore(repo, before.stdout);
    output.ok = false;
    output.action = 'verification-failed';
    output.error = syntax.stderr;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  if (options.runTests && !options.skipTests) {
    const tests = NPM_CLI
      ? run(process.execPath, [NPM_CLI, 'test'], { cwd: repo, timeout: 180_000 })
      : run(NPM, ['test'], { cwd: repo, timeout: 180_000 });
    if (!tests.ok) {
      safeResetToBefore(repo, before.stdout);
      output.ok = false;
      output.action = 'tests-failed';
      output.error = (tests.stderr || tests.stdout || 'npm test failed').slice(-2000);
      output.service = await probeService(localVersion);
      writeState(options.state, output);
      console.log(JSON.stringify(output));
      process.exitCode = 2;
      return;
    }
    output.tests = 'passed';
  }

  const updatedVersion = readPackageVersion(repo);
  if (updatedVersion !== remote.version) {
    safeResetToBefore(repo, before.stdout);
    output.ok = false;
    output.action = 'version-mismatch';
    output.localVersionAfter = updatedVersion;
    output.service = await probeService(localVersion);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  output.localVersionAfter = updatedVersion;
  output.headAfter = currentHead(repo).stdout;

  if (verified.launcher) {
    try {
      output.launcher = installLauncherFromCommit({
        repo,
        commit: verified.manifest.commit,
        task: TASK_NAME,
        apply: true,
        restart: false,
      });
    } catch (error) {
      output.ok = false;
      output.action = 'launcher-install-failed';
      output.error = String(error?.message ?? error);
      output.service = await probeService(localVersion);
      writeState(options.state, output);
      console.log(JSON.stringify(output));
      process.exitCode = 2;
      return;
    }
    if (!output.launcher.ok) {
      output.ok = false;
      output.action = 'launcher-install-failed';
      output.error = output.launcher.error || 'launcher installation failed';
      output.service = await probeService(localVersion);
      writeState(options.state, output);
      console.log(JSON.stringify(output));
      process.exitCode = 2;
      return;
    }
  } else {
    output.launcher = { ok: true, skipped: true, reason: 'legacy manifest has no launcher hash' };
  }

  output.action = 'updated';
  output.service = await probeService(updatedVersion);
  output.restartRequired = !output.service.healthy;
  if (options.restart) {
    output.service = await restartService(updatedVersion);
    output.restartRequired = !output.service.healthy;
    if (!output.service.healthy) {
      output.ok = false;
      output.action = 'updated-service-unhealthy';
    }
  }
  writeState(options.state, output);
  console.log(JSON.stringify(output));
  if (!output.ok) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.log(JSON.stringify({ ok: false, action: 'unhandled-error', error: error?.stack || String(error) }));
    process.exitCode = 2;
  });
}
