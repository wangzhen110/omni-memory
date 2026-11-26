// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * P0-4 / P0-5: the two CLI families the review found untested.
 *
 * Both mutate real user state: `project link --apply` migrates a scope and
 * rewrites aliases, and `rules --write` edits a file in the working directory.
 * Every test runs the real CLI as a child process against a throwaway HOME and
 * project directory, then reads the resulting database or file directly instead
 * of trusting the printed summary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const nodeBin = process.execPath;
const cli = path.resolve('hosts/cli.mjs');

function sandbox() {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cli-467-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-proj-467-'));
  const env = {
    ...process.env,
    OMNI_HOME: home,
    DSH_HOME: home,
    OMNI_PROJECT_DIR: dir,
    OMNI_DISABLE_SEMANTIC: '1',
    OMNI_AUTO_RECALL: '0',
  };
  return { home, dir, env };
}

function run(box, args, options = {}) {
  const result = spawnSync(nodeBin, [cli, ...args], {
    env: box.env,
    cwd: options.cwd ?? box.dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

function countRows(home, sql, params = []) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/* ----------------------------- project family ----------------------------- */

test('project show: prints a resolved key without touching the database', () => {
  const box = sandbox();
  const first = run(box, ['project', 'show']);
  assert.equal(first.code, 0, first.err);
  const parsed = JSON.parse(first.out.trim());
  assert.match(parsed.key, /^proj:[^#\s]+#[a-z0-9]{6,}$/i);
  assert.ok(parsed.pathFallback, 'no identity file still yields a legacy path key');
  assert.equal(parsed.identity, null);
});

test('project init: creates .omni-project, refuses to clobber, --force rewrites', () => {
  const box = sandbox();
  const file = path.join(box.dir, '.omni-project');
  const created = run(box, ['project', 'init']);
  assert.equal(created.code, 0, created.err);
  const payload = JSON.parse(created.out.trim());
  assert.equal(payload.created, true);
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, payload.key);

  const again = run(box, ['project', 'init']);
  assert.equal(again.code, 0, again.err);
  assert.equal(JSON.parse(again.out.trim()).created, false, 'init is idempotent without --force');

  const forced = run(box, ['project', 'init', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(JSON.parse(forced.out.trim()).created, true);
});

test('project link: rejects non-project scopes and self-links before booting', () => {
  const box = sandbox();
  const bad = run(box, ['project', 'link', '--from', 'global', '--to', 'proj:x#abc123']);
  assert.equal(bad.code, 2, 'global must never be merged');
  assert.match(bad.err, /必须是 proj:/);

  const self = run(box, ['project', 'link', '--from', 'proj:x#abc123', '--to', 'proj:x#abc123']);
  assert.equal(self.code, 0);
  assert.match(self.err, /相同/);
});

test('project link: preview writes nothing, --apply migrates rows and records the alias', () => {
  const box = sandbox();
  const from = 'proj:from#aaaa11';
  const to = 'proj:to#bbbb22';
  const written = run(box, ['write', '--text', '迁移样本', '--scope', from]);
  assert.equal(written.code, 0, written.err);

  const before = countRows(box.home, 'SELECT scope, COUNT(*) AS n FROM notes GROUP BY scope');
  assert.ok(before.some(row => row.scope === from && row.n === 1), 'seed note must live in the from scope');

  const preview = run(box, ['project', 'link', '--from', from, '--to', to]);
  assert.equal(preview.code, 0, preview.err);
  const previewPayload = JSON.parse(preview.out.trim());
  assert.equal(previewPayload.applied, false);
  assert.equal(previewPayload.fromHasRows, true);
  assert.match(previewPayload.hint, /--apply/);
  const afterPreview = countRows(box.home, 'SELECT scope, COUNT(*) AS n FROM notes GROUP BY scope');
  assert.deepEqual(afterPreview, before, 'a preview must not change a single row');

  const applied = run(box, ['project', 'link', '--from', from, '--to', to, '--apply']);
  assert.equal(applied.code, 0, applied.err);
  const appliedPayload = JSON.parse(applied.out.trim());
  assert.equal(appliedPayload.applied, true);

  const after = countRows(box.home, 'SELECT scope, COUNT(*) AS n FROM notes GROUP BY scope');
  assert.equal(after.some(row => row.scope === from), false, 'the from scope must be empty afterwards');
  assert.ok(after.some(row => row.scope === to && row.n === 1), 'the row must now live in the to scope');
  const alias = countRows(box.home, 'SELECT alias, canonical FROM scope_aliases');
  assert.ok(alias.some(row => row.alias === from && row.canonical === to), 'the alias must be recorded');
});

test('project context/impact: a missing reference is a usage error, not a crash', () => {
  const box = sandbox();
  const context = run(box, ['project', 'context']);
  assert.equal(context.code, 2);
  assert.match(context.err, /缺少引用/);

  const impact = run(box, ['project', 'impact']);
  assert.equal(impact.code, 2);
  assert.match(impact.err, /缺少引用/);
});

test('project: an unknown action exits 2 with the list of real ones', () => {
  const box = sandbox();
  const result = run(box, ['project', 'nonsense']);
  assert.equal(result.code, 2);
  assert.match(result.err, /未知 project 动作/);
});

/* ------------------------------- rules ----------------------------------- */

test('rules: no file and no --create prints the text and writes nothing', () => {
  const box = sandbox();
  const result = run(box, ['rules']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /全息记忆使用规则/);
  assert.equal(existsSync(path.join(box.dir, 'AGENTS.md')), false);
  assert.match(result.err, /没有找到规则文件/);
});

test('rules --create --write creates AGENTS.md with one managed block', () => {
  const box = sandbox();
  const file = path.join(box.dir, 'AGENTS.md');
  const result = run(box, ['rules', '--create', '--write']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /已写入/);
  const text = readFileSync(file, 'utf8');
  assert.equal((text.match(/omni-memory:rules v\d+ start/g) ?? []).length, 1);
  assert.equal((text.match(/omni-memory:rules v\d+ end/g) ?? []).length, 1);

  const again = run(box, ['rules', '--file', 'AGENTS.md', '--write']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.err, /已是最新/);
  assert.equal(readFileSync(file, 'utf8'), text, 'a second write must be byte-identical');
});

test('rules: preview on an existing file changes nothing on disk', () => {
  const box = sandbox();
  const file = path.join(box.dir, 'AGENTS.md');
  writeFileSync(file, '# 项目约定\n\n手写内容保留。\n', 'utf8');
  const result = run(box, ['rules', '--file', 'AGENTS.md']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /手写内容保留/);
  assert.match(result.err, /预览结束/);
  assert.equal(readFileSync(file, 'utf8'), '# 项目约定\n\n手写内容保留。\n', 'preview must not write');
});

test('rules: a malformed marker is skipped instead of deleting prose', () => {
  const box = sandbox();
  const file = path.join(box.dir, 'AGENTS.md');
  const handwritten = '# 项目约定\n\n不可丢的正文。\n\n<!-- omni-memory:rules v1 start · 由全息记忆维护 -->\n';
  writeFileSync(file, handwritten, 'utf8');
  const result = run(box, ['rules', '--file', 'AGENTS.md', '--write']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /跳过/);
  assert.equal(readFileSync(file, 'utf8'), handwritten, 'an unpaired marker must fail closed');
});

