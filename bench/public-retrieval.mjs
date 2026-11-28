// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * LoCoMo retrieval harness.
 *
 * This measures retrieval, not end-to-end QA. Each dialogue turn is written as
 * one note whose source is `locomo:<sample>:<dia_id>`; a question is scored by
 * whether the evidence turns appear in the top-k search results. It deliberately
 * does not claim an official LoCoMo QA score: that requires an answer generator
 * and the official judge, which `locomo-qa.mjs` covers separately.
 *
 * Usage:
 *   node bench/fetch-public.mjs
 *   node bench/public-retrieval.mjs [--limit 200] [--k 10] [--data path]
 *     [--granularity turn] [--ctx 2] [--expand] [--semantic] [--dump out.json]
 *
 * Canonical turn-granularity run (the one the release gate uses):
 *   node bench/public-retrieval.mjs --granularity turn --ctx 2 --expand
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';
import { DEFAULT_DATA, allQuestions, datasetSha256, readDataset, subsetQuestions, writeCorpus } from './locomo-lib.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dataPath = path.resolve(option('--data', DEFAULT_DATA));
const limit = Math.max(0, Number(option('--limit', 0)));
const K = Math.max(1, Number(option('--k', 10)));
const granularity = option('--granularity', 'session') === 'turn' ? 'turn' : 'session';
const expand = process.argv.includes('--expand');
const contextWindow = granularity === 'turn' ? Math.max(0, Math.min(2, Number(option('--ctx', 0)))) : 0;
const data = readDataset(dataPath);
const semantic = process.argv.includes('--semantic');
const app = await boot({ semantic });
await app.call('memory_profile');

const written = await writeCorpus(app, data, { granularity, contextWindow });
const { turns, notes } = written;

if (semantic) {
  await app.call('memory_reindex', { semantic: true, limit: notes });
}

const questions = subsetQuestions(allQuestions(data, { granularity }), { size: limit });
const perCategory = new Map();
const samples = [];
const dumpPath = option('--dump', '');
const diagnostics = dumpPath ? [] : null;

function ncdgAtK(hits, relevant, k) {
  const dcg = hits.slice(0, k).reduce((sum, hit, index) => sum + (relevant.has(hit) ? 1 : 0) / Math.log2(index + 2), 0);
  const idealHits = Math.min(k, relevant.size);
  const ideal = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return ideal ? dcg / ideal : 0;
}

const started = performance.now();
for (const item of questions) {
  const result = await app.call('memory_search', { query: item.question, limit: K, scope: item.scope, ...(expand ? { expand: true } : {}) });
  const hitSources = (result.value?.hits ?? [])
    .filter(hit => hit.kind === 'note' && String(hit.source ?? '').startsWith('locomo:'))
    .map(hit => granularity === 'session'
      ? String(hit.source).replace(/:part\d+$/, '')
      : String(hit.source));
  const relevant = new Set(item.sources);
  const found = new Set(hitSources.filter(source => relevant.has(source)));
  const recall = found.size / relevant.size;
  const any = found.size > 0 ? 1 : 0;
  const ndcg = ncdgAtK(hitSources, relevant, K);
  samples.push({ category: item.category, recall, any, ndcg });
  if (diagnostics) {
    diagnostics.push({
      question: item.question,
      category: item.category,
      evidence: item.sources,
      hits: hitSources,
      recall,
    });
  }

  const bucket = perCategory.get(item.category) ?? { count: 0, recall: 0, any: 0, ndcg: 0 };
  bucket.count += 1;
  bucket.recall += recall;
  bucket.any += any;
  bucket.ndcg += ndcg;
  perCategory.set(item.category, bucket);
}

const average = key => Number((samples.reduce((sum, row) => sum + row[key], 0) / samples.length).toFixed(4));
const reportByCategory = Object.fromEntries([...perCategory.entries()].map(([category, bucket]) => [
  category,
  {
    questions: bucket.count,
    evidenceRecall: Number((bucket.recall / bucket.count).toFixed(4)),
    anyEvidenceRecall: Number((bucket.any / bucket.count).toFixed(4)),
    ndcg: Number((bucket.ndcg / bucket.count).toFixed(4)),
  },
]));

if (dumpPath && diagnostics) writeFileSync(path.resolve(dumpPath), JSON.stringify(diagnostics, null, 2));

console.log(JSON.stringify({
  dataset: 'LoCoMo',
  dataPath,
  dataSha256: datasetSha256(dataPath),
  samples: data.length,
  turns,
  notes,
  granularity,
  expand,
  contextWindow,
  questions: questions.length,
  limit: limit || null,
  k: K,
  mode: 'retrieval-only',
  metrics: {
    evidenceRecall: average('recall'),
    anyEvidenceRecall: average('any'),
    ndcg: average('ndcg'),
  },
  byCategory: reportByCategory,
  elapsedMs: Number((performance.now() - started).toFixed(1)),
  // Emitted by the script itself so archived runs never carry hand-added
  // timestamps (review A-07): the value is the moment this JSON was produced.
  capturedAt: new Date().toISOString(),
}, null, 2));
