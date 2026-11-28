#!/usr/bin/env node
/**
 * Archive the measurements a release report is allowed to quote.
 *
 * Reports used to copy numbers from a different terminal run than the TAP
 * file on disk. This script turns `.test-results.tap` into a small tracked
 * JSON, and `check-docs` refuses a completion report that does not quote its
 * exact lines.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const tapPath = path.resolve(root, arg('--tap') || '.test-results.tap');
const outPath = path.resolve(root, arg('--out') || `docs/evidence/${JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version}.json`);
const text = readFileSync(tapPath, 'utf8');

const value = label => {
  const matches = [...text.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`TAP has ${matches.length} # ${label} lines`);
  return Number(matches[0][1]);
};
const line = pattern => {
  const match = text.match(pattern);
  return match ? match[0] : null;
};

const tests = value('tests');
const pass = value('pass');
const fail = value('fail');
const cancelled = value('cancelled');
const skipped = value('skipped') ?? 0;
const todo = value('todo') ?? 0;
const durationLine = line(/^# duration_ms [\d.]+$/m);
const planLine = line(/^1\.\.(\d+)$/m);
if (!durationLine) throw new Error('TAP has no # duration_ms line');
if (!planLine || Number(planLine.slice(3)) !== tests) throw new Error('TAP plan does not match # tests');

// Which commit this TAP belongs to. mtime comparisons were the only binding
// before 4.6.21 and they break the moment a docs commit lands after the run.
const commitSha = (() => {
  const explicit = arg('--commit');
  if (explicit) return explicit.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

const evidence = {
  version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  tap: path.relative(root, tapPath).replaceAll('\\', '/'),
  commitSha,
  commitShaSource: commitSha ? (arg('--commit') ? 'flag' : 'git rev-parse HEAD') : 'unresolved',
  capturedAt: statSync(tapPath).mtime.toISOString(),
  summary: { tests, pass, fail, cancelled, skipped, todo },
  summaryLine: `${tests} tests / ${pass} pass / ${fail} fail / ${cancelled} cancelled / ${skipped} skipped`,
  summaryLineNote: 'derived from the # tests/# pass/# fail/# cancelled/# skipped lines; not a literal TAP line',
  durationLine,
  adrLines: [...text.matchAll(/^# (?:10k|100k) rows:.*$/gm)].map(match => match[0]),
  indexLine: line(/^# 1000-file .*$/m),
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, out: outPath, commitSha, summaryLine: evidence.summaryLine, durationLine: evidence.durationLine, adrLines: evidence.adrLines, indexLine: evidence.indexLine }, null, 2));
