// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Once-a-day cloud alignment for this checkout.
 *
 * The AI host calls this before the first memory use of the day. The script
 * checks `main/package.json` on GitHub, fast-forwards a clean checkout when the
 * remote version is newer, and restarts the local 7788 service when its
 * `/health` version does not match the checkout. Every attempt is recorded in
 * `~/.dsh/omni-daily-sync.json`, so later calls that day return
 * `already-ran-today` without touching the network.
 *
 * It deliberately refuses to update a dirty tracked tree. Untracked docs are
 * allowed; `git merge --ff-only` will still stop if a remote file would collide.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
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

const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'git',
].filter(Boolean);
const GIT = GIT_CANDIDATES.find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..');
const EXPECTED_PACKAGE_NAME = '@local/omni-memory';
const TASK_NAME = process.env.OMNI_SERVICE_TASK || SERVICE_TASK;
const HEALTH_URL = process.env.OMNI_HEALTH_URL || 'http://127.0.0.1:7788/health';
const SCHTASKS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe')
  : 'schtasks.exe';

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
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

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
    noRestart: false,
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
    } else if (arg === '--no-restart') {
      options.noRestart = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'omni-memory',
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
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

function gitFetch(dir) {
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

async function ensureService(version, noRestart) {
  if (process.platform !== 'win32') {
    return { exists: false, restarted: false, version: null, healthy: false, error: 'unsupported platform' };
  }
  const task = taskExists();
  if (!task.ok) {
    return { exists: false, restarted: false, version: null, healthy: false, error: task.stderr || 'scheduled task not found' };
  }

  let observed = await healthVersion();
  if (observed === version) {
    return { exists: true, restarted: false, version: observed, healthy: true };
  }
  if (noRestart) {
    return {
      exists: true, restarted: false, version: observed, healthy: false,
      error: `service reports ${observed ?? 'no version'}, expected ${version}`,
    };
  }

  run(SCHTASKS, ['/End', '/TN', TASK_NAME]);
  const start = run(SCHTASKS, ['/Run', '/TN', TASK_NAME]);
  if (!start.ok) {
    return { exists: true, restarted: false, version: observed, healthy: false, error: start.stderr || 'schtasks /Run failed' };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    observed = await healthVersion();
    if (observed === version) {
      return { exists: true, restarted: true, version: observed, healthy: true };
    }
  }
  return {
    exists: true, restarted: true, version: observed, healthy: false,
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
function checkoutIdentityError(dir) {
  let pkg;
  try {
    pkg = readPackage(dir);
  } catch (error) {
    return `package.json unreadable: ${error.message}`;
  }
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    return `package name is ${String(pkg.name ?? 'missing')}, expected ${EXPECTED_PACKAGE_NAME}`;
  }
  const root = projectRoot(dir);
  if (!root) return 'not a git checkout';
  const origin = originUrl(dir);
  if (!origin) return 'git origin is missing';
  const normalized = origin
    .replace(/^git@github\.com:/i, 'github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'github.com/')
    .replace(/\.git$/i, '')
    .toLowerCase();
  if (!normalized.includes(`github.com/${GITHUB_REPO.toLowerCase()}`)) {
    return `git origin ${origin} is not ${GITHUB_REPO}`;
  }
  return null;
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
    console.log('Usage: node scripts/daily-sync.mjs [--dir <repo>] [--check] [--force] [--no-restart] [--state <file>]');
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

  if (!options.check && !options.force && !isSyncDue(state, today)) {
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
    const service = await ensureService(localVersion, true);
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
    output.service = await ensureService(localVersion, options.noRestart);
    if (output.service.exists && output.service.healthy === false) output.ok = false;
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    if (!output.ok) process.exitCode = 2;
    return;
  }

  if (!gitRoot) {
    output.ok = false;
    output.action = 'not-a-git-checkout';
    output.service = await ensureService(localVersion, true);
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
    output.service = await ensureService(localVersion, true);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }
  if (dirty.stdout) {
    output.ok = false;
    output.action = 'blocked-dirty';
    output.dirty = dirty.stdout.split('\n').slice(0, 20);
    output.service = await ensureService(localVersion, true);
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
    output.service = await ensureService(localVersion, true);
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
  const merge = runGit(['merge', '--ff-only', `origin/${UPDATE_BRANCH}`], { cwd: repo });
  if (!merge.ok) {
    output.ok = false;
    output.action = 'blocked-diverged';
    output.error = merge.stderr;
    output.service = await ensureService(localVersion, true);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const syntax = verifySyntax(repo);
  if (!syntax.ok) {
    runGit(['reset', '--hard', before.stdout], { cwd: repo });
    output.ok = false;
    output.action = 'verification-failed';
    output.error = syntax.stderr;
    output.service = await ensureService(localVersion, true);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  const updatedVersion = readPackageVersion(repo);
  if (updatedVersion !== remote.version) {
    runGit(['reset', '--hard', before.stdout], { cwd: repo });
    output.ok = false;
    output.action = 'version-mismatch';
    output.localVersionAfter = updatedVersion;
    output.service = await ensureService(localVersion, true);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }

  output.localVersionAfter = updatedVersion;
  output.headAfter = currentHead(repo).stdout;
  output.action = 'updated';
  output.service = await ensureService(updatedVersion, options.noRestart);
  if (output.service.exists && output.service.healthy === false) output.ok = false;
  writeState(options.state, output);
  console.log(JSON.stringify(output));
  if (!output.ok) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ ok: false, action: 'unhandled-error', error: error?.stack || String(error) }));
    process.exitCode = 2;
  });
}
