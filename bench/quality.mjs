// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Run the deterministic memory-quality suite and print a JSON report.
 *
 * Usage: node bench/quality.mjs [count]
 * Count is rounded to the nearest multiple of 4, minimum 4.
 */
import { readFileSync } from 'node:fs';
import { boot } from '../test/helpers.mjs';
import { runQualitySuite } from './quality-lib.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const requested = Number(process.argv[2] ?? 120);
const count = Math.max(4, Math.round(requested / 4) * 4);
const app = await boot();
await app.call('memory_profile');
const result = await runQualitySuite(app, { count });

console.log(JSON.stringify({
  version: pkg.version,
  suite: 'memory-quality',
  ...result,
}, null, 2));

if (result.failed > 0) process.exitCode = 1;
