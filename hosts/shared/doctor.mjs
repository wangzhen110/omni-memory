// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * `omni doctor` — read-only installation diagnosis.
 *
 * It answers the questions a new user actually has: is Node new enough, where
 * will the database live, can this process write there, does the existing DB
 * pass SQLite integrity, are the local semantic assets present, is the 7788
 * service up, and does the scheduled task point at the signed launcher?
 *
 * Nothing here mutates the store: the database is opened read-only and all
 * service checks are GETs to loopback.
 */
import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN_NODE = '22.13.0';
const DEFAULT_PORT = 7788;
const DEFAULT_TASK = 'OmniMemory7788';
const SEMANTIC_FILES = [
  ['models/bge-small-zh-v1.5/model_int8.onnx', 10 * 1024 * 1024],
  ['models/bge-small-zh-v1.5/tokenizer.json', 100 * 1024],
  ['lib/vendor/ort-wasm-simd-threaded.wasm', 5 * 1024 * 1024],
  ['lib/vendor/tokenizers.min.mjs', 10 * 1024],
];


function resolveHome(value) {
  if (value) return path.resolve(String(value));
  return path.resolve(process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh'));
}

function versionParts(value) {
  return String(value)
    .replace(/^v/, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map(part => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual, minimum) {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? error?.message ?? error).trim(),
    };
  }
}

function readPackage(repo) {
  return JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
}

function inspectTask(taskName, launcherSha8) {
  if (process.platform !== 'win32') {
    return { status: 'warn', detail: 'launcher task is Windows-only; core works without it' };
  }
  if (taskName === false || taskName === null) {
    return { status: 'ok', detail: 'scheduled task check skipped' };
  }
  const schtasks = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
  const result = run(schtasks, ['/Query', '/TN', String(taskName), '/XML']);
  if (!result.ok) {
    return { status: 'warn', detail: `scheduled task ${taskName} not found; run install with --apply --start` };
  }
  const command = (result.stdout.match(/<Command>(.*?)<\/Command>/is)?.[1] || '').replaceAll('&quot;', '"').trim();
  if (!command) {
    return { status: 'warn', detail: `scheduled task ${taskName} has no executable action` };
  }
  const base = path.basename(command);
  if (launcherSha8 && base.includes(`omni-serve-7788-${launcherSha8}.exe`)) {
    return { status: 'ok', detail: `task ${taskName} → ${base}` };
  }
  if (base === 'omni-serve-7788.exe') {
    return { status: 'warn', detail: `task ${taskName} still points at the old unversioned launcher; reinstall --apply` };
  }
  return { status: 'warn', detail: `task ${taskName} points at ${base || command}; expected omni-serve-7788-${launcherSha8}.exe` };
}

function inspectDatabase(dbFile) {
  if (!existsSync(dbFile)) {
    return {
      status: 'warn',
      detail: `database not created yet: ${dbFile}; the first write will create it`,
      exists: false,
    };
  }
  const size = statSync(dbFile).size;
  if (size < 4096) {
    return { status: 'fail', detail: `database is too small to be valid: ${humanBytes(size)}` };
  }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityValue = Object.values(integrity || {})[0];
    if (integrityValue !== 'ok') {
      return { status: 'fail', detail: `SQLite integrity_check: ${integrityValue}` };
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name),
    );
    for (const required of ['notes', 'facts', 'chunks']) {
      if (!tables.has(required)) {
        return { status: 'fail', detail: `database is missing table: ${required}` };
      }
    }
    let schema = null;
    if (tables.has('meta')) {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      schema = row?.value ?? null;
    }
    const counts = {
      notes: Number(db.prepare('SELECT count(*) AS n FROM notes').get()?.n || 0),
      facts: Number(db.prepare('SELECT count(*) AS n FROM facts').get()?.n || 0),
    };
    return {
      status: 'ok',
      detail: `${humanBytes(size)} · integrity ok · schema ${schema || '?'} · ${counts.notes} notes / ${counts.facts} facts`,
      schema,
      counts,
    };
  } catch (error) {
    return { status: 'fail', detail: `cannot read database read-only: ${error?.message ?? error}` };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

async function inspectHttp(port, expectedVersion) {
  if (port === false || port === null) {
    return { status: 'ok', detail: 'HTTP check skipped' };
  }
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
    return { status: 'fail', detail: `invalid port: ${port}` };
  }
  try {
    const response = await fetch(`http://127.0.0.1:${numeric}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { status: 'warn', detail: `http://127.0.0.1:${numeric}/health → HTTP ${response.status}` };
    const health = await response.json();
    if (!health?.ok) return { status: 'warn', detail: `service answered but health.ok is false` };
    const versionNote = expectedVersion && health.version !== expectedVersion
      ? ` · running ${health.version}, package ${expectedVersion}`
      : ` · v${health.version}`;
    return {
      status: expectedVersion && health.version !== expectedVersion ? 'warn' : 'ok',
      detail: `http://127.0.0.1:${numeric} up${versionNote} · ${health.tools ?? '?'} tools`,
      version: health.version,
    };
  } catch (error) {
    return {
      status: 'warn',
      detail: `http://127.0.0.1:${numeric} not reachable (${error?.name === 'TimeoutError' ? 'timeout' : 'connection failed'}); run install --apply --start`,
    };
  }
}

/**
 * @param {{
 *   repo?: string,
 *   home?: string,
 *   port?: number|false,
 *   task?: string|false,
 *   strict?: boolean,
 * }} [options]
 */
export async function runDoctor(options = {}) {
  const repo = path.resolve(options.repo || ROOT);
  const home = resolveHome(options.home);
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  const task = options.task === undefined ? DEFAULT_TASK : options.task;
  const checks = [];

  const add = (name, status, detail) => {
    checks.push({ name, status, detail });
  };

  let pkg = {};
  let packageError = null;
  try {
    pkg = readPackage(repo);
  } catch (error) {
    packageError = error;
  }

  // 1. Node runtime
  if (versionAtLeast(process.versions.node, MIN_NODE)) {
    add('node', 'ok', `${process.versions.node} (>= ${MIN_NODE})`);
  } else {
    add('node', 'fail', `${process.versions.node}; need >= ${MIN_NODE}`);
  }

  // 2. Repository identity and signed launcher metadata
  if (packageError) {
    add('repo', 'fail', `cannot read package.json in ${repo}: ${packageError.message}`);
  } else {
    const launcherSha = String(pkg.omni?.launcher?.sha256 || '').toLowerCase();
    const launcherPath = pkg.omni?.launcher?.path;
    const launcherOk = /^[0-9a-f]{64}$/.test(launcherSha) && launcherPath === 'scripts/launchers/omni-serve-7788.exe';
    add('repo', launcherOk ? 'ok' : 'warn', launcherOk
      ? `${pkg.name} ${pkg.version} · signed launcher ${launcherSha.slice(0, 8)}`
      : `${pkg.name || '?'} ${pkg.version || '?'} · launcher metadata is incomplete`);
  }

  // 3. Data directory (read/write, not existence of the DB itself)
  const memoryDir = path.join(home, 'memory');
  try {
    if (existsSync(memoryDir)) {
      accessSync(memoryDir, constants.R_OK | constants.W_OK);
      add('data-dir', 'ok', `${memoryDir} readable + writable`);
    } else {
      const parent = path.dirname(memoryDir);
      accessSync(parent, constants.R_OK | constants.W_OK);
      add('data-dir', 'warn', `${memoryDir} does not exist yet; the first write will create it`);
    }
  } catch (error) {
    add('data-dir', 'fail', `cannot write ${memoryDir}: ${error.message}`);
  }

  // 4. Database integrity, read-only
  const dbResult = inspectDatabase(path.join(memoryDir, 'omni.db'));
  add('database', dbResult.status, dbResult.detail);

  // 5. Semantic assets
  const missing = [];
  let semanticBytes = 0;
  for (const [relative, minimum] of SEMANTIC_FILES) {
    const file = path.join(repo, ...relative.split('/'));
    if (!existsSync(file)) {
      missing.push(relative);
      continue;
    }
    const size = statSync(file).size;
    semanticBytes += size;
    if (size < minimum) missing.push(`${relative} (truncated)`);
  }
  add('semantic', missing.length ? 'warn' : 'ok', missing.length
    ? `semantic recall will be off: missing ${missing.join(', ')}`
    : `${SEMANTIC_FILES.length} files · ${humanBytes(semanticBytes)}; local vector recall can load`);

  // 6. Running HTTP service
  const httpResult = await inspectHttp(port, pkg.version);
  add('http', httpResult.status, httpResult.detail);

  // 7. Scheduled task / versioned launcher
  const launcherSha = String(pkg.omni?.launcher?.sha256 || '').toLowerCase();
  const taskResult = inspectTask(task, launcherSha.slice(0, 8));
  add('launcher', taskResult.status, taskResult.detail);

  // 8. DSH plugin metadata (host integration, not memory core)
  if (packageError) {
    add('dsh-plugin', 'warn', 'package.json unavailable, cannot inspect DSH metadata');
  } else {
    const patch = pkg.dsh?.bundle?.patch;
    const patchExists = typeof patch === 'string' && existsSync(path.join(repo, patch));
    const clientExists = existsSync(path.join(repo, 'client.js'));
    add('dsh-plugin', patchExists && clientExists ? 'ok' : 'warn', patchExists && clientExists
      ? `DH bundle ${patch} + client.js present`
      : 'DSH bundle metadata incomplete; core HTTP/MCP/CLI still works');
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  const ok = counts.fail === 0 && (!options.strict || counts.warn === 0);
  const status = counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok';
  return {
    ok,
    status,
    strict: Boolean(options.strict),
    version: pkg.version || null,
    node: process.versions.node,
    repo,
    home,
    db: path.join(memoryDir, 'omni.db'),
    port: port === false ? null : Number(port),
    task: task === false ? null : String(task),
    counts,
    checks,
  };
}

export function formatDoctor(result) {
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  const lines = [
    `全息记忆 doctor · ${result.repo}`,
    `数据根目录: ${result.home}`,
    `数据库: ${result.db}`,
    '',
  ];
  for (const check of result.checks) {
    lines.push(`${icon[check.status] || '?'} ${check.name.padEnd(12)} ${check.detail}`);
  }
  lines.push('');
  const verdict = result.ok
    ? result.counts.warn
      ? `通过（0 错误，${result.counts.warn} 警告）`
      : '通过（0 错误，0 警告）'
    : `未通过（${result.counts.fail} 错误，${result.counts.warn} 警告）`;
  lines.push(`结果: ${verdict}`);
  if (result.counts.warn && !result.counts.fail) {
    lines.push('提示: 警告不会阻止本地记忆内核运行；需要完整服务时按上面提示修复。');
  }
  return lines.join('\n');
}
