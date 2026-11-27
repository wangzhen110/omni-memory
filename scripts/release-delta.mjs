// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Release-install gate: may HEAD sit ahead of the signed release commit?
 *
 * `scripts/install.mjs` installs the launcher declared by the signed Release
 * manifest, so the checkout must be the signed commit — otherwise a stale or
 * unrelated tree could be paired with a signed binary. The one delta that is
 * safe to tolerate is documentation added after the release: it cannot change
 * the launcher, its hash, or the package hash. Everything else (src, tests,
 * config, scripts, workflows) still forces `git checkout <tag>`.
 *
 * The decision is computed with git, not with a path allowlist string, so a
 * rename out of `docs/` shows up as a non-doc path and is refused.
 */

export const DOCS_ROOT = 'docs/';

const REASONS = {
  same: 'head-is-release',
  missing: 'missing-commit',
  descendant: 'docs-only-descendant',
  notDescendant: 'not-a-descendant',
  empty: 'empty-diff',
  nonDocs: 'non-doc-change',
  gitFailure: 'git-failed',
};

/**
 * @param {(repo: string, args: string[]) => string} runGit  trimmed-stdout git runner
 * @param {string} repo
 * @param {string} base  signed release commit
 * @param {string} head  current HEAD
 * @returns {{allowed: boolean, reason: string, commits: number|null, files: string[]}}
 */
export function describeHeadDelta(runGit, repo, base, head) {
  if (!base || !head) return { allowed: false, reason: REASONS.missing, commits: null, files: [] };
  if (base.toLowerCase() === head.toLowerCase()) {
    return { allowed: true, reason: REASONS.same, commits: 0, files: [] };
  }
  let ahead;
  try {
    ahead = Number(runGit(repo, ['rev-list', '--count', `${base}..${head}`]));
  } catch {
    return { allowed: false, reason: REASONS.gitFailure, commits: null, files: [] };
  }
  if (!Number.isFinite(ahead) || ahead <= 0) {
    return { allowed: false, reason: REASONS.notDescendant, commits: null, files: [] };
  }
  try {
    runGit(repo, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    return { allowed: false, reason: REASONS.notDescendant, commits: ahead, files: [] };
  }
  let changed = '';
  try {
    changed = runGit(repo, ['diff', '--name-only', '--no-renames', base, head]);
  } catch {
    return { allowed: false, reason: REASONS.gitFailure, commits: ahead, files: [] };
  }
  const files = changed.split('\n').map(line => line.trim()).filter(Boolean);
  if (files.length === 0) return { allowed: false, reason: REASONS.empty, commits: ahead, files };
  const stray = files.filter(file => !file.startsWith(DOCS_ROOT));
  if (stray.length) {
    return { allowed: false, reason: REASONS.nonDocs, commits: ahead, files: stray };
  }
  return { allowed: true, reason: REASONS.descendant, commits: ahead, files };
}
