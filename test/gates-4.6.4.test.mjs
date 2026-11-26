import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { designTestHookMatches } from '../lib/design-contract.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'omni-gates-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function tapFile(body) {
  const file = path.join(dir, `tap-${seq++}.tap`);
  writeFileSync(file, body, 'utf8');
  return file;
}

function run(script, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const valid = (count = 3) => `TAP version 13
1..${count}
${Array.from({ length: count }, (_, i) => `ok ${i + 1} - case ${i + 1}`).join('\n')}
# tests ${count}
# pass ${count}
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1
`;

test('check-test-results accepts a complete TAP summary', () => {
  const result = run('check-test-results.mjs', [tapFile(valid())]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TAP truth gate: 3 passed/);
});

test('check-test-results rejects a repeated # tests summary', () => {
  const body = valid() + '\n# tests 3\n';
  const result = run('check-test-results.mjs', [tapFile(body)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repeats # tests/);
});

test('check-test-results rejects a plan that disagrees with # tests', () => {
  const body = valid(4).replace('1..4', '1..5');
  const result = run('check-test-results.mjs', [tapFile(body)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plan 1\.\.5 does not match # tests 4/);
});

test('check-test-results rejects multiple plan lines', () => {
  const body = valid() + '\n1..3\n';
  const result = run('check-test-results.mjs', [tapFile(body)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one plan line/);
});

test('check-docs refuses a TAP file with no # tests summary', () => {
  const body = valid().replace('# tests 3\n', '');
  const result = run('check-docs.mjs', ['--tap', tapFile(body)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /TAP summary is complete/);
  assert.match(result.stderr + result.stdout, /refusing to fall back/);
});

test('check-docs refuses a TAP run below the declared test count', () => {
  const result = run('check-docs.mjs', ['--tap', tapFile(valid(1))]);
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /TAP ran 1, but \d+ test declarations exist/);
});

test('check-docs refuses an explicit --tap path that does not exist', () => {
  const result = run('check-docs.mjs', ['--tap', path.join(dir, 'missing.tap')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TAP file missing:/);
});

test('DESIGN test hook contract rejects the old wording and accepts the current one', () => {
  assert.equal(designTestHookMatches('`NODE_TEST_CONTEXT` 存在时生效'), false);
  assert.equal(designTestHookMatches('`NODE_TEST_CONTEXT` 为 `child` / `child-vN` 时生效；这是防误设，不是抗篡改安全边界。'), true);
});
