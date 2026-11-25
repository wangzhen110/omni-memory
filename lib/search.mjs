// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './embed.mjs';
import { backendConfig, embedRemote } from './embed-provider.mjs';
import { rerankConfig, rerankRemote } from './rerank-provider.mjs';
import { semanticConfig, embedSemantic } from './semantic-embed.mjs';
import { CJK_BIGRAM, SCOPE_GLOBAL, SEMANTIC_BATCH, SEMANTIC_MIN_COSINE, activeVectorDim, clearSemanticFailure, currentPackageVersion, currentProject, dropDerivedIndexes, ensureRemoteDim, entityCache, flushPendingVectors, flushSemanticPending, hash, metaSet, normalizeScopeInput, noteSemanticFailure, now, prepareCached, reindexRow, semanticState, setEntityCache, store, transaction, upsertVector } from './store.mjs';

/** Recall pipeline: lexical + semantic + hashed fallback, ranking, graph, dream. */
let invalidateProfile;
export function bindSearchRuntime(deps) {
  ({ invalidateProfile } = deps);
}

function recencyScore(ts) {
  const ageDays = Math.max(0, (now() - Number(ts ?? 0)) / 86_400_000);
  return Math.exp(-ageDays / 120);
}

/**
 * Split a query into matchable terms. CJK has no spaces, and a whole sentence is
 * almost never a contiguous substring, so CJK runs are expanded into character
 * bigrams; latin identifiers stay whole.
 */
function queryTerms(query) {
  const parts = String(query ?? '')
    .toLowerCase()
    .split(/[\]\[\s,，。、；：:;\\|()（）“”’!?！？{}<>]+/u)
    .filter(Boolean);
  const terms = new Set();
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part) && part.length > 2) {
      for (let i = 0; i + 2 <= part.length; i += 1) terms.add(part.slice(i, i + 2));
      terms.add(part);
    } else {
      terms.add(part);
    }
  }
  return [...terms].slice(0, 12);
}

/** Build `(col LIKE ? OR col LIKE ? ...)` for the supplied columns and terms. */
function likeClause(columns, terms) {
  const parts = [];
  const params = [];
  for (const column of columns) {
    for (const term of terms) {
      // User text is not a LIKE pattern. Escape the wildcard characters so a
      // query for "_" or "%" cannot turn into a full-table match.
      const escaped = String(term).replace(/[!%_]/g, match => `!${match}`);
      parts.push(`IFNULL(${column},'') LIKE ? ESCAPE '!'`);
      params.push(`%${escaped}%`);
    }
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '1=1', params };
}

/**
 * Scope filter for one column.
 *
 * A project view is a superset: rows of that project plus the global layer (and
 * legacy rows with no scope). `all` disables the filter entirely.
 */
function scopeClause(column, scope, nulls = true) {
  if (!scope || scope === 'all') return { sql: '', params: [] };
  // The panel's "project" layer means every project row, excluding global. It is
  // not the same as one exact project key (which is a project + global view).
  if (scope === 'project') return { sql: `AND ${column} LIKE 'proj:%'`, params: [] };
  const parts = [`${column} = ?`, `${column} = 'global'`];
  if (nulls) parts.push(`${column} IS NULL`);
  return { sql: `AND (${parts.join(' OR ')})`, params: [scope] };
}

/**
 * Resolve the only layers a mutating tool may touch from its host context.
 *
 * Project scope is an isolation boundary, not a display filter. A caller may
 * explicitly name its own project or global; anything else is refused. `all`
 * is only available to read-only audit paths, never to a by-id write.
 */
function writeScopeForTool(toolContext, requested, { allowAll = false } = {}) {
  const raw = normalizeScopeInput(requested);
  if (raw === 'all') {
    if (allowAll) return null;
    throw new Error('scope=all is read-only for this operation; use the current project or global');
  }
  const project = currentProject(toolContext);
  if (raw === 'project') return project || SCOPE_GLOBAL;
  if (raw === 'global') return SCOPE_GLOBAL;
  if (raw) {
    if (project && raw === project) return raw;
    throw new Error('scope must be the current project or global');
  }
  return project || SCOPE_GLOBAL;
}

/** Keep an explicit cross-project write visible instead of silently trusting it. */
function auditCrossScope(db, action, id) {
  try {
    const key = 'audit:cross-scope';
    const raw = prepareCached(db, 'SELECT value FROM meta WHERE key = ?').get(key)?.value;
    const list = raw ? JSON.parse(raw) : [];
    list.push({ at: now(), action: String(action), id: Number(id) });
    metaSet(db, key, JSON.stringify(list.slice(-100)));
  } catch { /* an audit failure must not break the operation */ }
}

/** Fraction of query terms that appear in the row's text. */
function matchRatio(row, columns, terms) {
  if (!terms.length) return 0;
  const haystack = columns.map(column => String(row[column] ?? '').toLowerCase()).join('\n');
  let hit = 0;
  for (const term of terms) if (haystack.includes(term)) hit += 1;
  return hit / terms.length;
}

function matchedTermsOf(row, columns, terms) {
  if (!terms.length) return [];
  const haystack = columns.map(column => String(row[column] ?? '').toLowerCase()).join('\n');
  return terms.filter(term => haystack.includes(String(term).toLowerCase())).slice(0, 6);
}

/**
 * A search result is a pointer, not the whole note. Keep the beginning and the
 * tail so a conclusion at the end of a long note is still visible; if a query
 * term has a clear match, show a window around it instead.
 */
function searchExcerpt(text, terms = [], max = 460) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (source.length <= max) return source;
  const lower = source.toLowerCase();
  let anchor = -1;
  for (const term of terms) {
    const at = lower.indexOf(String(term).toLowerCase());
    if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at;
  }
  if (anchor > 100 && anchor < source.length - 100) {
    const start = Math.max(0, anchor - 100);
    const end = Math.min(source.length, start + max - 2);
    return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
  }
  const head = source.slice(0, 200);
  const tail = source.slice(-220);
  return `${head} … ${tail}`;
}

function hitWhy(hit) {
  const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const reasons = [];
  if (hit.exactProblem) reasons.push('problemKey');
  if (numeric(hit.lexicalScore) || hit.via === 'lexical') reasons.push('lexical');
  if (numeric(hit.vectorScore) || hit.via === 'vector') reasons.push('vector');
  if (numeric(hit.semanticScore) || hit.via === 'semantic') reasons.push('semantic');
  if (numeric(hit.graphScore) || hit.via === 'graph') reasons.push('graph');
  if (hit.solutionStatus === 'verified') reasons.push('verified');
  if (Number(hit.reuseCount) > 0) reasons.push(`reused×${Number(hit.reuseCount)}`);
  if (hit.contested) reasons.push('contested');
  if (hit.staleVersion) reasons.push('stale-version');
  return reasons.join('+') || 'matched';
}

function versionParts(value) {
  const match = String(value ?? '').match(/(\d{1,5})\.(\d{1,5})\.(\d{1,5})/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionParts(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * A note can be correct when written and stale months later. Only flag version
 * claims that also name this product; a GB/T number or a date is not a release.
 */
function staleVersionIn(text, currentVersion = currentPackageVersion()) {
  const body = String(text ?? '');
  if (!/(全息记忆|omni)/i.test(body)) return null;
  const current = versionParts(currentVersion);
  if (!current || current.every(n => n === 0)) return null;
  const versions = [];
  const add = (value) => {
    const parts = versionParts(value);
    if (!parts) return;
    if (parts[0] === current[0] && parts[1] === current[1] && parts[2] === current[2]) return;
    if (!versions.some(item => item.text === value)) versions.push({ text: value, parts });
  };
  // "全息记忆 3.11.8", "全息记忆（3.11.8）", "omni-memory v4.1.0"
  for (const match of body.matchAll(/(?:全息记忆|omni(?:-memory)?)[^\n。；]{0,60}?v?(\d{1,4}\.\d{1,4}\.\d{1,4})/gi)) add(match[1]);
  // "3.11.8 的全息记忆", "v4.1.0 把 /hub ... 全息记忆"
  for (const match of body.matchAll(/v?(\d{1,4}\.\d{1,4}\.\d{1,4})[^\n。；]{0,60}?(?:全息记忆|omni)/gi)) add(match[1]);
  // A release note often starts with its version and names the product later.
  const start = body.match(/^\s*(?:v|版本)?(\d{1,4}\.\d{1,4}\.\d{1,4})/i);
  if (start) add(start[1]);
  for (const item of versions) {
    if (compareVersionParts(item.parts, current) < 0) return item.text;
  }
  return null;
}

function recencyBoost(ts) {
  const ageDays = (Date.now() - Number(ts ?? 0)) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays)) return 0;
  const age = Math.max(0, ageDays);
  return 0.02 / (1 + age / 30);
}

function rank(items) {
  return items.sort((a, b) => b.score - a.score);
}

/**
 * Two-character CJK lookup through the bigram index. FTS5 trigram needs three
 * characters, so without this a two-character query degenerated into a full
 * table LIKE scan.
 */
/**
 * Bounded lexical candidates.
 *
 * `ORDER BY bm25(...)` forces SQLite to materialise the whole match list before
 * returning the first row: at 1M notes one common term cost ~600ms even though
 * the same MATCH without ranking answers in 0.1ms. Lexical retrieval is now two
 * stages: bounded candidate generation (recent-window LIKE, unranked FTS sample,
 * bigram index capped by owner id) followed by JS scoring. Window size is
 * configurable; the window never replaces exact matches, it adds recent ones.
 */
const SEARCH_WINDOW_DEFAULT = 20_000;
const SEARCH_WINDOW_LARGE = 5_000;
const VECTOR_SAMPLE_DEFAULT = 5_000;
const VECTOR_SAMPLE_LARGE = 1_000;
const MIN_LARGE_STORE_ROWS = 10_000;
const LARGE_STORE_ROWS = (() => {
  const raw = Number(process.env.OMNI_LARGE_STORE_ROWS ?? 250_000);
  if (!Number.isFinite(raw) || raw <= 0) return 250_000;
  if (raw < MIN_LARGE_STORE_ROWS) {
    // A silent clamp used to make `OMNI_LARGE_STORE_ROWS=5000` look applied
    // while the effective threshold stayed 250,000. Keep the safe floor, but
    // say so once so a benchmark run cannot be misread.
    console.warn(`[omni] OMNI_LARGE_STORE_ROWS=${raw} is below ${MIN_LARGE_STORE_ROWS}; using ${MIN_LARGE_STORE_ROWS}`);
    return MIN_LARGE_STORE_ROWS;
  }
  return Math.floor(raw);
})();
const ACTIVE_COUNT_TTL_MS = (() => {
  const raw = Number(process.env.OMNI_ACTIVE_COUNT_TTL_MS ?? 60_000);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60_000;
})();
const SEARCH_WINDOW_OVERRIDE = process.env.OMNI_SEARCH_WINDOW === undefined
  ? null
  : Math.max(1000, Number(process.env.OMNI_SEARCH_WINDOW) || 1000);
const VECTOR_SAMPLE_OVERRIDE = process.env.OMNI_VECTOR_SAMPLE === undefined
  ? null
  : Math.max(1000, Number(process.env.OMNI_VECTOR_SAMPLE) || 1000);
const FTS_SAMPLE = 120;
const BIGRAM_SAMPLE = 200;

/** Largest id without COUNT(*): a 1M-row COUNT on every query is avoidable. */
function maxRowId(db, table) {
  try {
    return Number(prepareCached(db, `SELECT MAX(id) AS n FROM ${table}`).get()?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Count only rows that can still be recalled. `MAX(id)` is an id high-water
 * mark, not a row count: soft deletes never reuse ids, so a churn-heavy store
 * can have a huge max id and almost no live memories. Using the max id as the
 * large-store signal shrank the lexical window to 5,000 and silently lost rows
 * that sat below the tombstone gap. The count is cached per connection because
 * an exact COUNT(*) on a 1M-row store is still measurable; the TTL bounds
 * staleness after writes.
 */
const activeCountCache = new WeakMap();
function activeRowCount(db, table, extra = '') {
  const now = Date.now();
  let cache = activeCountCache.get(db);
  if (!cache) {
    cache = new Map();
    activeCountCache.set(db, cache);
  }
  const key = `${table}\u0000${extra}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < ACTIVE_COUNT_TTL_MS) return hit.count;
  let count = 0;
  try {
    count = Number(prepareCached(db, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL ${extra}`).get()?.n ?? 0);
  } catch {
    count = 0;
  }
  cache.set(key, { count, at: now });
  return count;
}

function isLargeStore(db, table, max = maxRowId(db, table)) {
  // Below the threshold no count is needed. Above it, the live row count
  // decides: tombstones and superseded revisions are storage, not recall
  // complexity. Facts use valid_to as their retired state.
  if (max <= LARGE_STORE_ROWS) return false;
  const activeFilter = table === 'notes'
    ? 'AND superseded_by IS NULL'
    : table === 'facts'
      ? 'AND valid_to IS NULL'
      : '';
  return activeRowCount(db, table, activeFilter) > LARGE_STORE_ROWS;
}

function effectiveSearchWindow(db, table, max = maxRowId(db, table)) {
  if (SEARCH_WINDOW_OVERRIDE !== null) return SEARCH_WINDOW_OVERRIDE;
  return isLargeStore(db, table, max) ? SEARCH_WINDOW_LARGE : SEARCH_WINDOW_DEFAULT;
}

function effectiveVectorSample(db) {
  if (VECTOR_SAMPLE_OVERRIDE !== null) return VECTOR_SAMPLE_OVERRIDE;
  return isLargeStore(db, 'notes') ? VECTOR_SAMPLE_LARGE : VECTOR_SAMPLE_DEFAULT;
}

/** Recent-window substring scan: bounded by window size, recency biased. */
function recentWindowRows(db, table, terms, columns, filter, limit, extra = '') {
  const clause = likeClause(columns, terms);
  try {
    const max = Number(prepareCached(db, `SELECT MAX(id) AS n FROM ${table}`).get()?.n ?? 0);
    if (!max) return [];
    const window = effectiveSearchWindow(db, table, max);
    return prepareCached(db, `
      SELECT * FROM ${table}
      WHERE id > ? AND deleted_at IS NULL ${extra} AND ${clause.sql} ${filter.sql}
      ORDER BY id DESC LIMIT ?
    `).all(max - window, ...clause.params, ...filter.params, Math.max(limit * 4, 16));
  } catch {
    return [];
  }
}

/**
 * Sample matching rowids only.
 *
 * Joining the FTS table to the source table and filtering *after* the join made
 * LIMIT ineffective whenever the filter rejected the first matches (a project
 * scope can reject almost everything): SQLite then walked the whole doclist.
 * Sampling rowids first bounds the cost to the sample size, and scope/active
 * checks happen in JS on the fetched rows.
 */
function ftsRowIds(db, ftsTable, term, limit) {
  const quoted = `"${String(term).replaceAll('"', '""')}"`;
  try {
    return prepareCached(db, `SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT ?`)
      .all(quoted, limit)
      .map(row => Number(row.rowid));
  } catch {
    return [];
  }
}

/** Fetch rows by id with the active-state filter pushed into SQL. */
function rowsByIds(db, table, ids, extraSql = '') {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  try {
    return prepareCached(db, `SELECT * FROM ${table} WHERE id IN (${placeholders}) ${extraSql}`).all(...ids);
  } catch {
    return [];
  }
}

/** The JS twin of scopeClause for rows fetched by id. */
/** Normalise an entity name so "Deploy" and "deploy" are the same node. */
function normalizeEntity(name) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/^[\s"'\u201c\u201d]+|[\s"'\u201c\u201d]+$/g, '')
    .replace(/[。；;，,]+$/g, '');
}

/** Follow the alias chain (bounded) to the canonical entity. */
function canonicalEntity(db, name) {
  let current = normalizeEntity(name);
  if (!current) return current;
  try {
    for (let depth = 0; depth < 5; depth += 1) {
      const row = prepareCached(db, 'SELECT canonical FROM entity_aliases WHERE alias = ?').get(current);
      if (!row || row.canonical === current) break;
      current = String(row.canonical);
    }
  } catch { /* registry absent on very old stores */ }
  return current;
}

function linkEntity(s, aliasInput, canonicalInput, options = {}) {
  const alias = normalizeEntity(aliasInput);
  const canonical = canonicalEntity(s.db, canonicalInput);
  if (!alias || !canonical) throw new Error('alias and canonical are required');
  if (alias === canonical) throw new Error('alias and canonical are the same entity');
  const dryRun = options.apply !== true;
  const affectedFacts = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM facts WHERE subject = ? COLLATE NOCASE').get(alias)?.n ?? 0);
  const affectedObjectFacts = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM facts WHERE object = ? COLLATE NOCASE').get(alias)?.n ?? 0);
  const affectedEdges = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM edges WHERE src = ? COLLATE NOCASE').get(alias)?.n ?? 0);
  const affectedDstEdges = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM edges WHERE dst = ? COLLATE NOCASE').get(alias)?.n ?? 0);
  if (dryRun) return {
    alias, canonical, affectedFacts, affectedObjectFacts, affectedEdges, affectedDstEdges, applied: false,
  };
  transaction(s.db, () => {
    prepareCached(s.db, 'INSERT OR REPLACE INTO entity_aliases(alias, canonical, updated_at) VALUES (?, ?, ?)')
      .run(alias, canonical, now());
    prepareCached(s.db, 'INSERT OR IGNORE INTO entities(name) VALUES (?)').run(canonical);
    prepareCached(s.db, 'UPDATE facts SET subject = ? WHERE subject = ? COLLATE NOCASE').run(canonical, alias);
    prepareCached(s.db, 'UPDATE facts SET object = ? WHERE object = ? COLLATE NOCASE').run(canonical, alias);
    prepareCached(s.db, 'UPDATE edges SET src = ? WHERE src = ? COLLATE NOCASE').run(canonical, alias);
    prepareCached(s.db, 'UPDATE edges SET dst = ? WHERE dst = ? COLLATE NOCASE').run(canonical, alias);
    prepareCached(s.db, 'DELETE FROM entities WHERE name = ?').run(alias);
  });
  setEntityCache({ names: [], at: 0 });
  invalidateProfile();
  return {
    alias, canonical, affectedFacts, affectedObjectFacts, affectedEdges, affectedDstEdges, applied: true,
  };
}

function relationCardinality(db, name) {
  try {
    return prepareCached(db, 'SELECT cardinality FROM relations WHERE name = ?').get(name)?.cardinality ?? 'single';
  } catch {
    return 'single';
  }
}

function setRelationCardinality(db, name, cardinality) {
  try {
    prepareCached(db, `
      INSERT INTO relations(name, cardinality, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET cardinality = excluded.cardinality, updated_at = excluded.updated_at
    `).run(name, cardinality, now());
  } catch { /* registry is best effort */ }
}

function scopeAllows(value, scope, nulls = true) {
  if (!scope || scope === 'all') return true;
  if (scope === 'project') return String(value ?? '').startsWith('proj:');
  if (value === scope || value === 'global') return true;
  return nulls && (value === null || value === undefined);
}

const SOLUTION_STATUSES = new Set(['verified', 'unverified', 'failed', 'expired']);

/** Normalize an error signature so the same failure matches across sessions. */
function normalizeProblemKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function solutionStatusOf(value) {
  const status = String(value ?? 'unverified').trim().toLowerCase();
  return SOLUTION_STATUSES.has(status) ? status : 'unverified';
}

/** Prefer proven solutions; keep failed/expired attempts visible but below them. */
function solutionBoost(statusValue, reuseValue = 0) {
  const status = solutionStatusOf(statusValue);
  const reuse = Math.min(0.15, Math.log1p(Math.max(0, Number(reuseValue) || 0)) * 0.05);
  if (status === 'verified') return 0.2 + reuse;
  if (status === 'failed') return -0.2 + reuse;
  if (status === 'expired') return -0.35 + reuse;
  return reuse;
}

/** Fields shared by every note-shaped search hit and API detail response. */
function solutionFields(row) {
  return {
    problemKey: row.problem_key ?? row.problemKey ?? null,
    solutionStatus: solutionStatusOf(row.solution_status ?? row.solutionStatus),
    reuseCount: Number(row.reuse_count ?? row.reuseCount ?? 0),
    lastUsedAt: row.last_used_at ?? row.lastUsedAt ?? null,
    verifiedAt: row.solution_verified_at ?? row.solutionVerifiedAt ?? null,
    verification: row.verification ?? null,
    evidence: row.evidence ?? null,
  };
}

/** Recall-quality counters shared by note and fact hits. */
function feedbackFields(row) {
  const useful = Math.max(0, Number(row.useful_count ?? 0));
  const misleading = Math.max(0, Number(row.misleading_count ?? 0));
  // The physical column is `recall_count` for schema compatibility, but the
  // signal is a feedback vote, not every search hit. Expose the honest name.
  const feedback = Math.max(0, Number(row.recall_count ?? 0));
  const quality = useful + misleading === 0 ? 0.5 : (useful + 1) / (useful + misleading + 2);
  return {
    feedbackCount: feedback,
    usefulCount: useful,
    misleadingCount: misleading,
    lastFeedbackAt: row.last_recall_at ?? null,
    quality: Number(quality.toFixed(3)),
  };
}

/** Bayesian-smoothed quality: a few useful votes lift, misleading votes penalize. */
function feedbackBoost(row) {
  const useful = Math.max(0, Number(row.useful_count ?? 0));
  const misleading = Math.max(0, Number(row.misleading_count ?? 0));
  return Math.min(0.2, Math.log1p(useful) * 0.05) - Math.min(0.3, Math.log1p(misleading) * 0.08);
}

/**
 * Two-character CJK lookup through the bigram index. The inner query walks the
 * (gram, layer, owner_id) index backwards and stops after the sample size, so a
 * gram that appears in every row still costs O(sample) instead of O(rows).
 */
function searchBigrams(s, layer, table, term, limit, filter, extra = '') {
  if (!CJK_BIGRAM.test(term)) return [];
  try {
    return prepareCached(s.db, `
      SELECT t.* FROM (
        SELECT owner_id FROM bigrams
        WHERE layer = ? AND gram = ?
        ORDER BY owner_id DESC LIMIT ?
      ) b JOIN ${table} t ON t.id = b.owner_id
      WHERE t.deleted_at IS NULL ${extra} ${filter.sql}
      ORDER BY t.id DESC
    `).all(layer, term, Math.max(BIGRAM_SAMPLE, limit * 4), ...filter.params);
  } catch {
    return [];
  }
}

function searchChunks(s, terms, limit, scope) {
  if (!terms.length) return [];
  const out = [];
  const seen = new Set();
  const push = (row, textScore) => {
    const key = `c${row.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ratio = matchRatio(row, ['text', 'source'], terms);
    out.push({
      kind: 'chunk',
      id: Number(row.id),
      ts: Number(row.ts),
      role: row.role,
      source: row.source ?? '',
      scope: row.scope ?? null,
      text: String(row.text),
      snippet: searchExcerpt(row.text, terms),
      matchedTerms: matchedTermsOf(row, ['text', 'source'], terms),
      via: 'lexical',
      score: 0.6 * Math.max(textScore, ratio) + 0.2 * Number(row.importance ?? 0.5) + 0.2 * recencyScore(row.ts),
    });
  };

  const filter = scopeClause('scope', scope);
  for (const row of recentWindowRows(s.db, 'chunks', terms, ['text', 'source'], filter, limit)) push(row, 0.5);
  if (s.fts.chunks) {
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 5)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'chunk', 'chunks', term, limit, bigramFilter)) {
          if (scopeAllows(row.scope, scope)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'chunks', ftsRowIds(s.db, 'chunks_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope)) push(row, 0.8);
    }
  }
  return out;
}

function searchNotes(s, terms, limit, scope, options = {}) {
  if (!terms.length) return [];
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const found = new Map();
  const push = (row, textScore) => {
    if (status && solutionStatusOf(row.solution_status) !== status) return;
    const id = Number(row.id);
    const candidate = {
      kind: 'note',
      id,
      ts: Number(row.ts),
      scope: row.scope,
      source: row.source ?? '',
      revision: Number(row.revision ?? 1),
      contested: Number(row.contested ?? 0) === 1,
      ...solutionFields(row),
      ...feedbackFields(row),
      text: String(row.text),
      snippet: searchExcerpt(row.text, terms),
      matchedTerms: matchedTermsOf(row, ['text'], terms),
      via: 'lexical',
      score: 0.6 * Math.max(textScore, matchRatio(row, ['text'], terms))
        + 0.2 * Number(row.importance ?? 0.5)
        + 0.2 * recencyScore(row.ts)
        + solutionBoost(row.solution_status, row.reuse_count)
        + feedbackBoost(row),
    };
    const previous = found.get(id);
    if (!previous || candidate.score > previous.score) found.set(id, candidate);
  };

  const filter = scopeClause('scope', scope, false);
  for (const row of recentWindowRows(s.db, 'notes', terms, ['text'], filter, limit, 'AND superseded_by IS NULL')) {
    push(row, 0.5);
  }
  if (s.fts.notes) {
    const bigramFilter = scopeClause('t.scope', scope, false);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'note', 'notes', term, limit, bigramFilter, 'AND t.superseded_by IS NULL')) {
          if (scopeAllows(row.scope, scope, false)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'notes', ftsRowIds(s.db, 'notes_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL AND superseded_by IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope, false)) push(row, 0.8);
    }
  }
  return [...found.values()];
}

/** Deterministic lookup for an exact error signature before semantic recall. */
function searchProblemKey(s, problemKey, limit, scope, options = {}) {
  const key = normalizeProblemKey(problemKey);
  if (!key) return [];
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const filter = scopeClause('scope', scope, false);
  const statusSql = status ? "AND COALESCE(solution_status, 'unverified') = ?" : '';
  try {
    return prepareCached(s.db, `
      SELECT * FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND problem_key = ?
        ${filter.sql} ${statusSql}
      ORDER BY
        CASE COALESCE(solution_status, 'unverified')
          WHEN 'verified' THEN 0 WHEN 'unverified' THEN 1 WHEN 'failed' THEN 2 ELSE 3
        END,
        reuse_count DESC, importance DESC, ts DESC
      LIMIT ?
    `).all(key, ...filter.params, ...(status ? [status] : []), Math.min(30, Math.max(1, Number(limit) || 8)))
      .map(row => ({
        kind: 'note',
        id: Number(row.id),
        ts: Number(row.ts),
        scope: row.scope,
        source: row.source ?? '',
        revision: Number(row.revision ?? 1),
        contested: Number(row.contested ?? 0) === 1,
        ...solutionFields(row),
        ...feedbackFields(row),
        text: String(row.text),
        snippet: searchExcerpt(row.text, []),
        matchedTerms: [],
        via: 'lexical',
        score: 2 + solutionBoost(row.solution_status, row.reuse_count) + feedbackBoost(row),
        exactProblem: true,
      }));
  } catch {
    return [];
  }
}

function searchFacts(s, terms, limit, scope) {
  if (!terms.length) return [];
  const found = new Map();
  const push = (row, textScore) => {
    const id = Number(row.id);
    const candidate = {
      kind: 'fact',
      id,
      ts: Number(row.valid_from),
      subject: row.subject,
      relation: row.relation,
      object: row.object,
      validFrom: Number(row.valid_from),
      validTo: row.valid_to === null ? null : Number(row.valid_to),
      contested: Number(row.contested ?? 0) === 1,
      source: row.source ?? '',
      scope: row.scope ?? null,
      ...feedbackFields(row),
      text: String(row.text),
      snippet: searchExcerpt(row.text, terms),
      matchedTerms: matchedTermsOf(row, ['text', 'subject', 'object'], terms),
      via: 'lexical',
      score: 0.6 * Math.max(textScore, matchRatio(row, ['text', 'subject', 'object'], terms))
        + 0.2 * Number(row.confidence ?? 0.7)
        + 0.2 * recencyScore(row.valid_from)
        + feedbackBoost(row),
    };
    const previous = found.get(id);
    if (!previous || candidate.score > previous.score) found.set(id, candidate);
  };

  const filter = scopeClause('scope', scope);
  for (const row of recentWindowRows(s.db, 'facts', terms, ['text', 'subject', 'object'], filter, limit, 'AND valid_to IS NULL')) {
    push(row, 0.5);
  }
  if (s.fts.facts) {
    const bigramFilter = scopeClause('t.scope', scope);
    for (const term of terms.slice(0, 6)) {
      if (term.length === 2 && CJK_BIGRAM.test(term)) {
        for (const row of searchBigrams(s, 'fact', 'facts', term, limit, bigramFilter, 'AND t.valid_to IS NULL')) {
          if (scopeAllows(row.scope, scope)) push(row, 1);
        }
        continue;
      }
      if (term.length < 3) continue;
      const rows = rowsByIds(s.db, 'facts', ftsRowIds(s.db, 'facts_fts', term, FTS_SAMPLE), 'AND deleted_at IS NULL AND valid_to IS NULL');
      for (const row of rows) if (scopeAllows(row.scope, scope)) push(row, 0.8);
    }
  }
  return [...found.values()];
}

function textBlock(text) {
  return [{ type: 'text', text }];
}

/**
 * Dreaming: verify notes against the transcripts they came from.
 *
 * This is deliberately deterministic. A model could judge contradictions better,
 * but a background verifier that costs a model call per note is a verifier nobody
 * leaves on. Coverage of the note's tokens in the cited evidence is a proxy for
 * "is this claim actually supported by what was said"; anything below the weak
 * threshold is flagged for review and, when applying, superseded by a note built
 * from the evidence itself — the old row stays readable for audit.
 */
const DREAM_SUPPORTED = 0.8;
const DREAM_WEAK = 0.4;
const DREAM_MAX_NOTES = 100;
const DREAM_MAX_CHUNKS = 300;

function dreamEvidence(s, note, scope = note.scope ?? SCOPE_GLOBAL) {
  const scopeFilter = scopeClause('scope', scope);
  const pickBest = rows => {
    let best = null;
    let bestScore = -1;
    for (const row of rows) {
      const score = coverageScore(note.text, row.text);
      // Equal coverage keeps the first row, which is the newest because every
      // source query orders by ts DESC. Row order is no longer the decision.
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    return best;
  };
  const source = String(note.source ?? '').trim();
  if (source) {
    try {
      // New captures carry `session:<id>#<seq>`. That exact pointer identifies
      // the turn; the old query took LIMIT 1 from every chunk of a session and
      // could cite the wrong turn, marking a correct note as contradicted.
      const rows = prepareCached(s.db, `
        SELECT id, text, source FROM chunks
        WHERE source = ? AND deleted_at IS NULL ${scopeFilter.sql}
        ORDER BY ts DESC, id DESC LIMIT 20
      `).all(source, ...scopeFilter.params);
      const exact = pickBest(rows);
      if (exact) {
        const score = coverageScore(note.text, exact.text);
        if (score >= DREAM_WEAK) return exact;
      }
      // Legacy sources name only a session. Ask for that session's recent chunks
      // and select by textual coverage instead of accepting the first row.
      const base = source.replace(/#\d+$/, '');
      if (base !== source) {
        const legacy = prepareCached(s.db, `
          SELECT id, text, source FROM chunks
          WHERE source LIKE ? AND deleted_at IS NULL ${scopeFilter.sql}
          ORDER BY ts DESC, id DESC LIMIT ${DREAM_MAX_CHUNKS}
        `).all(`${base}#%`, ...scopeFilter.params);
        const best = pickBest(legacy);
        if (best && coverageScore(note.text, best.text) >= DREAM_WEAK) return best;
      }
    } catch { /* fall through to similarity */ }
  }
  const tokens = [...new Set(tokenize(note.text))].filter(token => token.length >= 2);
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  let rows = [];
  try {
    rows = prepareCached(s.db, `
      SELECT id, text, source FROM chunks
      WHERE deleted_at IS NULL ${scopeFilter.sql}
      ORDER BY ts DESC LIMIT ?
    `).all(...scopeFilter.params, DREAM_MAX_CHUNKS);
  } catch { return null; }
  for (const row of rows) {
    const haystack = String(row.text ?? '');
    let hits = 0;
    for (const token of tokens) if (haystack.includes(token)) hits += 1;
    const score = hits / tokens.length;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= DREAM_WEAK ? best : null;
}

function coverageScore(noteText, evidenceText) {
  const tokens = [...new Set(tokenize(noteText))];
  if (!tokens.length) return 0;
  // tokenize() lowercases latin tokens; the evidence haystack must be lowered
  // too or "Docker" in the original text never matches "docker" in the token.
  const haystack = String(evidenceText ?? '').toLowerCase();
  let hits = 0;
  for (const token of tokens) if (haystack.includes(token)) hits += 1;
  return hits / tokens.length;
}

function dreamRun(s, apply, options = {}) {
  // Flagging is safe; replacing a memory is a semantic decision. Replacement is
  // therefore opt-in and every replacement records its source as dream:<noteId>
  // so it can be rolled back.
  const commit = options.commit === true;
  const notes = prepareCached(s.db, `
    SELECT * FROM notes
    WHERE deleted_at IS NULL AND superseded_by IS NULL AND COALESCE(revision, 1) < 3
    ORDER BY importance DESC, ts DESC LIMIT ?
  `).all(DREAM_MAX_NOTES);
  const actions = [];
  for (const note of notes) {
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    let verdict = 'no_source';
    let score = 0;
    let evidenceRef = null;
    let missingTokens = [];
    if (evidence) {
      score = coverageScore(note.text, evidence.text);
      // Coverage alone cannot see a swapped value: "Docker" vs "裸机" is one word
      // out of twenty. A distinctive latin/number token present in the note but
      // absent from the evidence is the deterministic signal available without a
      // model call.
      const distinctive = [...new Set(tokenize(note.text))]
        .filter(token => token.length >= 3 && /^[a-z0-9_.-]+$/.test(token));
      missingTokens = distinctive.filter(token => !String(evidence.text ?? '').toLowerCase().includes(token));
      if (score >= 0.6 && missingTokens.length) verdict = 'contradicted';
      else if (score >= DREAM_SUPPORTED) verdict = 'supported';
      else if (score >= DREAM_WEAK) verdict = 'weak';
      else verdict = 'unsupported';
      evidenceRef = evidence.source || `chunk:${evidence.id}`;
    }
    const action = {
      noteId: Number(note.id),
      verdict,
      score: Number(score.toFixed(2)),
      evidence: evidenceRef,
      ...(missingTokens.length ? { missingTokens } : {}),
    };
    if (apply) {
      transaction(s.db, () => {
        prepareCached(s.db, 'UPDATE notes SET verified_at = ?, verification = ?, evidence = ? WHERE id = ?')
          .run(now(), verdict, evidenceRef, Number(note.id));
        if ((verdict === 'unsupported' || verdict === 'contradicted') && evidence) {
          prepareCached(s.db, 'UPDATE notes SET contested = 1 WHERE id = ?').run(Number(note.id));
          action.proposedText = String(evidence.text).slice(0, 600);
          if (!commit) return;
          const replacementText = action.proposedText;
          const info = prepareCached(s.db,
            'INSERT INTO notes(ts, scope, text, text_hash, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(now(), note.scope, replacementText, hash(replacementText), 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
          const replacementId = Number(info.lastInsertRowid);
          prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?').run(replacementId, Number(note.id));
          dropDerivedIndexes(s, 'note', note.id);
          reindexRow(s, 'note', replacementId, replacementText);
          action.replacementId = replacementId;
        }
      });
    }
    actions.push(action);
  }
  if (apply) invalidateProfile();
  return { scanned: notes.length, applied: Boolean(apply), actions };
}

/** Evidence-backed replacement candidates for notes already flagged by a dream run. */
function dreamProposals(s, limit = 50) {
  const rows = prepareCached(s.db, `
    SELECT * FROM notes
    WHERE deleted_at IS NULL AND superseded_by IS NULL
      AND verification IN ('unsupported', 'contradicted')
    ORDER BY ts DESC LIMIT ?
  `).all(Math.min(Math.max(1, Number(limit) || 50), 200));
  const out = [];
  for (const note of rows) {
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    if (!evidence) continue;
    out.push({
      noteId: Number(note.id),
      verdict: note.verification,
      evidence: evidence.source || `chunk:${evidence.id}`,
      proposedText: String(evidence.text).slice(0, 600),
    });
  }
  return out;
}

/** Replace one flagged note with its evidence text. Explicit per-note action. */
function dreamReplace(s, noteId, scope = SCOPE_GLOBAL) {
  const filter = scopeClause('scope', scope);
  const result = transaction(s.db, () => {
    const note = prepareCached(s.db,
      `SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${filter.sql}`
    ).get(Number(noteId), ...filter.params);
    if (!note) throw new Error('note not found, already superseded, or outside the current project');
    const evidence = dreamEvidence(s, note, note.scope ?? SCOPE_GLOBAL);
    if (!evidence) throw new Error('no evidence to build a replacement');
    const replacementText = String(evidence.text).slice(0, 600);
    const info = prepareCached(s.db,
      'INSERT INTO notes(ts, scope, text, text_hash, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(now(), note.scope, replacementText, hash(replacementText), 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
    const replacementId = Number(info.lastInsertRowid);
    prepareCached(s.db, 'UPDATE notes SET superseded_by = ?, contested = 1 WHERE id = ?').run(replacementId, Number(note.id));
    dropDerivedIndexes(s, 'note', note.id);
    reindexRow(s, 'note', replacementId, replacementText);
    return {
      oldId: Number(note.id),
      replacementId,
      evidence: evidence.source || `chunk:${evidence.id}`,
    };
  });
  invalidateProfile();
  return result;
}

/** Undo a dream replacement: revive the original, tombstone the generated note. */
function dreamRollback(s, noteId, scope = SCOPE_GLOBAL) {
  const filter = scopeClause('scope', scope);
  const result = transaction(s.db, () => {
    const note = prepareCached(s.db, `SELECT id, superseded_by, text, scope FROM notes WHERE id = ? ${filter.sql}`)
      .get(Number(noteId), ...filter.params);
    if (!note || !note.superseded_by) return { restored: false, reason: 'not superseded' };
    const replacement = prepareCached(s.db, 'SELECT id, source, deleted_at FROM notes WHERE id = ?').get(Number(note.superseded_by));
    if (!replacement || !String(replacement.source ?? '').startsWith('dream:')) {
      return { restored: false, reason: 'not a dream replacement' };
    }
    prepareCached(s.db, 'UPDATE notes SET superseded_by = NULL, contested = 0 WHERE id = ?').run(Number(note.id));
    prepareCached(s.db, 'UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now(), Number(replacement.id));
    dropDerivedIndexes(s, 'note', replacement.id);
    // Superseding the note removed all derived views; rollback must rebuild
    // FTS, bigrams and the vector, not only the vector.
    if (note.text) reindexRow(s, 'note', note.id, note.text);
    return { restored: true, replacementId: Number(replacement.id) };
  });
  if (result.restored) invalidateProfile();
  return result;
}

/**
 * Semantic route over the bundled local model. It is independent of the
 * hashed/remote `vectors` table, so an old store can keep serving recall while
 * this index backfills. A model failure returns [] and never breaks search.
 */
// Vectors are scanned in JS. An unbounded scan over 1M rows reads gigabytes per
// query, so both vector routes sample the most recent rows and add lexical
// candidates. The sample shrinks on large stores (effectiveVectorSample); a real
// ANN index is the next step, not a requirement for bounded latency.

async function semanticSearch(s, queryText, limit, scope, candidates = []) {
  const config = semanticConfig();
  if (!config.enabled) return [];
  const terms = queryTerms(queryText);
  const state = semanticState(s);
  if (state.retryAt > now()) return [];
  // A note written in this same turn is still queued. Index one batch before
  // querying so "write a note, then ask about it" never depends on a timer.
  try {
    await flushSemanticPending(s, config, SEMANTIC_BATCH);
  } catch (error) {
    // Keep the failure visible in status without breaking the other routes.
    noteSemanticFailure(state, error);
    return [];
  }
  let queryVector;
  try {
    [queryVector] = await embedSemantic([queryText], config, { query: true });
    clearSemanticFailure(state);
  } catch (error) {
    noteSemanticFailure(state, error);
    return [];
  }
  if (!queryVector || queryVector.length !== config.dim) return [];
  if (!queryVector || !queryVector.length) return [];
  const specList = [
    { kind: 'note', table: 'notes', extra: 'AND t.superseded_by IS NULL' },
    { kind: 'fact', table: 'facts', extra: 'AND t.valid_to IS NULL' },
    { kind: 'chunk', table: 'chunks', extra: '' },
  ];
  const candidateIds = new Map();
  for (const hit of candidates) {
    if (!hit || !hit.kind) continue;
    const list = candidateIds.get(hit.kind) ?? [];
    if (list.length < 400) list.push(Number(hit.id));
    candidateIds.set(hit.kind, list);
  }
  const out = [];
  const sampleLimit = effectiveVectorSample(s.db);
  for (const spec of specList) {
    const sampleIds = [];
    try {
      for (const row of prepareCached(s.db, `
        SELECT owner_id FROM semantic_vectors
        WHERE model = ? AND kind = ? AND dim = ?
        ORDER BY owner_id DESC LIMIT ?
      `).all(config.signature, spec.kind, config.dim, sampleLimit)) sampleIds.push(Number(row.owner_id));
    } catch { /* semantic table may not exist on a pre-v14 store */ }
    const extraIds = (candidateIds.get(spec.kind) ?? []).filter(id => Number.isFinite(id) && id > 0);
    const ids = [...new Set([...sampleIds, ...extraIds])];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const placeholders = chunk.map(() => '?').join(',');
      try {
        for (const row of prepareCached(s.db, `
          SELECT v.owner_id AS owner_id, v.vec AS vec, t.*
          FROM semantic_vectors v JOIN ${spec.table} t ON t.id = v.owner_id
          WHERE v.model = ? AND v.kind = ? AND v.dim = ?
            AND v.owner_id IN (${placeholders})
            AND t.deleted_at IS NULL ${spec.extra}
        `).all(config.signature, spec.kind, config.dim, ...chunk)) {
          if (!scopeAllows(row.scope, scope, false)) continue;
          let score = 0;
          try { score = dot(queryVector, fromBlob(row.vec, config.dim)); } catch { continue; }
          if (!Number.isFinite(score) || score < SEMANTIC_MIN_COSINE) continue;
          out.push({
            kind: spec.kind,
            id: Number(row.owner_id),
            ts: Number(row.ts ?? row.valid_from ?? 0),
            scope: row.scope ?? null,
            text: String(row.text ?? ''),
            snippet: searchExcerpt(row.text, terms),
            matchedTerms: matchedTermsOf(row, ['text'], terms),
            source: row.source ?? '',
            ...(spec.kind === 'note' ? solutionFields(row) : {}),
            score,
            cosine: score,
            semanticScore: score,
            via: 'semantic',
          });
        }
      } catch { /* skip an unreadable chunk */ }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Vector route: cosine over the stored hashed n-gram vectors. */
const VECTOR_MIN_COSINE = 0.2;
const RRF_K = 60;
// Local semantic scores are calibrated cosine similarities, not just ranks.
// Giving them more RRF weight keeps a noisy hashed collision from outranking a
// clear paraphrase hit; lexical and exact problemKey still win on exact text.
const RRF_WEIGHT = { lexical: 1, vector: 1, semantic: 2, graph: 0.5 };

async function vectorSearch(s, queryText, limit, scope, candidates = []) {
  const config = backendConfig();
  const terms = queryTerms(queryText);
  let dim = activeVectorDim();
  if (!dim && config.kind === 'remote') dim = await ensureRemoteDim(s);
  if (!dim) return [];
  let queryVector;
  try {
    if (config.kind === 'hashed') {
      queryVector = embedText(queryText);
    } else {
      const vectors = await embedRemote([queryText], config);
      queryVector = vectors[0];
    }
  } catch {
    return [];
  }
  if (![...queryVector].some(value => value !== 0)) return [];
  // A hashed n-gram model is not semantic: unrelated text can still produce a
  // small positive cosine by collision. Require one shared token for that
  // backend only; a real embedding model has no such limitation.
  const queryTokens = config.kind === 'hashed' ? new Set(tokenize(queryText)) : null;
  const specs = [
    { kind: 'note', table: 'notes', nulls: false, extra: 'AND t.superseded_by IS NULL' },
    { kind: 'fact', table: 'facts', nulls: true, extra: 'AND t.valid_to IS NULL' },
    { kind: 'chunk', table: 'chunks', nulls: true, extra: '' },
  ];
  const out = [];
  const candidateIds = new Map();
  for (const hit of candidates) {
    if (!hit || !hit.kind) continue;
    const list = candidateIds.get(hit.kind) ?? [];
    if (list.length < 400) list.push(Number(hit.id));
    candidateIds.set(hit.kind, list);
  }
  const collected = new Map();
  const sampleLimit = effectiveVectorSample(s.db);
  for (const spec of specs) {
    // Sample owner ids first: a JOIN with a scope filter does not stop at LIMIT
    // when the filter rejects the first rows, so a project-scoped search used to
    // read every vector in the table.
    const sampleIds = [];
    try {
      for (const row of prepareCached(s.db, `
        SELECT owner_id FROM vectors WHERE kind = ? AND dim = ?
        ORDER BY owner_id DESC LIMIT ?
      `).all(spec.kind, dim, sampleLimit)) sampleIds.push(Number(row.owner_id));
    } catch { /* no vectors */ }
    const candidateIdsForKind = (candidateIds.get(spec.kind) ?? []).filter(id => Number.isFinite(id) && id > 0);
    const ids = [...new Set([...sampleIds, ...candidateIdsForKind])];
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        for (const row of prepareCached(s.db, `
          SELECT v.owner_id AS owner_id, v.vec AS vec, t.*
          FROM vectors v JOIN ${spec.table} t ON t.id = v.owner_id
          WHERE v.kind = ? AND v.dim = ? AND v.owner_id IN (${placeholders})
            AND t.deleted_at IS NULL ${spec.extra}
        `).all(spec.kind, dim, ...chunk)) rows.push(row);
      } catch { /* skip chunk */ }
    }
    for (const row of rows) {
      if (!scopeAllows(row.scope, scope, spec.nulls)) continue;
      const key = `${spec.kind}:${row.owner_id}`;
      if (collected.has(key)) continue;
      collected.set(key, true);
      let score = 0;
      try { score = dot(queryVector, fromBlob(row.vec, dim)); } catch { continue; }
      if (!Number.isFinite(score) || score < VECTOR_MIN_COSINE) continue;
      if (queryTokens) {
        const documentTokens = tokenize(String(row.text ?? ''));
        if (!documentTokens.some(token => queryTokens.has(token))) continue;
      }
      out.push({
        kind: spec.kind,
        id: Number(row.owner_id),
        ts: Number(row.ts ?? row.valid_from ?? 0),
        scope: row.scope ?? null,
        text: String(row.text ?? ''),
        snippet: searchExcerpt(row.text, terms),
        matchedTerms: matchedTermsOf(row, ['text'], terms),
        source: row.source ?? '',
        ...(spec.kind === 'note' ? solutionFields(row) : {}),
        score,
        cosine: score,
        via: 'vector',
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** One constructor for every transport's search envelope. */
function buildSearchResult({ total = 0, returned = 0, offset = 0, truncated = false, scope = 'all', problemKey, hits = [] } = {}) {
  return {
    total: Number(total),
    returned: Number(returned),
    offset: Number(offset),
    truncated: Boolean(truncated),
    scope: scope ?? 'all',
    ...(problemKey ? { problemKey } : {}),
    hits: Array.isArray(hits) ? hits : [],
  };
}

/** Drop duplicate sentences across layers, keeping the best-scoring copy. */
function finalizeHits(ranked, limit) {
  // A transcript chunk is evidence, not the conclusion. When an accepted note
  // and its source chunk collapse to the same text, keep the note visible in
  // search instead of letting the raw chunk shadow it. Do not stop at `limit`:
  // count every unique candidate first, then return the requested window.
  const kindPriority = hit => hit.kind === 'note' ? 3 : hit.kind === 'fact' ? 2 : 1;
  const textKey = hit => String(hit.text).replace(/\s+/g, '').slice(0, 120);
  const byKey = new Map();
  for (const hit of ranked) {
    const key = textKey(hit);
    const existing = byKey.get(key);
    if (!existing || kindPriority(hit) > kindPriority(existing) || (kindPriority(hit) === kindPriority(existing) && Number(hit.score ?? 0) > Number(existing.score ?? 0))) {
      byKey.set(key, hit);
    }
  }
  const unique = [...byKey.values()].map(hit => {
    const boost = recencyBoost(hit.ts);
    const stale = staleVersionIn(hit.text);
    const score = Math.max(0, Number(hit.score ?? 0) + boost - (stale ? 0.02 : 0));
    return {
      ...hit,
      score,
      recencyBoost: Number(boost.toFixed(4)),
      ...(stale ? { staleVersion: stale } : {}),
      why: hitWhy({ ...hit, staleVersion: stale }),
    };
  }).sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  const total = unique.length;
  const hits = unique.slice(0, Math.max(1, Number(limit) || 8)).map(hit => ({
    ...hit,
    snippet: hit.snippet ?? searchExcerpt(hit.text, hit.matchedTerms ?? []),
  }));
  return { total, returned: hits.length, truncated: hits.length < total, hits };
}

/** Reciprocal rank fusion of the lexical and vector routes. */
const CONTRADICTION_COSINE = 0.9;const GRAPH_HOPS = 2;
const GRAPH_DECAY = 0.5;
const GRAPH_MAX_SEEDS = 6;
const ENTITY_CACHE_MS = 30_000;

/**
 * Mark near-duplicate or explicitly contradicted notes as contested.
 *
 * There is no model call here: an LLM judgement would add latency and cost to
 * every write, and a wrong silent merge is worse than a visible flag. The caller
 * can declare a contradiction explicitly (`contradicts`), and near-identical
 * text is flagged by cosine similarity for human review.
 */
function markContradictions(s, noteId, text, explicit, scope = null) {
  const ids = new Set();
  const scopeFilter = scope ? 'AND scope = ?' : '';
  const exists = prepareCached(s.db, `SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${scopeFilter}`);
  for (const value of Array.isArray(explicit) ? explicit : []) {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0 || id === noteId) continue;
    const row = scope ? exists.get(id, scope) : exists.get(id);
    if (!row) continue;
    ids.add(id);
  }
  try {
    const vector = embedText(text);
    const hashed = backendConfig().kind === 'hashed';
    let rows;
    if (hashed) {
      const aliasScope = scope ? 'AND n.scope = ?' : '';
      // The candidate's note vector is already stored by upsertVector before
      // this call. Re-tokenising 500 old notes on every write was the dominant
      // write cost; read their stored vectors instead and fall back only for
      // rows that have no compatible vector yet.
      rows = prepareCached(s.db, `
        SELECT n.id AS id, n.text AS text, v.vec AS vec
        FROM notes n
        LEFT JOIN vectors v
          ON v.kind = 'note' AND v.owner_id = n.id AND v.dim = ?
        WHERE n.deleted_at IS NULL AND n.superseded_by IS NULL
          AND n.contested = 0 AND n.id != ? ${aliasScope}
        ORDER BY n.ts DESC LIMIT 500
      `).all(DIM, noteId, ...(scope ? [scope] : []));
    } else {
      rows = prepareCached(s.db, `
        SELECT id, text FROM notes
        WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0 AND id != ? ${scopeFilter}
        ORDER BY ts DESC LIMIT 500
      `).all(...(scope ? [noteId, scope] : [noteId]));
    }
    for (const row of rows) {
      const id = Number(row.id);
      if (ids.has(id)) continue;
      const candidate = hashed && row.vec ? fromBlob(row.vec, DIM) : embedText(row.text);
      if (dot(vector, candidate) >= CONTRADICTION_COSINE) ids.add(id);
    }
  } catch { /* similarity flagging is best effort */ }
  if (ids.size) {
    const mark = prepareCached(s.db, 'UPDATE notes SET contested = 1 WHERE id = ? AND deleted_at IS NULL');
    for (const id of ids) mark.run(id);
    mark.run(noteId);
  }
  return [...ids];
}

function entityNames(s) {
  // `at: 0` means "never loaded": a zero timestamp must not pass the freshness
  // check, otherwise the empty initial list would be treated as a valid cache.
  if (entityCache.at > 0 && now() - entityCache.at < ENTITY_CACHE_MS) return entityCache.names;
  let names = [];
  try {
    names = prepareCached(s.db, 'SELECT name FROM entities LIMIT 5000').all()
      .map(row => String(row.name ?? ''))
      .filter(Boolean);
  } catch { names = []; }
  setEntityCache({ names, at: now() });
  return names;
}

/**
 * Graph route: weighted 2-hop expansion over entity edges (a PPR-lite).
 *
 * Seeds come from entities mentioned by the current best hits; neighbours get a
 * decayed weight, and only the *expanded* entities produce candidates, so the
 * route adds associations instead of repeating what lexical/vector already found.
 */
function graphExpand(s, hits, limit, scope) {
  if (process.env.OMNI_DISABLE_GRAPH === '1') return [];
  const names = entityNames(s);
  if (!names.length) return [];
  const seeds = new Set();
  for (const hit of hits.slice(0, GRAPH_MAX_SEEDS)) {
    const text = String(hit.text ?? '');
    for (const name of names) {
      if (text.includes(name)) seeds.add(name);
      if (seeds.size >= 8) break;
    }
    if (seeds.size >= 8) break;
  }
  if (!seeds.size) return [];

  const weights = new Map([...seeds].map(name => [name, 1]));
  const discovered = [];
  let frontier = [...seeds];
  for (let hop = 0; hop < GRAPH_HOPS && frontier.length; hop += 1) {
    const weight = GRAPH_DECAY ** (hop + 1);
    const next = [];
    for (const node of frontier) {
      let rows = [];
      const edgeScope = scopeClause('scope', scope);
      try {
        rows = prepareCached(s.db, `
          SELECT src, rel, dst FROM edges
          WHERE (src = ? OR dst = ?) AND (valid_to IS NULL OR valid_to > ?)
          ${edgeScope.sql}
          LIMIT 50
        `).all(node, node, now(), ...edgeScope.params);
      } catch { continue; }
      for (const row of rows) {
        const other = row.src === node ? row.dst : row.src;
        if (!other || weights.has(other)) continue;
        weights.set(other, weight);
        next.push(other);
        // The traversed edge is the association worth surfacing: querying a
        // concept should reveal the links that leave it, not unrelated facts
        // that merely mention the neighbour.
        discovered.push({
          subject: row.src,
          relation: row.rel,
          object: row.dst,
          weight,
        });
      }
    }
    frontier = next;
  }

  if (!discovered.length) return [];

  const out = [];
  const seen = new Set();
  const pushFact = (row, weight) => {
    const key = `fact:${row.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: 'fact',
      id: Number(row.id),
      ts: Number(row.valid_from),
      subject: row.subject,
      relation: row.relation,
      object: row.object,
      validFrom: Number(row.valid_from),
      validTo: row.valid_to === null ? null : Number(row.valid_to),
      contested: Number(row.contested ?? 0) === 1,
      source: row.source ?? '',
      text: String(row.text).slice(0, 400),
      score: weight,
      via: 'graph',
    });
  };

  discovered.sort((a, b) => b.weight - a.weight);
  for (const edge of discovered) {
    if (out.length >= limit) break;
    try {
      const row = prepareCached(s.db, `
        SELECT * FROM facts
        WHERE deleted_at IS NULL AND valid_to IS NULL
          AND subject = ? AND relation = ? AND object = ?
        ${scopeClause('scope', scope).sql}
        ORDER BY valid_from DESC LIMIT 1
      `).get(edge.subject, edge.relation, edge.object, ...scopeClause('scope', scope).params);
      if (row) pushFact(row, edge.weight);
    } catch { /* ignore */ }
  }
  return out.slice(0, limit);
}

let lastSearchProfile = null;

/**
 * Normalize a score vector to 0..1. A constant vector carries no ranking
 * signal and maps to 0.5; non-finite values are rejected by the caller.
 */
function normalizeScoreVector(values) {
  const numbers = values.map(value => Number(value));
  if (!numbers.length || !numbers.every(Number.isFinite)) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (max === min) return numbers.map(() => 0.5);
  return numbers.map(value => (value - min) / (max - min));
}

function compareRerankedHits(a, b) {
  // An exact problemKey hit is a hard priority, not a soft bonus: a paid
  // reranker must not bury the one note that matches the caller's problem.
  const exact = Number(Boolean(b.exactProblem)) - Number(Boolean(a.exactProblem));
  if (exact) return exact;
  return Number(b.score ?? 0) - Number(a.score ?? 0);
}

const MAX_RERANK_CANDIDATES = 20;

/**
 * Optional cross-encoder pass. No endpoint means no extra latency. Only the
 * top candidates are sent (cost bound), both score scales are normalized to
 * 0..1 before blending, and exact problemKey hits sort first regardless of the
 * reranker. Failure falls back to the original fused order.
 */
async function maybeRerank(query, ranked, limit, options = {}) {
  if (options.rerank === false) return ranked;
  const config = rerankConfig();
  if (config.kind !== 'remote' || ranked.length < 2) return ranked;
  const top = ranked.slice(0, MAX_RERANK_CANDIDATES);
  const rest = ranked.slice(MAX_RERANK_CANDIDATES);
  try {
    const scores = await rerankRemote(query, top.map(hit => String(hit.text ?? '')), config);
    if (!Array.isArray(scores) || scores.length !== top.length) return ranked;
    const finite = scores.map(value => Number(value)).filter(Number.isFinite);
    // All-zero or all-equal outputs mean the provider produced no ranking
    // signal; negative logits are valid and get normalized below.
    if (!finite.length || finite.every(value => value === finite[0]) || finite.every(value => value === 0)) return ranked;
    const rerankNorm = normalizeScoreVector(scores);
    const baseNorm = normalizeScoreVector(top.map(hit => Number(hit.score ?? 0)));
    if (!rerankNorm || !baseNorm) return ranked;
    const reranked = top.map((hit, index) => ({
      ...hit,
      rerankScore: Number((Number(scores[index] ?? 0)).toFixed(6)),
      score: Number((baseNorm[index] * 0.25 + rerankNorm[index] * 0.75 + (hit.exactProblem ? 0.25 : 0)).toFixed(6)),
    })).sort(compareRerankedHits);
    return [...reranked, ...rest].sort(compareRerankedHits);
  } catch {
    return ranked;
  }
}

async function runSearch(s, query, limit, scope, options = {}) {
  const terms = queryTerms(query);
  const status = options.status && options.status !== 'all' ? solutionStatusOf(options.status) : null;
  const kind = options.kind && options.kind !== 'all' ? String(options.kind) : null;
  const hitAllowed = hit => {
    if (!hit) return false;
    if (kind && hit.kind !== kind) return false;
    if (status) {
      if (hit.kind !== 'note') return false;
      return solutionStatusOf(hit.solutionStatus ?? hit.solution_status) === status;
    }
    return true;
  };
  const profile = process.env.OMNI_PROFILE === '1'
    ? { terms: terms.length, notes: 0, facts: 0, chunks: 0, lexical: 0, vector: 0, semantic: 0, graph: 0 }
    : null;
  const timed = async (key, fn) => {
    if (!profile) return fn();
    const started = process.hrtime.bigint();
    try {
      return await fn();
    } finally {
      profile[key] = Number(process.hrtime.bigint() - started) / 1e6;
    }
  };
  const notesHits = terms.length && (!kind || kind === 'note')
    ? await timed('notes', () => searchNotes(s, terms, limit, scope, { status }))
    : [];
  const factsHits = terms.length && (!kind || kind === 'fact') && !status
    ? await timed('facts', () => searchFacts(s, terms, limit, scope))
    : [];
  const chunksHits = terms.length && (!kind || kind === 'chunk') && !status
    ? await timed('chunks', () => searchChunks(s, terms, limit, scope))
    : [];
  const lexicalStarted = process.hrtime.bigint();
  const lexical = terms.length ? rank([...notesHits, ...factsHits, ...chunksHits].filter(hitAllowed)) : [];
  if (profile) profile.lexical = Number(process.hrtime.bigint() - lexicalStarted) / 1e6;
  // Diagnostic switch: OMNI_DISABLE_VECTOR=1 measures the lexical route alone
  // and also closes the semantic route (historical behaviour). OMNI_DISABLE_HASHED=1
  // closes only the hashed `vectors` route, so semantic quality can be measured
  // without the zero-config fallback.
  const vectorRoutes = process.env.OMNI_DISABLE_VECTOR !== '1';
  const hashedEnabled = vectorRoutes && process.env.OMNI_DISABLE_HASHED !== '1';
  if (vectorRoutes) await flushPendingVectors(s);
  const useSemantic = vectorRoutes && options.semantic !== false;
  // Semantic is the primary vector route. Hashed n-grams remain the fallback
  // for stores without the model, a failed model, or a query with no semantic
  // hit; they must not add a second noisy rank when semantic already answered.
  const semantic = useSemantic
    ? (await timed('semantic', () => semanticSearch(s, query, limit, scope, lexical))).filter(hitAllowed)
    : [];
  const vector = hashedEnabled && semantic.length === 0
    ? (await timed('vector', () => vectorSearch(s, query, limit, scope, [...lexical, ...semantic]))).filter(hitAllowed)
    : [];
  const graph = (await timed('graph', () => graphExpand(s, [...lexical, ...vector, ...semantic], Math.min(limit, 10), scope))).filter(hitAllowed);
  if (profile) {
    profile.hits = lexical.length + vector.length + semantic.length + graph.length;
    profile.at = now();
    lastSearchProfile = profile;
  }
  if (!vector.length && !semantic.length && !graph.length) {
    const ranked = await maybeRerank(query, lexical, limit, options);
    return finalizeHits(ranked, limit);
  }

  const fused = new Map();
  const add = (hit, index) => {
    const key = `${hit.kind}:${hit.id}`;
    const entry = fused.get(key) ?? { hit, rrf: 0, lexical: null, vector: null, semantic: null, graph: null };
    const weight = RRF_WEIGHT[hit.via] ?? RRF_WEIGHT.lexical;
    entry.rrf += weight / (RRF_K + index + 1);
    if (hit.via === 'semantic') {
      entry.semantic = hit.score;
      entry.hit = { ...entry.hit, semanticScore: hit.score };
    } else if (hit.via === 'vector') {
      entry.vector = hit.score;
      entry.hit = { ...entry.hit, vectorScore: hit.score };
    } else if (hit.via === 'graph') {
      entry.graph = hit.score;
      entry.hit = { ...entry.hit, graphScore: hit.score };
    } else {
      entry.lexical = hit.score;
      entry.hit = { ...entry.hit, lexicalScore: hit.score };
    }
    fused.set(key, entry);
  };
  lexical.forEach((hit, index) => add(hit, index));
  vector.forEach((hit, index) => add(hit, index));
  semantic.forEach((hit, index) => add(hit, index));
  graph.forEach((hit, index) => add(hit, index));

  const ranked = [...fused.values()]
    .map(entry => {
      const boost = entry.hit.kind === 'note'
        ? solutionBoost(entry.hit.solutionStatus, entry.hit.reuseCount)
        : 0;
      const exact = entry.hit.exactProblem ? 0.5 : 0;
      return {
        ...entry.hit,
        score: Number((entry.rrf + boost + exact).toFixed(6)),
        rrf: Number(entry.rrf.toFixed(6)),
        lexicalScore: entry.lexical,
        vectorScore: entry.vector,
        semanticScore: entry.semantic,
        graphScore: entry.graph,
      };
    })
    .sort((a, b) => b.score - a.score);
  const reranked = await maybeRerank(query, ranked, limit, options);
  return finalizeHits(reranked, limit);
}

/**
 * Compact facts block for the profile: active rows only, grouped by
 * subject+relation so multi-valued relations show all values. Returns plain
 * lines (callers add their own bullet prefix).
 */
export { recencyScore, queryTerms, likeClause, scopeClause, writeScopeForTool, auditCrossScope, matchRatio, matchedTermsOf, searchExcerpt, hitWhy, versionParts, compareVersionParts, staleVersionIn, recencyBoost, rank, SEARCH_WINDOW_DEFAULT, SEARCH_WINDOW_LARGE, VECTOR_SAMPLE_DEFAULT, VECTOR_SAMPLE_LARGE, MIN_LARGE_STORE_ROWS, LARGE_STORE_ROWS, ACTIVE_COUNT_TTL_MS, SEARCH_WINDOW_OVERRIDE, VECTOR_SAMPLE_OVERRIDE, FTS_SAMPLE, BIGRAM_SAMPLE, maxRowId, activeCountCache, activeRowCount, isLargeStore, effectiveSearchWindow, effectiveVectorSample, recentWindowRows, ftsRowIds, rowsByIds, normalizeEntity, canonicalEntity, linkEntity, relationCardinality, setRelationCardinality, scopeAllows, SOLUTION_STATUSES, normalizeProblemKey, solutionStatusOf, solutionBoost, solutionFields, feedbackFields, feedbackBoost, searchBigrams, searchChunks, searchNotes, searchProblemKey, searchFacts, textBlock, DREAM_SUPPORTED, DREAM_WEAK, DREAM_MAX_NOTES, DREAM_MAX_CHUNKS, dreamEvidence, coverageScore, dreamRun, dreamProposals, dreamReplace, dreamRollback, semanticSearch, VECTOR_MIN_COSINE, RRF_K, RRF_WEIGHT, vectorSearch, buildSearchResult, finalizeHits, CONTRADICTION_COSINE, GRAPH_DECAY, GRAPH_MAX_SEEDS, ENTITY_CACHE_MS, markContradictions, entityNames, graphExpand, lastSearchProfile, normalizeScoreVector, compareRerankedHits, MAX_RERANK_CANDIDATES, maybeRerank, runSearch };
