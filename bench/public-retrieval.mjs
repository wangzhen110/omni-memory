// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * LoCoMo retrieval harness.
 *
 * This measures retrieval, not end-to-end QA. Each dialogue turn is written as
 * one note whose source is `locomo:<sample>:<dia_id>`; a question is scored by
 * whether the evidence turns appear in the top-k search results. It deliberately
 * does not claim an official LoCoMo QA score: that requires an answer generator
 * and the official judge, which are outside the local-only path.
 *
 * Usage:
 *   node bench/fetch-public.mjs
 *   node bench/public-retrieval.mjs [--limit 200] [--k 10] [--data path]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';

const DEFAULT_DATA = path.resolve(import.meta.dirname, 'data', 'locomo10.json');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dataPath = path.resolve(option('--data', DEFAULT_DATA));
const limit = Math.max(0, Number(option('--limit', 0)));
const K = Math.max(1, Number(option('--k', 10)));
const granularity = option('--granularity', 'session') === 'turn' ? 'turn' : 'session';
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
if (!Array.isArray(data) || !data.length) throw new Error(`not a LoCoMo array: ${dataPath}`);

const app = await boot({ semantic: process.argv.includes('--semantic') });
await app.call('memory_profile');

let turns = 0;
let notes = 0;
for (const sample of data) {
  const sampleId = String(sample.sample_id ?? 'unknown');
  const scope = `proj:locomo#${sampleId}`;
  const conversation = sample.conversation;
  const sessionKeys = Object.keys(conversation)
    .filter(key => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  for (const sessionKey of sessionKeys) {
    const date = String(conversation[`${sessionKey}_date_time`] ?? '');
    const sessionRows = conversation[sessionKey] ?? [];
    if (granularity === 'session') {
      const text = sessionRows
        .filter(turn => turn?.text)
        .map(turn => `${turn.speaker ?? ''}: ${turn.text}`)
        .join(' ');
      if (!text) continue;
      const baseSource = `locomo:${sampleId}:${sessionKey}`;
      const chunkSize = 3500;
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        const chunk = text.slice(offset, offset + chunkSize);
        await app.call('memory_write', {
          kind: 'note',
          scope,
          text: `[${sessionKey}]${date ? ` ${date}` : ''} ${chunk}`,
          source: `${baseSource}:part${Math.floor(offset / chunkSize) + 1}`,
        });
        notes += 1;
      }
      turns += sessionRows.length;
    } else {
      for (const turn of sessionRows) {
        if (!turn?.text || !turn?.dia_id) continue;
        const dia = String(turn.dia_id);
        await app.call('memory_write', {
          kind: 'note',
          scope,
          text: `[${dia}]${date ? ` ${date}` : ''} ${turn.speaker ?? ''}: ${turn.text}`,
          source: `locomo:${sampleId}:${dia}`,
        });
        notes += 1;
        turns += 1;
      }
    }
  }
}

if (process.argv.includes('--semantic')) {
  await app.call('memory_reindex', { semantic: true, limit: notes });
}

function evidenceSources(sampleId, evidence) {  if (granularity === 'session') {
    return evidence.map(dia => {
      const session = /^D(\d+):/.exec(dia)?.[1];
      return session ? `locomo:${sampleId}:session_${session}` : null;
    }).filter(Boolean);
  }
  return evidence.map(dia => `locomo:${sampleId}:${dia}`);
}

function sampleQuestions() {
  const rows = [];
  for (const sample of data) {
    const sampleId = String(sample.sample_id ?? 'unknown');
    const scope = `proj:locomo#${sampleId}`;
    for (const qa of sample.qa ?? []) {
      const evidence = [...new Set((qa.evidence ?? []).map(String))];
      if (!qa.question || !evidence.length) continue;
      rows.push({
        sampleId,
        scope,
        question: String(qa.question),
        category: String(qa.category ?? 'unknown'),
        evidence: evidenceSources(sampleId, evidence),
      });
    }
  }
  if (!limit || limit >= rows.length) return rows;
  const stride = rows.length / limit;
  return Array.from({ length: limit }, (_, index) => rows[Math.floor(index * stride)]);
}

const questions = sampleQuestions();
const perCategory = new Map();
const samples = [];

function ncdgAtK(hits, relevant, k) {
  const dcg = hits.slice(0, k).reduce((sum, hit, index) => sum + (relevant.has(hit) ? 1 : 0) / Math.log2(index + 2), 0);
  const idealHits = Math.min(k, relevant.size);
  const ideal = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return ideal ? dcg / ideal : 0;
}

const started = performance.now();
for (const item of questions) {
  const result = await app.call('memory_search', { query: item.question, limit: K, scope: item.scope });
  const hitSources = (result.value?.hits ?? [])
    .filter(hit => hit.kind === 'note' && String(hit.source ?? '').startsWith('locomo:'))
    .map(hit => granularity === 'session'
      ? String(hit.source).replace(/:part\d+$/, '')
      : String(hit.source));
  const relevant = new Set(item.evidence);
  const found = new Set(hitSources.filter(source => relevant.has(source)));
  const recall = found.size / relevant.size;
  const any = found.size > 0 ? 1 : 0;
  const ndcg = ncdgAtK(hitSources, relevant, K);
  samples.push({ category: item.category, recall, any, ndcg });

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

console.log(JSON.stringify({
  dataset: 'LoCoMo',
  dataPath,
  dataSha256: createHash('sha256').update(readFileSync(dataPath)).digest('hex'),
  samples: data.length,
  turns,
  notes,
  granularity,
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
