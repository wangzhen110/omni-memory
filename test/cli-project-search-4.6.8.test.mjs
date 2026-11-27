// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * 4.6.7 重测报告 §3 P0-2：`hosts/cli.mjs` 行覆盖 61.31%，缺口集中在 project 的
 * search / context / impact / sync 与 init 无法解析键的分支。这些命令都跑真实
 * CLI + 临时库，断言输出而不是只断言退出码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const nodeBin = process.execPath;
const cli = path.resolve('hosts/cli.mjs');

function sandbox(files = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cli468-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-proj468-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
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
    env: { ...box.env, ...(options.env ?? {}) },
    cwd: options.cwd ?? box.dir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const SOURCE = {
  'a.mjs': "import { helper } from './b.mjs';\nexport function alpha(input) {\n  return helper(input) + 1;\n}\n",
  'b.mjs': "export function helper(value) {\n  return value * 2;\n}\nexport const limit = 10;\n",
};

test('project index/search/context/impact: a real indexed project answers all four', () => {
  const box = sandbox(SOURCE);
  const indexed = run(box, ['index', '--json']);
  assert.equal(indexed.code, 0, indexed.err);
  const report = JSON.parse(indexed.out.trim());
  assert.ok(report.files >= 2, `expected at least 2 files, got ${report.files}`);
  assert.ok(report.symbols >= 2, 'function declarations must be indexed');
  assert.match(report.scope, /^proj:/);

  const search = run(box, ['project', 'search', 'helper', '--json']);
  assert.equal(search.code, 0, search.err);
  const hit = JSON.parse(search.out.trim());
  assert.ok(Array.isArray(hit.symbols) || Array.isArray(hit.modules) || Array.isArray(hit.files),
    'search must return at least one collection');

  const context = run(box, ['project', 'context', 'b.mjs']);
  assert.equal(context.code, 0, context.err);
  assert.match(context.out, /helper/);

  const impact = run(box, ['project', 'impact', 'b.mjs', '--json']);
  assert.equal(impact.code, 0, impact.err);
  const impactValue = JSON.parse(impact.out.trim());
  assert.ok(Array.isArray(impactValue.importers));
  assert.ok(impactValue.importers.some(item => /a\.mjs/.test(item)), 'a.mjs imports b.mjs');
});

test('project sync: rebuilds through the same path as index', () => {
  const box = sandbox(SOURCE);
  const sync = run(box, ['project', 'sync', '--json']);
  assert.equal(sync.code, 0, sync.err);
  const report = JSON.parse(sync.out.trim());
  assert.ok(report.files >= 2);
});

test('project init: an unwritable target (drive root) exits 2 instead of crashing', () => {
  const box = sandbox();
  const result = run(box, ['project', 'init'], { env: { OMNI_PROJECT_DIR: 'C:\\' } });
  assert.equal(result.code, 2, `expected a usage error, got ${result.code}: ${result.out}`);
  assert.match(result.err, /无法写入/);
});

test('project status: reports counts for the indexed scope', () => {
  const box = sandbox(SOURCE);
  run(box, ['index']);
  const status = run(box, ['project', 'status']);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /files/);
  assert.match(status.out, /symbols/);
});


test('context: query, stdin hook payload, and --json all answer without a store', () => {
  const box = sandbox();
  const query = run(box, ['context', '--query', '完全不存在的查询词']);
  assert.equal(query.code, 0, query.err);
  assert.match(query.out, /长期记忆|未命中|没有/);

  const json = run(box, ['context', '--query', '完全不存在的查询词', '--json']);
  assert.equal(json.code, 0, json.err);
  const parsed = JSON.parse(json.out.trim());
  assert.equal(typeof parsed.text, 'string', '--json must return the tool value, not prose');

  const stdin = spawnSync(nodeBin, [cli, 'context', '--stdin'], {
    env: box.env,
    cwd: box.dir,
    input: JSON.stringify({ prompt: 'hook 输入' }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.match(stdin.stdout, /长期记忆|未命中|没有/);
});

test('context: an empty query still answers instead of failing', () => {
  const box = sandbox();
  const result = run(box, ['context']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /长期记忆|未命中|没有/);
});


test('write/search/ingest/candidates: the core CLI path works end to end', () => {
  const box = sandbox();
  const written = run(box, ['write', '--text', '先跑 verify 再发版', '--importance', '0.8']);
  assert.equal(written.code, 0, written.err);
  const note = JSON.parse(written.out.trim());
  assert.equal(note.kind, 'note');
  assert.match(note.scope, /^proj:/);

  const search = run(box, ['search', 'verify', '--json']);
  assert.equal(search.code, 0, search.err);
  const found = JSON.parse(search.out.trim());
  assert.equal(found.total, 1, 'the note just written must be searchable');
  assert.ok(found.returned >= 1);

  const ingested = run(box, ['ingest', '--text', '用户说：以后都先跑测试']);
  assert.equal(ingested.code, 0, ingested.err);
  const chunk = JSON.parse(ingested.out.trim());
  assert.ok(chunk.candidates.length >= 1, 'ingest must extract at least one candidate');

  const candidates = run(box, ['candidates']);
  assert.equal(candidates.code, 0, candidates.err);
  const list = JSON.parse(candidates.out.trim());
  assert.equal(list.action, 'list');
  assert.ok(list.total >= 1);
  assert.equal(list.candidates[0].status, 'pending');
});
