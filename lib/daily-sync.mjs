// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.

/**
 * Pure helpers for the once-a-day cloud version check. Keeping the version
 * comparison and the date gate separate from git/network/filesystem code lets
 * the update script be tested without touching a real repository.
 */
import { homedir } from 'node:os';
import path from 'node:path';

export const GITHUB_REPO = 'wangzhen110/omni-memory';
export const UPDATE_BRANCH = 'main';
export const SERVICE_TASK = 'OmniMemory7788';

export function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^[vV]?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Returns -1, 0 or 1 when both versions are valid; null otherwise. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(remote, local) {
  return compareVersions(remote, local) === 1;
}

/** Local calendar date, not UTC: the update gate follows the user's day. */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isSyncDue(state, date = localDateKey()) {
  if (!state) return true;
  return (state.lastCheckDate ?? state.date) !== date;
}

/**
 * A same-day repeat is skipped only if no newer remote version is already known.
 * The read-path probe caches the remote version, so a version published after
 * the morning sync can still trigger an update without requiring `--force`.
 */
export function shouldRunSync(state, date = localDateKey(), { localVersion = null, cachedRemoteVersion = null } = {}) {
  if (isSyncDue(state, date)) return true;
  if (!localVersion || !cachedRemoteVersion) return false;
  return isNewerVersion(cachedRemoteVersion, localVersion);
}


export function defaultStatePath(home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  return path.join(home, 'omni-daily-sync.json');
}
