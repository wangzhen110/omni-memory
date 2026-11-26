#!/usr/bin/env node
/**
 * TAP truth gate.
 *
 * `check-docs` can only count `test(` declarations; it cannot tell whether they
 * actually ran, passed, or timed out. `npm test` writes a TAP stream next to the
 * human spec output, and this script refuses to ship unless the run really
 * passed every test it started.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const file = path.resolve(root, process.argv[2] || '.test-results.tap');

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`test results missing: ${path.relative(root, file)} (run \`npm test\` first)`);
  process.exit(1);
}

function count(label) {
  const matches = [...text.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  if (matches.length > 1) {
    console.error(`TAP summary repeats # ${label}; refusing to trust a concatenated summary`);
    process.exit(1);
  }
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

const tests = count('tests');
const pass = count('pass');
const fail = count('fail');
const cancelled = count('cancelled');
const skipped = count('skipped') ?? 0;
const todo = count('todo') ?? 0;

if (tests === null || pass === null || fail === null || cancelled === null) {
  console.error('TAP summary is incomplete: expected # tests / # pass / # fail / # cancelled');
  process.exit(1);
}
if (tests === 0) {
  console.error('TAP summary reports zero tests');
  process.exit(1);
}
const plans = [...text.matchAll(/^1\.\.(\d+)$/gm)];
if (plans.length !== 1) {
  console.error(`TAP must contain exactly one plan line; found ${plans.length}`);
  process.exit(1);
}
if (Number(plans[0][1]) !== tests) {
  console.error(`TAP plan 1..${plans[0][1]} does not match # tests ${tests}`);
  process.exit(1);
}
if (fail !== 0) {
  console.error(`TAP reports ${fail} failing test(s); refusing to ship`);
  process.exit(1);
}
if (cancelled !== 0) {
  console.error(`TAP reports ${cancelled} cancelled test(s); refusing to ship`);
  process.exit(1);
}
if (pass + skipped + todo !== tests) {
  console.error(`TAP counts do not add up: pass ${pass} + skipped ${skipped} + todo ${todo} != tests ${tests}`);
  process.exit(1);
}

console.log(`ok   TAP truth gate: ${pass} passed, ${skipped} skipped, 0 failed (${tests} total)`);
