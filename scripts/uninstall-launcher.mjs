#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Remove the 7788 scheduled task and launcher sidecar without touching the
 * memory database. Logs are left in place unless --remove-logs is explicit.
 *
 * The task action is inspected before deletion: a task that points outside the
 * Omni home is never modified, so an unrelated scheduled task cannot be
 * uninstalled by mistake.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
const DEFAULT_HOME = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
const DEFAULT_TASK = process.env.OMNI_SERVICE_TASK || 'OmniMemory7788';
const EXE_PATTERN = /^omni-serve-7788(?:-[0-9a-f]{8})?\.exe$/i;

function run(command, args) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim() };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? '').trim(), stderr: String(error?.stderr ?? error?.message ?? error).trim() };
  }
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

export function withinHome(file, home) {
  const resolved = path.resolve(file);
  const base = path.resolve(home);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

export function uninstallLauncher(options = {}) {
  const home = path.resolve(options.home || DEFAULT_HOME);
  const taskName = options.task || DEFAULT_TASK;
  const dryRun = Boolean(options.dryRun);
  const noTask = Boolean(options.noTask);
  const result = {
    ok: true,
    dryRun,
    home,
    task: taskName,
    taskFound: false,
    taskRemoved: false,
    serviceStopped: false,
    command: null,
    removed: [],
    kept: [],
  };

  if (!noTask) {
    const command = taskCommand(taskName);
    result.command = command;
    result.taskFound = Boolean(command);
    if (command && !withinHome(command, home)) {
      return { ...result, ok: false, error: `refusing to remove task ${taskName}: action is outside ${home}` };
    }
    if (command) {
      if (!dryRun) {
        const ended = run(SCHTASKS, ['/End', '/TN', taskName]);
        result.serviceStopped = ended.ok;
        const deleted = run(SCHTASKS, ['/Delete', '/TN', taskName, '/F']);
        result.taskRemoved = deleted.ok;
        if (!deleted.ok) result.ok = false;
      }
    }
  }

  const sidecar = path.join(home, 'omni-serve-7788.json');
  if (existsSync(sidecar)) {
    if (dryRun) result.kept.push(sidecar);
    else {
      rmSync(sidecar, { force: true });
      result.removed.push(sidecar);
    }
  }

  const binaries = existsSync(home) ? readdirSync(home).filter(name => EXE_PATTERN.test(name)).map(name => path.join(home, name)) : [];
  for (const binary of binaries) {
    if (options.removeBinaries) {
      if (dryRun) result.kept.push(binary);
      else {
        rmSync(binary, { force: true });
        result.removed.push(binary);
      }
    } else {
      result.kept.push(binary);
    }
  }

  if (options.removeLogs && existsSync(home)) {
    for (const name of readdirSync(home)) {
      if (!/^omni-serve-7788(?:\.[0-9]+)?\.(?:log|err\.log|stdout\.log|stderr\.log|launcher\.err\.log)$/i.test(name)) continue;
      const file = path.join(home, name);
      if (dryRun) result.kept.push(file);
      else {
        rmSync(file, { force: true });
        result.removed.push(file);
      }
    }
  }

  return result;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/uninstall-launcher.mjs [--home <dir>] [--task <name>] [--dry-run] [--no-task] [--remove-binaries] [--remove-logs]');
    console.log('The database and memory data are never removed.');
    return;
  }
  const value = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const result = uninstallLauncher({
    home: value('--home'),
    task: value('--task'),
    dryRun: argv.includes('--dry-run'),
    noTask: argv.includes('--no-task'),
    removeBinaries: argv.includes('--remove-binaries'),
    removeLogs: argv.includes('--remove-logs'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('uninstall-launcher.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exitCode = 2;
  }
}
