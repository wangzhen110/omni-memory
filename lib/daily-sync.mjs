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
  const match = String(value ?? '').trim().match(/^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
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
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart > rightPart ? 1 : -1;
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

// A same-day retry is deliberately manual (`--force`). The read path must never
// turn a cached version number into an execution trigger: failed sync attempts
// would otherwise repeat every time memory is read.

export function defaultStatePath(home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  return path.join(path.resolve(home), 'omni-daily-sync.json');
}
