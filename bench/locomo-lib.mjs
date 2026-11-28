// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Shared LoCoMo loader for the public benchmarks.
 *
 * Two harnesses read this dataset: `public-retrieval.mjs` scores retrieval
 * only, and `locomo-qa.mjs` scores end-to-end answers. Both must index the
 * corpus the same way, otherwise their numbers cannot be compared, so the
 * writing loop lives here and nowhere else.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DATA = path.resolve(import.meta.dirname, 'data', 'locomo10.json');

export function readDataset(dataPath = DEFAULT_DATA) {
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  if (!Array.isArray(data) || !data.length) throw new Error(`not a LoCoMo array: ${dataPath}`);
  return data;
}

export function datasetSha256(dataPath = DEFAULT_DATA) {
  return createHash('sha256').update(readFileSync(dataPath)).digest('hex');
}

export function sessionKeysOf(conversation) {
  return Object.keys(conversation ?? {})
    .filter(key => /^session_\d+$/.test(key))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
}

/**
 * Write the corpus into the store under test.
 *
 * `session` granularity writes one note per session (chunked at 3500 chars);
 * `turn` granularity writes one note per dialogue turn, and `contextWindow`
 * stitches the neighbouring turns into that note's text. The stitching is the
 * ingestion-side counterpart of retrieval-side expansion: a short turn rarely
 * mentions everything the question asks about, while the turns around it do.
 */
export async function writeCorpus(app, data, { granularity = 'session', contextWindow = 0 } = {}) {
  let turns = 0;
  let notes = 0;
  for (const sample of data) {
    const sampleId = String(sample.sample_id ?? 'unknown');
    const scope = `proj:locomo#${sampleId}`;
    const conversation = sample.conversation;
    for (const sessionKey of sessionKeysOf(conversation)) {
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
        continue;
      }
      for (let index = 0; index < sessionRows.length; index += 1) {
        const turn = sessionRows[index];
        if (!turn?.text || !turn?.dia_id) continue;
        const dia = String(turn.dia_id);
        const before = [];
        for (let step = contextWindow; step > 0; step -= 1) {
          const row = sessionRows[index - step];
          if (row?.text) before.push(`${row.speaker ?? ''}: ${row.text}`);
        }
        const after = [];
        for (let step = 1; step <= contextWindow; step += 1) {
          const row = sessionRows[index + step];
          if (row?.text) after.push(`${row.speaker ?? ''}: ${row.text}`);
        }
        const body = before.length || after.length
          ? [...before, `${turn.speaker ?? ''}: ${turn.text}`, ...after].join('\n')
          : `${turn.speaker ?? ''}: ${turn.text}`;
        await app.call('memory_write', {
          kind: 'note',
          scope,
          text: `[${dia}]${date ? ` ${date}` : ''} ${body}`,
          source: `locomo:${sampleId}:${dia}`,
        });
        notes += 1;
        turns += 1;
      }
    }
  }
  return { turns, notes };
}

function evidenceSources(sampleId, evidence, granularity) {
  if (granularity === 'session') {
    return evidence.map(dia => {
      const session = /^D(\d+):/.exec(dia)?.[1];
      return session ? `locomo:${sampleId}:session_${session}` : null;
    }).filter(Boolean);
  }
  return evidence.map(dia => `locomo:${sampleId}:${dia}`);
}

/** Every question that carries evidence, in dataset order. */
export function allQuestions(data, { granularity = 'session' } = {}) {
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
        answer: String(qa.answer ?? ''),
        adversarial: Number(qa.adversarial_answer ?? 0) !== 0,
        category: String(qa.category ?? 'unknown'),
        evidence,
        sources: evidenceSources(sampleId, evidence, granularity),
      });
    }
  }
  return rows;
}

/** Deterministic 32-bit PRNG so a fixed seed always yields the same subset. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fixed-seed stratified subset: each category keeps its share of the dataset,
 * so a 500-question run still covers multi-hop, temporal, single-hop and
 * adversarial questions in the same proportion as the full set.
 */
export function subsetQuestions(rows, { size = 0, seed = 42 } = {}) {
  if (!size || size >= rows.length) return rows;
  const rand = mulberry32(seed);
  const byCategory = new Map();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  const quota = new Map();
  let assigned = 0;
  for (const [category, list] of byCategory) {
    const share = Math.round(size * (list.length / rows.length));
    const take = Math.max(1, Math.min(list.length, share));
    quota.set(category, take);
    assigned += take;
  }
  // Rounding can overshoot or undershoot the requested size; fix the largest
  // category first so the subset stays exactly `size` questions.
  const largest = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  quota.set(largest, Math.max(1, quota.get(largest) + (size - assigned)));
  const picked = [];
  for (const [category, list] of byCategory) {
    const take = quota.get(category);
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    picked.push(...copy.slice(0, take));
  }
  // Keep dataset order so a diff between two runs lines up question by question.
  const order = new Map(rows.map((row, index) => [row, index]));
  return picked.sort((a, b) => order.get(a) - order.get(b));
}

/**
 * QA-side helpers live here as well so `locomo-qa.mjs` stays a thin runner and
 * the deterministic answer/judge logic is unit-testable without a store.
 */
const STOP_TERMS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'that', 'this', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'i', 'you', 'we', 'me', 'my', 'your']);

export function contentTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(token => token && !STOP_TERMS.has(token))
    .map(token => (/^[a-z]{4,}s$/.test(token) ? token.slice(0, -1) : token));
}

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentenceSplit(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(part => part.length > 0);
}

const DATE_RE = /\b(?:\d{1,2}\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[a-z]*\.?\s*\d{0,4}\b|\b(?:19|20)\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;
const NUMBER_RE = /\b\d+(?:[.,]\d+)?\b/g;

function spans(text, re) {
  return [...String(text ?? '').matchAll(re)].map(match => ({ value: match[0].trim(), index: match.index ?? 0 }));
}

/**
 * Deterministic baseline: answer with a short span of the retrieved context.
 * Question type decides what counts as an answer — dates for "when", numbers
 * for "how many", otherwise the sentence that covers the most content words.
 */
export function extractiveAnswer(question, hits, k = 10) {
  const wanted = new Set(contentTokens(question));
  const texts = hits.slice(0, k).map(hit => String(hit.text ?? hit.snippet ?? ''));
  const wantsDate = /\b(when|what date|which date|what year|which year|how long)\b/i.test(question);
  const wantsNumber = /\bhow (many|much|old|long|far)\b/i.test(question);
  if (wantsDate || wantsNumber) {
    const re = wantsDate ? DATE_RE : NUMBER_RE;
    let best = null;
    let bestScore = -1;
    for (const text of texts) {
      for (const span of spans(text, re)) {
        const window = text.slice(Math.max(0, span.index - 60), span.index + span.value.length + 60);
        const covered = new Set(contentTokens(window).filter(token => wanted.has(token))).size;
        const score = covered - 0.01 * span.value.length;
        if (score > bestScore) {
          bestScore = score;
          best = span.value;
        }
      }
    }
    if (best) return best;
  }
  let best = null;
  let bestScore = -1;
  for (const text of texts) {
    for (const sentence of sentenceSplit(text)) {
      const tokens = contentTokens(sentence);
      const covered = new Set(tokens.filter(token => wanted.has(token))).size;
      const score = covered / Math.max(1, wanted.size) - 0.001 * tokens.length;
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
  }
  if (!best) return 'unknown';
  return best.length > 240 ? `${best.slice(0, 237)}...` : best;
}

export function tokenF1(candidate, gold) {
  const cand = new Set(contentTokens(candidate));
  const want = new Set(contentTokens(gold));
  if (!cand.size || !want.size) return 0;
  let overlap = 0;
  for (const token of want) if (cand.has(token)) overlap += 1;
  const precision = overlap / cand.size;
  const recall = overlap / want.size;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

/** Rule judge: verbatim containment first, then token containment, then F1,
 * so short gold spans ("7 May 2023") can pass inside a longer sentence. */
export function ruleJudge(candidate, gold) {
  const candText = normalizeText(candidate);
  const goldText = normalizeText(gold);
  const cand = new Set(contentTokens(candidate));
  const want = contentTokens(gold);
  const verbatim = goldText.length > 1 && candText.includes(goldText);
  const contained = want.length > 0 && want.every(token => cand.has(token));
  const score = tokenF1(candidate, gold);
  return { correct: verbatim || contained || score >= 0.6, contained: verbatim || contained, f1: Number(score.toFixed(4)) };
}
