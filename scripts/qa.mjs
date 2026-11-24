#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Public QA harness.
 *
 * Runs the two reproducible, network-free checks a stranger can run after a
 * clone: the golden retrieval set and the synthetic quality suite. Both are
 * self-contained SQLite runs; no model, no API key, no real memory database.
 *
 * Usage: node scripts/qa.mjs [--quality-count 120] [--json]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const countAt = argv.indexOf('--quality-count');
const qualityCount = countAt >= 0 ? Number(argv[countAt + 1] || 120) : 120;

function run(name, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const elapsedMs = Date.now() - started;
  if (result.status !== 0) {
    return {
      name,
      ok: false,
      elapsedMs,
      status: result.status,
      stdout: result.stdout ? result.stdout.slice(-4000) : '',
      stderr: result.stderr ? result.stderr.slice(-4000) : '',
    };
  }
  return { name, ok: true, elapsedMs, status: 0 };
}

const checks = [
  run('golden-retrieval', ['bench/golden.mjs']),
  run('quality-suite', ['bench/quality.mjs', String(qualityCount)]),
];
const ok = checks.every(check => check.ok);
if (json) {
  console.log(JSON.stringify({ ok, qualityCount, checks }, null, 2));
} else if (ok) {
  console.log('QA PASS');
  for (const check of checks) console.log(`  ${check.name}: ${check.elapsedMs} ms`);
} else {
  console.log('QA FAIL');
  for (const check of checks) {
    console.log(`  ${check.name}: ${check.ok ? 'ok' : `exit ${check.status}`}`);
    if (check.stderr) console.log(check.stderr);
  }
}
process.exitCode = ok ? 0 : 1;
