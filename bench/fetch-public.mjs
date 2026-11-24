// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Download the public LoCoMo conversation set used by bench/public-retrieval.mjs.
 * It does not download LongMemEval: that dataset is much larger and its official
 * QA score needs an answer model and judge.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';
const SHA256 = '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4';
const target = path.resolve(import.meta.dirname, 'data', 'locomo10.json');

const response = await fetch(URL, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SHA256) throw new Error(`LoCoMo SHA-256 mismatch: ${digest}`);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, bytes);
console.log(JSON.stringify({ ok: true, target, bytes: bytes.length, sha256: digest }, null, 2));
