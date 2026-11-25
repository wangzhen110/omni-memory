import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const cli = path.join(repo, 'hosts', 'cli.mjs');
const KEY = 'proj:全息记忆#30534c';

function run(args, env = {}, cwd = repo) {
  const base = { ...process.env };
  delete base.OMNI_PROJECT_DIR;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env, OMNI_VERSION_CHECK_DISABLED: '1' },
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function runRaw(args, env = {}, cwd = repo) {
  const base = { ...process.env };
  delete base.OMNI_PROJECT_DIR;
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env, OMNI_VERSION_CHECK_DISABLED: '1' },
    timeout: 30_000,
  });
}

test('CLI defaults to the checkout project when cwd has no identity file', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cli-home-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'omni-cli-outside-'));
  const env = { OMNI_HOME: home, DSH_HOME: home };

  const shown = JSON.parse(run(['project', 'show'], env, outside));
  assert.equal(shown.key, KEY, 'default CLI cwd must not become proj:<chat-folder>');
  assert.equal(shown.identity.source, 'file');
});

test('CLI search reports bad arguments as one line and exits 2', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cli-home-'));
  const env = { OMNI_HOME: home, DSH_HOME: home };
  const result = runRaw(['search', 'CLI 参数错误', '--limit', '99'], env);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /limit must be a number between 1 and 30/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'a stack trace is not an actionable CLI error');
});

test('CLI project show reads .omni-project and write --dir binds to that layer', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-cli-home-'));
  const project = mkdtempSync(path.join(tmpdir(), 'omni-cli-project-'));
  mkdirSync(path.join(home, 'memory'), { recursive: true });
  writeFileSync(path.join(project, '.omni-project'), JSON.stringify({ key: KEY, name: '全息记忆' }));
  const env = { OMNI_HOME: home, DSH_HOME: home };

  const shown = JSON.parse(run(['project', 'show', '--dir', project], env));
  assert.equal(shown.key, KEY);
  assert.equal(shown.identity.source, 'file');

  const written = JSON.parse(run([
    'write', '--dir', project, '--kind', 'note',
    '--text', 'CLI 作用域测试：这条笔记提到偏好和所有项目，但仍然属于项目层。',
    '--source', 'test:cli-scope',
  ], env));
  assert.equal(written.scope, KEY, '--dir must bind the write to the project layer');

  const searched = JSON.parse(run(['search', 'CLI 作用域测试', '--dir', project, '--json'], env));
  assert.equal(searched.scope, KEY);
  assert.equal(searched.total, 1);
  assert.equal(searched.hits[0].scope, KEY);

  const feedback = JSON.parse(run([
    'feedback', '--kind', 'note', '--id', String(written.id), '--rating', 'useful', '--dir', project,
  ], env));
  assert.equal(feedback.usefulCount, 1);
  assert.equal(feedback.feedbackCount, 1);
});
