#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Install a launcher binary from a signed commit without ever overwriting a
 * running executable. The task points at a content-addressed copy
 * (`omni-serve-7788-<sha8>.exe`), so an update can stage the new binary while
 * the old service keeps serving; `--restart` switches the scheduled task.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UPDATE_LAUNCHER_PATH = 'scripts/launchers/omni-serve-7788.exe';
const UPDATE_PACKAGE_NAME = '@local/omni-memory';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_CANDIDATES = [process.env.GIT_BIN, 'C:\\Program Files\\Git\\cmd\\git.exe', 'git'].filter(Boolean);
const GIT = GIT_CANDIDATES.find(candidate => candidate === 'git' || existsSync(candidate)) || 'git';
const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_HOME = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
const DEFAULT_TASK = process.env.OMNI_SERVICE_TASK || 'OmniMemory7788';

function run(command, args, options = {}) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options }).trim() };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? '').trim(), stderr: String(error?.stderr ?? error?.message ?? error).trim() };
  }
}

function gitShow(repo, commit, file) {
  return execFileSync(GIT, ['show', `${commit}:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function launcherTargetPath(home, sha256Hex) {
  return path.join(home, `omni-serve-7788-${sha256Hex.slice(0, 8)}.exe`);
}

function writeConfig(home, config) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'omni-serve-7788.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (existsSync(file)) rmSync(file, { force: true });
  renameSync(temporary, file);
  return file;
}

function taskXml(taskName) {
  const result = run(SCHTASKS, ['/Query', '/TN', taskName, '/XML']);
  return result.ok ? result.stdout : null;
}

function taskCommand(taskName) {
  const xml = taskXml(taskName);
  if (!xml) return null;
  const match = xml.match(/<Command>(.*?)<\/Command>/is);
  return match ? match[1].replaceAll('&quot;', '"').trim() : null;
}

function stopTask(taskName) {
  return run(SCHTASKS, ['/End', '/TN', taskName]);
}

function startTask(taskName) {
  return run(SCHTASKS, ['/Run', '/TN', taskName]);
}

function psQuote(value) {
  return String(value).replaceAll("'", "''");
}

function changeTaskCommand(taskName, target, home) {
  // `schtasks /Change /TR` asks for the run-as password on some Windows builds
  // even for an Interactive token. Set-ScheduledTask updates the same action
  // without that prompt, and windowsHide keeps the helper invisible.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute '${psQuote(target)}' -WorkingDirectory '${psQuote(home)}'`,
    `Set-ScheduledTask -TaskName '${psQuote(taskName)}' -Action $action | Out-Null`,
  ].join('; ');
  return run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function createTask(taskName, target) {
  // A fresh checkout has no OmniMemory7788 task. `/SC ONLOGON` is enough for a
  // user-level memory daemon: it starts when the user logs in, in the user's
  // own token, and the launcher reads its config from the executable's folder.
  // The path is quoted for schtasks; `/F` makes an interrupted previous run
  // recoverable without a password prompt.
  return run(SCHTASKS, [
    '/Create', '/SC', 'ONLOGON', '/TN', taskName,
    '/TR', `"${target}"`, '/RL', 'LIMITED', '/F',
  ]);
}

export function installLauncherFromCommit(options = {}) {
  const repo = path.resolve(options.repo || ROOT);
  const home = path.resolve(options.home || DEFAULT_HOME);
  const taskName = options.task || DEFAULT_TASK;
  const commit = String(options.commit || run(GIT, ['rev-parse', 'HEAD'], { cwd: repo }).stdout || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const pkg = JSON.parse(gitShow(repo, commit, 'package.json').toString('utf8').replace(/^\uFEFF/, ''));
  if (pkg.name !== UPDATE_PACKAGE_NAME) throw new Error(`package.json name is ${pkg.name}`);
  const declared = String(pkg.omni?.launcher?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declared)) throw new Error('package.json has no valid omni.launcher.sha256');
  if (pkg.omni?.launcher?.path !== UPDATE_LAUNCHER_PATH) throw new Error(`package.json launcher path is ${pkg.omni?.launcher?.path}`);
  const bytes = gitShow(repo, commit, UPDATE_LAUNCHER_PATH);
  const actual = sha256(bytes);
  if (actual !== declared) throw new Error(`launcher hash mismatch: package ${declared}, commit ${actual}`);
  const target = path.resolve(options.target || launcherTargetPath(home, actual));
  const configFile = path.join(home, 'omni-serve-7788.json');
  const config = {
    repo,
    node: path.resolve(options.node || process.execPath),
    port: Number(options.port || 7788),
    mainLog: path.join(home, 'omni-serve-7788.log'),
    errorLog: path.join(home, 'omni-serve-7788.err.log'),
    stdoutLog: path.join(home, 'omni-serve-7788.stdout.log'),
    stderrLog: path.join(home, 'omni-serve-7788.stderr.log'),
    launcherErrorLog: path.join(home, 'omni-serve-7788.launcher.err.log'),
  };
  const apply = Boolean(options.apply);
  const restart = Boolean(options.restart);
  const taskMissing = taskCommand(taskName) === null;
  const createTaskIfMissing = Boolean(options.createTask);
  const noTask = Boolean(options.noTask) || (taskMissing && !createTaskIfMissing);
  const installed = existsSync(target) && sha256(readFileSync(target)) === actual;
  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      commit,
      sha256: actual,
      target,
      configFile,
      installed,
      task: taskName,
      noTask,
      taskMissing,
      taskWillBeCreated: taskMissing && createTaskIfMissing && !noTask,
    };
  }
  if (process.platform !== 'win32') throw new Error('launcher installation is Windows-only');
  writeConfig(home, config);
  if (!installed) {
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o755 });
    renameSync(temporary, target);
  }
  if (!noTask) {
    if (taskMissing && createTaskIfMissing) {
      const created = createTask(taskName, target);
      if (!created.ok) return {
        ok: false, commit, sha256: actual, target, configFile, installed: true, noTask,
        error: created.stderr || created.stdout || 'schtasks /Create failed',
      };
    } else {
      const changed = changeTaskCommand(taskName, target, home);
      if (!changed.ok) return {
        ok: false, commit, sha256: actual, target, configFile, installed: true, noTask,
        error: changed.stderr || changed.stdout || 'schtasks /Change failed',
      };
    }
    if (restart) {
      stopTask(taskName);
      const started = startTask(taskName);
      if (!started.ok) return {
        ok: false, commit, sha256: actual, target, configFile, installed: true, noTask,
        error: started.stderr || started.stdout || 'schtasks /Run failed',
      };
    }
  }
  return {
    ok: true,
    dryRun: false,
    commit,
    sha256: actual,
    target,
    configFile,
    installed: true,
    task: taskName,
    noTask,
    taskMissing,
    taskWillBeCreated: taskMissing && createTaskIfMissing && !noTask,
    restart,
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/install-launcher.mjs [--repo <dir>] [--commit <sha>] [--home <dir>] [--task <name>] [--target <exe>] [--node <node.exe>] [--port <port>] [--apply] [--restart] [--no-task] [--create-task]');
    console.log('Without --apply it only prints the planned content-addressed target.');
    console.log('--create-task creates the scheduled task when it does not exist; without it a missing task is reported as noTask.');
    return;
  }
  const value = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const result = installLauncherFromCommit({
    repo: value('--repo'),
    commit: value('--commit'),
    home: value('--home'),
    task: value('--task'),
    target: value('--target'),
    node: value('--node'),
    port: value('--port'),
    apply: argv.includes('--apply'),
    restart: argv.includes('--restart'),
    noTask: argv.includes('--no-task'),
    createTask: argv.includes('--create-task'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('install-launcher.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exitCode = 2;
  }
}
