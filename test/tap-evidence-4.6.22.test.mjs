import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 4.6.22: the archived evidence must carry the TAP's own bytes hash, and the
// commit label plus its provenance must come from the generation call instead
// of being hand-edited after the push channel rewrites the SHA.
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'tap-evidence.mjs');

const fixture = [
  '1..2',
  'ok 1 - first',
  'ok 2 - second',
  '# tests 2',
  '# pass 2',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 12.345',
  '# 10k rows: seed=1ms p95=2ms max=3ms hitTotal=2 total=4ms',
  '# 1000-file cold 5ms · warm 4ms · budget 2000ms',
  '',
].join('\n');

const run = (args, env) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'omni-tapev-'));
  const tap = path.join(dir, 'fixture.tap');
  const out = path.join(dir, 'evidence.json');
  writeFileSync(tap, fixture);
  execFileSync(process.execPath, [script, '--tap', tap, '--out', out, ...args], { cwd: root, stdio: 'pipe', env: env ?? process.env });
  return JSON.parse(readFileSync(out, 'utf8'));
};

test('tap-evidence records the TAP byte hash so the archive can be re-verified', () => {
  const evidence = run([]);
  assert.equal(evidence.tapSha256, createHash('sha256').update(Buffer.from(fixture)).digest('hex'));
  assert.equal(evidence.tapBytes, Buffer.byteLength(fixture));
  assert.equal(evidence.summary.tests, 2);
});

test('tap-evidence defaults the commit label to the current HEAD and says so', () => {
  const evidence = run([]);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(evidence.commitSha, head);
  assert.equal(evidence.commitShaSource, 'git rev-parse HEAD');
  assert.match(evidence.commitSha, /^[0-9a-f]{40}$/);
});

test('tap-evidence accepts an explicit commit source instead of post-editing the file', () => {
  const evidence = run(['--commit', 'c7da8cfb56019e1eec8ab2d67e8210c8212d58b2', '--commit-source', 'flag (remote sha after push)']);
  assert.equal(evidence.commitSha, 'c7da8cfb56019e1eec8ab2d67e8210c8212d58b2');
  assert.equal(evidence.commitShaSource, 'flag (remote sha after push)');
});

test('tap-evidence keeps the plain flag when only --commit is given', () => {
  const evidence = run(['--commit', 'deadbeef']);
  assert.equal(evidence.commitSha, 'deadbeef');
  assert.equal(evidence.commitShaSource, 'flag');
});

test('tap-evidence records an unresolved commit instead of inventing a SHA', () => {
  // 4.6.22 复核 P2-2: the third value of commitShaSource was never asserted, so
  // renaming 'unresolved' to anything else stayed green. Trigger this branch by
  // hiding git from PATH, which is the real shape of a packaged/tarball run.
  const evidence = run([], { ...process.env, PATH: '' });
  assert.equal(evidence.commitSha, null);
  assert.equal(evidence.commitShaSource, 'unresolved');
});
