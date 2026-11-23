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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GITHUB_REPO,
  SERVICE_TASK,
  UPDATE_BRANCH,
  defaultStatePath,
  isNewerVersion,
  localDateKey,
  parseVersion,
  shouldRunSync,
} from '../lib/daily-sync.mjs';

const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'git',
].filter(Boolean);
const GIT = GIT_CANDIDATES.find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
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
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readPackageVersion(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!parseVersion(pkg.version)) throw new Error(`invalid package version: ${pkg.version}`);
  return pkg.version;
}

function readState(file) {
  try {
    const value = readJson(file);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function cachedRemoteVersion() {
  const home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return readState(path.join(home, 'omni-version-check.json')).remoteVersion ?? null;
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
    dir: process.cwd(),
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
      'user-agent': 'omni-daily-sync',
      'cache-control': 'no-cache',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.text();
}

async function remotePackageVersion() {
  const stamp = Date.now();
  // GitHub's contents API reflects a fresh push immediately; raw.githubusercontent
  // can serve a stale CDN copy for minutes. Daily volume is tiny, so API first.
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/package.json?ref=${UPDATE_BRANCH}&ts=${stamp}`;
  try {
    const envelope = JSON.parse(await fetchText(api));
    const pkg = JSON.parse(Buffer.from(String(envelope.content ?? ''), 'base64').toString('utf8'));
    if (parseVersion(pkg.version)) return { version: pkg.version, source: 'contents-api' };
  } catch {
    // Fall back to the raw CDN below.
  }
  const raw = `https://raw.githubusercontent.com/${GITHUB_REPO}/${UPDATE_BRANCH}/package.json?ts=${stamp}`;
  const pkg = JSON.parse(await fetchText(raw));
  if (!parseVersion(pkg.version)) throw new Error('remote package.json has no valid version');
  return { version: pkg.version, source: 'raw-main' };
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

function verifySyntax(dir) {
  return run(process.execPath, ['--check', path.join(dir, 'index.js')], { cwd: dir });
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
    return { exists: false, restarted: false, version: null, healthy: false };
  }
  const task = taskExists();
  if (!task.ok) return { exists: false, restarted: false, version: null, healthy: false };

  let observed = await healthVersion();
  if (observed === version) {
    return { exists: true, restarted: false, version: observed, healthy: true };
  }
  if (noRestart) {
    return { exists: true, restarted: false, version: observed, healthy: false };
  }

  run(SCHTASKS, ['/End', '/TN', TASK_NAME]);
  const start = run(SCHTASKS, ['/Run', '/TN', TASK_NAME]);
  if (!start.ok) {
    return { exists: true, restarted: false, version: observed, healthy: false, error: start.stderr };
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    observed = await healthVersion();
    if (observed === version) {
      return { exists: true, restarted: true, version: observed, healthy: true };
    }
  }
  return { exists: true, restarted: true, version: observed, healthy: false };
}

function projectRoot(dir) {
  const root = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
  return root.ok ? path.resolve(root.stdout) : null;
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

  const localVersion = readPackageVersion(repo);
  const cachedRemote = cachedRemoteVersion();

  if (!options.check && !options.force
    && !shouldRunSync(state, today, { localVersion, cachedRemoteVersion: cachedRemote })) {
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
    output.service = await ensureService(localVersion, options.noRestart);
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
    output.service = await ensureService(localVersion, options.noRestart);
    writeState(options.state, output);
    console.log(JSON.stringify(output));
    process.exitCode = 2;
    return;
  }
  if (dirty.stdout) {
    output.ok = false;
    output.action = 'blocked-dirty';
    output.dirty = dirty.stdout.split('\n').slice(0, 20);
    output.service = await ensureService(localVersion, options.noRestart);
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
    output.service = await ensureService(localVersion, options.noRestart);
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
    output.service = await ensureService(localVersion, options.noRestart);
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
    output.service = await ensureService(localVersion, options.noRestart);
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
    output.service = await ensureService(localVersion, options.noRestart);
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
