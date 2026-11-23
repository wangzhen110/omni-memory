// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Read-path version probe. `memory_context` / `/packet` call this before
 * returning memory, so the AI is told about a newer cloud version without
 * waiting for a separate scheduler. The result is cached: a successful check
 * is reused for 30 minutes, a failed check for 5 minutes, and the network call
 * is capped at 2.5 seconds so a slow GitHub cannot stall a memory read.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { compareVersions, GITHUB_REPO, parseVersion, UPDATE_BRANCH } from './daily-sync.mjs';

const LOCAL_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_TTL_MS = Number(process.env.OMNI_VERSION_CHECK_TTL_MS ?? 30 * 60 * 1000);
const DEFAULT_TIMEOUT_MS = Number(process.env.OMNI_VERSION_CHECK_TIMEOUT_MS ?? 2500);
const ERROR_TTL_MS = 5 * 60 * 1000;

export const VERSION_CHECK_TTL_MS = Number.isFinite(DEFAULT_TTL_MS) ? DEFAULT_TTL_MS : 30 * 60 * 1000;
export const VERSION_CHECK_TIMEOUT_MS = Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 2500;

export function defaultVersionCheckPath(home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  return path.join(home, 'omni-version-check.json');
}

function readCache(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeCache(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  } catch {
    // A version probe must never break the memory read.
  }
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'omni-version-check', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function remoteVersion(fetchImpl, timeoutMs) {
  const stamp = Date.now();
  // Contents API is fresh immediately after a push; raw CDN is only a fallback.
  const api = `https://api.github.com/repos/${GITHUB_REPO}/contents/package.json?ref=${UPDATE_BRANCH}&ts=${stamp}`;
  try {
    const envelope = await fetchJson(api, fetchImpl, timeoutMs);
    const pkg = JSON.parse(Buffer.from(String(envelope.content ?? ''), 'base64').toString('utf8'));
    if (parseVersion(pkg.version)) return { version: pkg.version, source: 'contents-api' };
  } catch {
    // Fall through to raw.
  }
  const raw = `https://raw.githubusercontent.com/${GITHUB_REPO}/${UPDATE_BRANCH}/package.json?ts=${stamp}`;
  const pkg = await fetchJson(raw, fetchImpl, timeoutMs);
  if (!parseVersion(pkg.version)) throw new Error('remote package.json has no valid version');
  return { version: pkg.version, source: 'raw-main' };
}

export async function checkForUpdate(options = {}) {
  const localVersion = String(options.localVersion ?? LOCAL_VERSION);
  const nowMs = Number(options.now ?? Date.now());
  const cachePath = options.cachePath ?? defaultVersionCheckPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = Number.isFinite(Number(options.ttlMs ?? VERSION_CHECK_TTL_MS))
    ? Number(options.ttlMs ?? VERSION_CHECK_TTL_MS) : VERSION_CHECK_TTL_MS;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS))
    ? Number(options.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS) : VERSION_CHECK_TIMEOUT_MS;
  const checkedAt = new Date(nowMs).toISOString();
  const cache = readCache(cachePath);

  if (process.env.OMNI_VERSION_CHECK_DISABLED === '1' && !options.force) {
    return { ok: true, localVersion, remoteVersion: localVersion, updateAvailable: false, checkedAt, disabled: true };
  }
  if (!parseVersion(localVersion)) {
    return { ok: false, localVersion, remoteVersion: null, updateAvailable: false, checkedAt, error: 'local package version is invalid' };
  }

  const fresh = cache
    && cache.localVersion === localVersion
    && Number.isFinite(cache.checkedAtMs)
    && nowMs >= cache.checkedAtMs
    && nowMs - cache.checkedAtMs < (cache.ok === true ? ttlMs : ERROR_TTL_MS);
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
      remoteVersion: cache?.remoteVersion ?? null,
      updateAvailable: false,
      checkedAt: new Date(nowMs).toISOString(),
      checkedAtMs: nowMs,
      error: String(error?.message ?? error),
    };
    writeCache(cachePath, result);
    return result;
  }
}

export function formatUpdateNotice(info) {
  if (!info?.updateAvailable || !info.remoteVersion || !info.localVersion) return '';
  return [
    '## 版本提醒（优先处理）',
    `云端已有 v${info.remoteVersion}，当前本地 v${info.localVersion}。`,
    '请先运行项目根目录的 `node scripts/daily-sync.mjs` 更新并重启 7788，再继续使用记忆。',
  ].join('\n');
}
