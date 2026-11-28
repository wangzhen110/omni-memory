// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Retrieval regression gate.
 *
 * `npm run check` used to verify that the code still parses; it could not tell
 * whether recall had quietly regressed. This runs the public LoCoMo harness on
 * a fixed-seed 500-question subset at both granularities and fails the build
 * when retrieval drops below the thresholds recorded in docs/BENCHMARKS.md §6.3
 * (rules live in scripts/retrieval-gate-lib.mjs so they can be unit-tested):
 *
 *   session recall@10 >= 0.70   session nDCG@10 >= 0.55   turn recall@10 >= 0.40
 *
 * The subset is deterministic (seeded stratified sample), so a green gate means
 * the same corpus produced the same quality, not a lucky sample. Full-dataset
 * numbers are published separately in docs/BENCHMARKS.md.
 *
 * Usage:
 *   node scripts/check-retrieval-gate.mjs [--limit 500] [--k 10]
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { evaluateGate } from './retrieval-gate-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATASET = path.join(ROOT, 'bench', 'data', 'locomo10.json');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const LIMIT = Number(option('--limit', 500));
const K = Number(option('--k', 10));

// The LoCoMo corpus is fetched, not vendored (bench/data/.gitignore), so a
// fresh clone has nothing to measure. Say so and pass; never pretend a skipped
// run is a green gate.
if (!existsSync(DATASET) || process.env.OMNI_RETRIEVAL_GATE_OFF === '1') {
  console.log('retrieval-gate SKIP (run `npm run bench:public:fetch` to enable)');
  process.exit(0);
}

function run(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'public-retrieval.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const tail = String(result.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`benchmark failed (${args.join(' ')}):\n${tail}`);
  }
  // The harness prints one JSON document (pretty-printed, so more than one line).
  try {
    return JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    throw new Error(`benchmark did not print JSON: ${String(result.stdout).slice(0, 200)}`);
  }
}

// Session granularity: whole sessions as notes, the number the README quotes
// for "can I find the conversation".
const session = run(['--granularity', 'session', '--k', String(K), '--limit', String(LIMIT)]);
// Turn granularity: one note per dialogue turn with a two-turn context window
// plus family boost. This is the hard number: the answer turn itself must rank.
const turn = run(['--granularity', 'turn', '--ctx', '2', '--expand', '--k', String(K), '--limit', String(LIMIT)]);

const verdict = evaluateGate({ session, turn }, K);
for (const line of verdict.lines) console.log(`retrieval-gate ${line}`);

if (!verdict.ok) {
  console.error('retrieval-gate FAILED');
  for (const failure of verdict.failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('retrieval-gate OK');
