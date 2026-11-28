// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * LoCoMo end-to-end QA harness (answer layer).
 *
 * `public-retrieval.mjs` answers "did the right turn come back". This answers
 * "did the memory produce the right answer", which is the number people compare
 * against mem0 / Zep style tables. Two halves are pluggable:
 *
 *   generation  extractive (default, deterministic, no network) | llm (OpenAI-compatible)
 *   judging     rule (default, deterministic)                    | llm
 *
 * The local-only path (extractive + rule) is honest but not equivalent to the
 * official LoCoMo judge, and the JSON says so (`mode: 'local-qa'`). With an
 * endpoint configured (`OMNI_QA_API_KEY` + optional `OMNI_QA_BASE_URL`,
 * `OMNI_QA_MODEL`, `OMNI_QA_JUDGE_MODEL`) the same script runs the LLM path and
 * records the token bill in `tokenAccounting`.
 *
 * Usage:
 *   node bench/locomo-qa.mjs --limit 500 --seed 42 --out docs/evidence/locomo-qa-4.7.0.json
 *   node bench/locomo-qa.mjs --limit 500 --generator llm --judge llm   # needs a key
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { boot } from '../test/helpers.mjs';
import { DEFAULT_DATA, allQuestions, datasetSha256, extractiveAnswer, readDataset, ruleJudge, subsetQuestions, tokenF1, writeCorpus } from './locomo-lib.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dataPath = path.resolve(option('--data', DEFAULT_DATA));
const limit = Math.max(0, Number(option('--limit', 500)));
const seed = Number(option('--seed', 42));
const K = Math.max(1, Number(option('--k', 10)));
const generator = option('--generator', 'extractive');
const judge = option('--judge', 'rule');
const outPath = option('--out', '');
const contextWindow = Math.max(0, Math.min(2, Number(option('--ctx', 2))));

if (!['extractive', 'llm'].includes(generator)) throw new Error(`unknown --generator ${generator}`);
if (!['rule', 'llm'].includes(judge)) throw new Error(`unknown --judge ${judge}`);
if ((generator === 'llm' || judge === 'llm') && !process.env.OMNI_QA_API_KEY) {
  throw new Error('LLM generation/judging needs OMNI_QA_API_KEY (OpenAI-compatible endpoint)');
}

const QA_BASE_URL = String(process.env.OMNI_QA_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const QA_MODEL = String(process.env.OMNI_QA_MODEL ?? 'gpt-4o-mini');
const QA_JUDGE_MODEL = String(process.env.OMNI_QA_JUDGE_MODEL ?? QA_MODEL);
const tokenAccounting = { prompt: 0, completion: 0, total: 0, calls: 0 };

async function llmComplete(model, messages, { temperature = 0 } = {}) {
  const response = await fetch(`${QA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OMNI_QA_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!response.ok) throw new Error(`LLM ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  const usage = payload.usage ?? {};
  tokenAccounting.prompt += Number(usage.prompt_tokens ?? 0);
  tokenAccounting.completion += Number(usage.completion_tokens ?? 0);
  tokenAccounting.total += Number(usage.total_tokens ?? 0);
  tokenAccounting.calls += 1;
  return String(payload.choices?.[0]?.message?.content ?? '').trim();
}

async function llmAnswer(question, hits) {
  const memories = hits.slice(0, K).map((hit, index) => {
    const source = hit.source ? `[${hit.source}]` : '';
    return `${index + 1}. ${source} ${String(hit.text ?? hit.snippet ?? '').replace(/\s+/g, ' ').slice(0, 420)}`;
  }).join('\n');
  const reply = await llmComplete(QA_MODEL, [
    { role: 'system', content: 'You answer questions from retrieved memories only. Reply with a short answer (a few words), or 未知 if the memories do not contain it. Do not explain.' },
    { role: 'user', content: `Memories:\n${memories}\n\nQuestion: ${question}\nAnswer:` },
  ]);
  return reply.split('\n')[0].trim();
}

async function llmJudge(candidate, gold) {
  const reply = await llmComplete(QA_JUDGE_MODEL, [
    { role: 'system', content: 'Compare a candidate answer with the gold answer. They match if they state the same fact, even with different wording. Reply exactly YES or NO.' },
    { role: 'user', content: `Gold: ${gold}\nCandidate: ${candidate}` },
  ]);
  return { correct: /^\s*yes/i.test(reply), contained: false, f1: Number(tokenF1(candidate, gold).toFixed(4)) };
}

const data = readDataset(dataPath);
const app = await boot({ semantic: false });
await app.call('memory_profile');
const { turns, notes } = await writeCorpus(app, data, { granularity: 'turn', contextWindow });

const questions = subsetQuestions(allQuestions(data, { granularity: 'turn' }), { size: limit, seed });
const records = [];
const started = performance.now();

for (const item of questions) {
  const result = await app.call('memory_search', { query: item.question, limit: K, scope: item.scope, expand: true });
  const hits = (result.value?.hits ?? []).filter(hit => hit.kind === 'note' && String(hit.source ?? '').startsWith('locomo:'));
  const hitSources = hits.map(hit => String(hit.source));
  const evidenceFound = new Set(hitSources.filter(source => item.sources.includes(source)));
  const answer = generator === 'llm' ? await llmAnswer(item.question, hits) : extractiveAnswer(item.question, hits, K);
  const scored = !item.adversarial;
  let verdict = { correct: false, contained: false, f1: 0 };
  if (scored) verdict = judge === 'llm' ? await llmJudge(answer, item.answer) : ruleJudge(answer, item.answer);
  records.push({
    question: item.question,
    category: item.category,
    adversarial: item.adversarial,
    scored,
    gold: item.answer,
    answer,
    correct: verdict.correct,
    contained: verdict.contained,
    f1: verdict.f1,
    evidence: item.sources,
    hits: hitSources,
    evidenceRecall: Number((evidenceFound.size / item.sources.length).toFixed(4)),
  });
}

const scored = records.filter(row => row.scored);
const mean = key => Number((scored.reduce((sum, row) => sum + Number(row[key] ?? 0), 0) / Math.max(1, scored.length)).toFixed(4));
const perCategory = new Map();
for (const row of scored) {
  const bucket = perCategory.get(row.category) ?? { count: 0, correct: 0, f1: 0 };
  bucket.count += 1;
  bucket.correct += row.correct ? 1 : 0;
  bucket.f1 += row.f1;
  perCategory.set(row.category, bucket);
}
const failures = records.filter(row => row.scored && !row.correct).slice(0, 30).map(row => ({
  question: row.question,
  gold: row.gold,
  answer: row.answer,
  category: row.category,
  hits: row.hits.slice(0, 3),
}));

const report = {
  dataset: 'LoCoMo',
  mode: generator === 'llm' && judge === 'llm' ? 'llm-qa' : 'local-qa',
  dataPath,
  dataSha256: datasetSha256(dataPath),
  samples: data.length,
  turns,
  notes,
  granularity: 'turn',
  contextWindow,
  expand: true,
  k: K,
  subset: { size: questions.length, seed, sampling: 'stratified-by-category' },
  generator: { type: generator, model: generator === 'llm' ? QA_MODEL : 'deterministic-span-extraction' },
  judge: { type: judge, model: judge === 'llm' ? QA_JUDGE_MODEL : 'rule:verbatim+containment+f1>=0.6' },
  metrics: {
    accuracy: mean('correct'),
    contained: mean('contained'),
    tokenF1: mean('f1'),
    evidenceRecall: mean('evidenceRecall'),
  },
  excluded: {
    adversarial: records.length - scored.length,
    reason: 'LoCoMo category 5 is scored against adversarial_answer; a rule judge cannot decide refusal, so it stays out of accuracy and is reported separately.',
  },
  byCategory: Object.fromEntries([...perCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([category, bucket]) => [
    category,
    {
      questions: bucket.count,
      accuracy: Number((bucket.correct / bucket.count).toFixed(4)),
      tokenF1: Number((bucket.f1 / bucket.count).toFixed(4)),
    },
  ])),
  tokenAccounting: generator === 'llm' || judge === 'llm' ? tokenAccounting : { ...tokenAccounting, note: 'no LLM call: deterministic path' },
  failures,
  elapsedMs: Number((performance.now() - started).toFixed(1)),
  capturedAt: new Date().toISOString(),
};

if (outPath) writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
