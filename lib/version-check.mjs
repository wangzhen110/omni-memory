// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Read-path version probe. `memory_context` / `/packet` call this before
 * returning memory, so the AI is told about a newer cloud version without
 * waiting for a separate scheduler. The result is cached: a successful check
 * is reused for 30 minutes, a failed check for 5 minutes, and the *whole*
 * network attempt (Contents API plus raw fallback) shares one 2.5 second
 * budget so a slow GitHub cannot stall a memory read.
 *
 * This module only reports. It never runs the update script, never restarts a
 * service, and never treats a cached number as permission to execute code.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { compareVersions, GITHUB_REPO, parseVersion, UPDATE_BRANCH } from './daily-sync.mjs';

const DEFAULT_TTL_MS = Number(process.env.OMNI_VERSION_CHECK_TTL_MS ?? 30 * 60 * 1000);
const DEFAULT_TIMEOUT_MS = Number(process.env.OMNI_VERSION_CHECK_TIMEOUT_MS ?? 2500);
const ERROR_TTL_MS = 5 * 60 * 1000;
const SOURCES = new Set(['contents-api', 'raw-main']);
const MEMORY_CACHE = new Map();

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export const VERSION_CHECK_TTL_MS = positiveNumber(DEFAULT_TTL_MS, 30 * 60 * 1000);
export const VERSION_CHECK_TIMEOUT_MS = positiveNumber(DEFAULT_TIMEOUT_MS, 2500);

function displayVersion(value) {
  return String(value ?? '').trim().replace(/^[vV]/, '');
}

function validVersion(value) {
  const text = displayVersion(value);
  return parseVersion(text) ? text : null;
}

/** Read the on-disk version lazily, without making plugin import a hard dependency. */
export function readLocalVersion(packagePath = new URL('../package.json', import.meta.url)) {
  try {
    const raw = readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, '');
    return validVersion(JSON.parse(raw)?.version);
  } catch {
    return null;
  }
}

export function defaultVersionCheckPath(home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  return path.join(path.resolve(home), 'omni-version-check.json');
}

/**
 * Rebuild a small, typed record instead of trusting whatever is on disk.
 * A malformed or injected cache is discarded, not passed through to the prompt.
 */
function readCache(file) {
  if (MEMORY_CACHE.has(file)) return MEMORY_CACHE.get(file);
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const checkedAtMs = Number(value.checkedAtMs);
    if (!Number.isFinite(checkedAtMs) || checkedAtMs <= 0) return null;
    if (typeof value.ok !== 'boolean') return null;
    const localVersion = validVersion(value.localVersion);
    if (!localVersion) return null;
    if (value.ok === true) {
      const remoteVersion = validVersion(value.remoteVersion);
      if (!remoteVersion) return null;
      return {
        ok: true,
        localVersion,
        remoteVersion,
        updateAvailable: compareVersions(remoteVersion, localVersion) === 1,
        checkedAtMs,
        checkedAt: new Date(checkedAtMs).toISOString(),
        source: SOURCES.has(value.source) ? value.source : 'contents-api',
      };
    }
    return {
      ok: false,
      localVersion,
      remoteVersion: null,
      updateAvailable: false,
      checkedAtMs,
      checkedAt: new Date(checkedAtMs).toISOString(),
      error: typeof value.error === 'string' ? value.error.slice(0, 200) : 'cached version check failed',
    };
  } catch {
    return null;
  }
}

function writeCache(file, value) {
  MEMORY_CACHE.set(file, value);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    // A version probe must never break the memory read.
  }
}

async function fetchJson(url, fetchImpl, deadline) {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error('version probe budget exhausted');
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'omni-memory', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(remaining),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function remoteVersion(fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/package.json?ref=${UPDATE_BRANCH}`;
  try {
    const envelope = await fetchJson(api, fetchImpl, deadline);
    const pkg = JSON.parse(Buffer.from(String(envelope.content ?? ''), 'base64').toString('utf8'));
    const version = validVersion(pkg.version);
    if (version) return { version, source: 'contents-api' };
  } catch {
    // Fall through to raw only while the shared budget still has time.
  }
  const raw = `https://raw.githubusercontent.com/${GITHUB_REPO}/${UPDATE_BRANCH}/package.json`;
  const pkg = await fetchJson(raw, fetchImpl, deadline);
  const version = validVersion(pkg.version);
  if (!version) throw new Error('remote package.json has no valid version');
  return { version, source: 'raw-main' };
}

export async function checkForUpdate(options = {}) {
  const localVersion = validVersion(options.localVersion ?? readLocalVersion());
  const nowMs = Number(options.now ?? Date.now());
  const cachePath = options.cachePath ?? defaultVersionCheckPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = positiveNumber(options.ttlMs ?? process.env.OMNI_VERSION_CHECK_TTL_MS ?? VERSION_CHECK_TTL_MS, VERSION_CHECK_TTL_MS);
  const timeoutMs = positiveNumber(options.timeoutMs ?? process.env.OMNI_VERSION_CHECK_TIMEOUT_MS ?? VERSION_CHECK_TIMEOUT_MS, VERSION_CHECK_TIMEOUT_MS);
  const checkedAt = new Date(nowMs).toISOString();

  if (process.env.OMNI_VERSION_CHECK_DISABLED === '1' && !options.force) {
    return { ok: true, localVersion, remoteVersion: null, updateAvailable: false, checkedAt, disabled: true };
  }
  if (!localVersion) {
    return { ok: false, localVersion: null, remoteVersion: null, updateAvailable: false, checkedAt, error: 'local package version is invalid' };
  }

  const cache = readCache(cachePath);
  const ttl = cache?.ok === true ? ttlMs : ERROR_TTL_MS;
  const fresh = cache
    && cache.localVersion === localVersion
    && nowMs >= cache.checkedAtMs
    && nowMs - cache.checkedAtMs < ttl;
  if (!options.force && fresh) return { ...cache, cached: true };

  try {
    const remote = await remoteVersion(fetchImpl, timeoutMs);
    const result = {
      ok: true,
      localVersion,
      remoteVersion: remote.version,
      updateAvailable: compareVersions(remote.version, localVersion) === 1,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      source: remote.source,
    };
    writeCache(cachePath, result);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      localVersion,
      remoteVersion: null,
      updateAvailable: false,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      error: String(error?.message ?? error).slice(0, 200),
    };
    writeCache(cachePath, result);
    return result;
  }
}

export function formatUpdateNotice(info) {
  if (info?.ok === false) return '';
  const localVersion = validVersion(info?.localVersion);
  const remoteVersion = validVersion(info?.remoteVersion);
  if (!localVersion || !remoteVersion || compareVersions(remoteVersion, localVersion) !== 1) return '';
  return [
    '## 版本提醒（需用户确认）',
    `云端已发布 v${remoteVersion}，当前本地 v${localVersion}。`,
    `是否更新由用户决定。确认后可在项目根目录运行 \`node scripts/daily-sync.mjs\`；若当天已经同步过，加 \`--force\`。`,
    '该脚本会 fast-forward 工作树并重启 7788；失败时可能回滚到同步前提交。',
  ].join('\n');
}
