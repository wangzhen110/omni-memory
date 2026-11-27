// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Omni memory — host half.
 *
 * Design borrows the strongest idea from each existing system:
 *  - Anthropic: transcripts stay raw; notes are a separate, small, curated layer.
 *  - Zep/Graphiti: facts are bi-temporal. Contradiction invalidates, never deletes.
 *  - HippoRAG: entities and edges make associative recall possible.
 *  - solopup-memory: every note keeps a source pointer and a revision counter.
 *  - dsh-memento: forgetting is a tombstone, so history stays auditable.
 *
 * Retrieval fuses a lexical route (FTS5 trigram) with a vector route (hashed
 * character n-grams) using reciprocal rank fusion, the same shape Hindsight
 * uses. Nothing here touches an Agent, a Session projection, or the chat render
 * tree: preparing a live Session would blank the conversation, so this plugin
 * only reads/writes its own SQLite file.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './lib/embed.mjs';
import { backendConfig, embedRemote } from './lib/embed-provider.mjs';
import { extractCandidateTexts } from './lib/capture-rules.mjs';
import { rerankConfig, rerankRemote } from './lib/rerank-provider.mjs';
import { semanticConfig, embedSemantic } from './lib/semantic-embed.mjs';
import { createBaseSchema, createFtsTables } from './lib/schema.mjs';
import { checkForUpdate, formatUpdateNotice, readLocalVersion } from './lib/version-check.mjs';
import { bindRouteRuntime, registerRoutes } from './lib/read-routes.mjs';
import { bindToolRuntime, defineTools } from './lib/tool-definitions.mjs';
import { hostHeaderAllowed, isLoopback, mutationAllowed } from './hosts/shared/http-guard.mjs';

import { currentPackageVersion, DB_FILE, PROFILE_BUDGET, PROFILE_CACHE_MS, MAX_CAPTURE_CHARS, store, localToolDefinitions, HTTP_TOOL_ALLOWLIST, prepareCached, SCOPE_GLOBAL, cwdBySession, projectByAgent, projectKeyFromCwd, normalizeWorkspaceLabel, discoverWorkspaces, normalizeScopeInput, httpScope, decideScope, newScopeFlag, resolveProjectKey, ensureProjectAlias, lastJudge, pickJudgeRoute, enqueueJudge, currentProject, AUTO_RECALL_TTL_MS, lastUserByAgent, recallByAgent, lastInjection, autoRecallEnabled, now, hash, findNoteByTextIndex, openStore, hostCtx, CJK_BIGRAM, reindexBigrams, pendingVectors, vectorDropped, vectorLastDropAt, metaGet, metaSet, ensureRemoteDim, upsertVector, backfillRemoteBatch, flushPendingVectors, activeVectorDim, SEMANTIC_BATCH, SEMANTIC_MIN_COSINE, semanticState, noteSemanticFailure, clearSemanticFailure, releaseSemanticLease, dropDerivedIndexes, reindexRow, flushSemanticPending, semanticStatus, reindexSemantic, backfillVectors, transaction, acquireLease, releaseLease, forgetMemory, snapshotStore, exportBackup, importBackup, restoreMemory, insertChunk, ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, bindStoreRuntime, configureStore, setHostCtx, setLastInjection, closeStore, entityCache } from './lib/store.mjs';
export * from './lib/store.mjs';

configureStore(process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh'));

import { queryTerms, scopeClause, writeScopeForTool, auditCrossScope, rank, canonicalEntity, linkEntity, relationCardinality, setRelationCardinality, SOLUTION_STATUSES, normalizeProblemKey, solutionStatusOf, solutionFields, feedbackFields, searchProblemKey, textBlock, dreamRun, dreamProposals, dreamReplace, dreamRollback, buildSearchResult, markContradictions, lastSearchProfile, runSearch } from './lib/search.mjs';
export * from './lib/search.mjs';
import { bindSearchRuntime } from './lib/search.mjs';
import { personaGet, personaSet, personaRefresh, maybeRefreshPersona, personaLines, buildProfileText, PACKET_BUDGET, buildMemoryPacket, HOST_OPENAPI, cachedProfile, invalidateProfile, resetProfileCache } from './lib/profile.mjs';
export * from './lib/profile.mjs';
resetProfileCache();
function inboxText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/** Precompute recall for an incoming user message; never blocks the turn. */
async function precomputeRecall(agentId, text) {
  try {
    const project = projectByAgent.get(agentId) ?? SCOPE_GLOBAL;
    const result = await runSearch(openStore(), text, 3, project);
    // Dead ends and expired advice are useful when explicitly searched for, but
    // must not be injected as recommendations into the next turn.
    const hits = result.hits.filter(hit => hit.kind !== 'note'
      || !['failed', 'expired'].includes(String(hit.solutionStatus ?? 'unverified')));
    recallByAgent.set(agentId, { hits, query: text, at: now(), project });
  } catch { /* recall is best effort */ }
}

function projectForAgentId(agentId) {
  const id = String(agentId ?? '');
  if (!id) return null;
  const known = projectByAgent.get(id);
  if (known) return known;
  const cwd = cwdBySession.get(id);
  if (cwd) {
    try { return resolveProjectKey(openStore().db, cwd); } catch { /* fall through to persisted map */ }
  }
  // Survive a plugin reload: the mapping is persisted when it is learned.
  try {
    const stored = metaGet(openStore().db, `agent_project:${id}`);
    if (stored) {
      projectByAgent.set(id, stored);
      return stored;
    }
  } catch { /* store unavailable */ }
  return null;
}

/**
 * Resolve the project for one prompt assembly.
 *
 * `AssembleContext.scope` is an opaque ScopeKey. If it cannot be resolved, only
 * the global layer may be injected. The previous fallback to the last project
 * seen anywhere turned a concurrent or unknown session into a cross-project
 * leak, so it is deliberately gone.
 */
function projectForScope(scope) {
  const id = scope?.id ? String(scope.id) : '';
  if (!id) return null;
  const known = projectForAgentId(id);
  if (known) return known;
  const exact = cwdBySession.get(id);
  if (exact) {
    try {
      const project = resolveProjectKey(openStore().db, exact);
      if (project !== SCOPE_GLOBAL) return project;
    } catch { /* fall through to prefix matching */ }
  }
  // The host may hand over a truncated or opaque id (for example `session-b707`).
  // Match it only when both ids share at least 12 characters AND exactly one
  // captured session matches; an ambiguous prefix must fail closed instead of
  // guessing another project's layer.
  const matches = [];
  let db;
  try { db = openStore().db; } catch { db = undefined; }
  for (const [sessionId, cwd] of cwdBySession) {
    const common = Math.min(sessionId.length, id.length);
    if (common < 12) continue;
    if (!sessionId.startsWith(id) && !id.startsWith(sessionId)) continue;
    const project = db ? resolveProjectKey(db, cwd) : projectKeyFromCwd(cwd);
    if (project !== SCOPE_GLOBAL && !matches.includes(project)) matches.push(project);
  }
  return matches.length === 1 ? matches[0] : null;
}

function rememberUserMessage(agent, message) {
  try {
    const agentId = String(agent?.id ?? '');
    if (!agentId) return;
    const text = inboxText(message);
    if (!text) return;
    lastUserByAgent.set(agentId, { text, at: now() });
    const cwd = cwdBySession.get(agentId);
    if (cwd) {
      const db = openStore().db;
      const project = resolveProjectKey(db, cwd);
      projectByAgent.set(agentId, project);
      try { metaSet(db, `agent_project:${agentId}`, project); } catch { /* best effort */ }
    }
    if (!autoRecallEnabled()) return;
    void precomputeRecall(agentId, text);
  } catch { /* never break the loop */ }
}

function recallFor(scope) {
  if (!autoRecallEnabled()) return null;
  const agentId = String(scope?.id ?? '');
  if (!agentId) return null;
  const entry = recallByAgent.get(agentId);
  if (!entry) return null;
  if (now() - entry.at > AUTO_RECALL_TTL_MS) return null;
  const project = projectForScope({ id: agentId }) ?? SCOPE_GLOBAL;
  if (entry.project && entry.project !== project) return null;
  return entry;
}

function messageText(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim();
}

/**
 * Capture committed session events into the transcript layer. This listens to
 * the post-commit feed only: it never prepares a Session, never reads a
 * projection, and never blocks the turn.
 */
function captureEvent(session, event) {
  try {
    const type = String(event?.type ?? '');
    if (type !== 'user/message' && type !== 'assistant/message') return;
    const text = messageText(event.data);
    if (!text) return;
    const sessionId = String(session?.id ?? '');
    const scope = scopeForSession(session);
    const role = type === 'user/message' ? 'user' : 'assistant';
    const source = `session:${sessionId}#${String(event.seq ?? '')}`;
    if (scope && scope !== SCOPE_GLOBAL && sessionId) {
      try { metaSet(openStore().db, `agent_project:${sessionId}`, scope); } catch { /* best effort */ }
    }
    insertChunk(openStore(), {
      text: text.length > MAX_CAPTURE_CHARS ? text.slice(0, MAX_CAPTURE_CHARS) : text,
      role,
      ts: Number(event.time ?? now()),
      sessionId,
      source,
      importance: role === 'user' ? 0.6 : 0.4,
      scope,
    });
  } catch { /* capture must never break a turn */ }
}

/** Resolve (and remember) the project scope of a session from its workspace. */
function scopeForSession(session) {
  const sessionId = String(session?.id ?? '');
  const cwd = session?.header?.cwd;
  if (cwd) cwdBySession.set(sessionId, String(cwd));
  const known = cwdBySession.get(sessionId);
  if (!known) return SCOPE_GLOBAL;
  try {
    const db = openStore().db;
    ensureProjectAlias(db, known);
    return resolveProjectKey(db, known);
  } catch {
    return projectKeyFromCwd(known);
  }
}

/** Capture: transcript ingest, candidate review and consolidation. */

export const inject = ['tools'];

/** Whether the optional HTTP route surface has been attached yet. */
let routeState = { status: 'pending', count: 0, at: 0, error: null };

/** Read-only view of the optional route surface diagnostics (used by tests). */
export function routeStateSnapshot() {
  return { ...routeState };
}

function serviceFrom(ctx, name) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    } catch { /* service not ready */ }
  }
  return ctx[name];
}

/**
 * Register an optional service only when the host can provide it.
 *
 * Cordis hosts activate optional services (webServer, systemPrompt) after
 * plugins, so a one-shot `ctx.get()` races the service and silently drops the
 * route/profile surface. `ctx.inject([name], cb)` waits for the service. Hosts
 * without that API (the lightweight test/MCP shims) fall back to the old
 * immediate lookup.
 */
function registerWhenAvailable(ctx, name, register) {
  let dispose;
  let stopped = false;
  const started = Date.now();
  const timers = [];
  const debugEnabled = String(process.env.OMNI_ROUTE_DEBUG ?? '') === '1';
  const debug = message => {
    if (!debugEnabled) return;
    try {
      appendFileSync(
        path.join(process.env.TEMP || '.', 'omni-route-debug.log'),
        `${new Date().toISOString()} ${name}: ${message}\n`,
      );
    } catch { /* diagnostics must never break apply */ }
  };

  const attach = candidate => {
    if (stopped || typeof dispose === 'function') return true;
    let service;
    try {
      // Never read service members from the context proxy without injection:
      // Cordis guards those reads. A context exposes `get`; a service does not.
      service = (candidate && typeof candidate.get === 'function')
        ? serviceFrom(candidate, name)
        : candidate;
    } catch { return false; }
    if (!service) return false;
    try {
      const value = register(service);
      if (typeof value === 'function') {
        dispose = value;
        debug(`registered after ${Date.now() - started}ms`);
        return true;
      }
      debug('register returned no disposer');
    } catch (error) {
      debug(`register failed: ${error?.message ?? error}`);
    }
    return false;
  };

  // The service may already be active when the plugin is (re)loaded.
  attach(ctx);

  let off;
  if (typeof dispose !== 'function' && ctx && typeof ctx.inject === 'function') {
    try {
      off = ctx.inject([name], inner => {
        debug('inject fired');
        attach(inner);
      });
    } catch (error) {
      debug(`inject threw: ${error?.message ?? error}`);
    }
  }

  // Cold start: the host may activate the service well after this plugin.
  // Poll for up to a minute; the host is fully booted long before that and the
  // first successful attach stops the loop.
  const schedule = delay => {
    const timer = setTimeout(() => {
      if (stopped || typeof dispose === 'function') return;
      if (attach(ctx)) return;
      const elapsed = Date.now() - started;
      if (elapsed < 60_000) schedule(500);
      else debug(`gave up after ${elapsed}ms`);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    timers.push(timer);
  };
  if (typeof dispose !== 'function') {
    debug('not ready at apply; polling');
    schedule(250);
  }

  return () => {
    stopped = true;
    for (const timer of timers) {
      try { clearTimeout(timer); } catch { /* already gone */ }
    }
    try {
      if (typeof off === 'function') off();
      else off?.dispose?.();
    } catch { /* already gone */ }
    try { dispose?.(); } catch { /* already gone */ }
    dispose = undefined;
  };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Read a small JSON request body; never trusts its size or shape. */
function httpBodyError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// Exported so the strict/non-strict matrix can be unit tested without a socket.
export function readJsonBody(req, limit = 8192, options = {}) {
  const strict = options.strict === true;
  const allowMissing = options.allowMissing !== false;
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function' || req.complete === true || req.readable === false) {
      if (strict && !allowMissing) {
        reject(httpBodyError('body_unavailable', 'request body is not readable', 400));
      } else {
        resolve({});
      }
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (code, message, status = 400) => {
      if (settled) return;
      settled = true;
      if (strict) reject(httpBodyError(code, message, status));
      else resolve({});
    };
    const done = () => {
      if (settled) return;
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) {
        fail('body_empty', 'request body is empty', 400);
        return;
      }
      settled = true;
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        if (strict) reject(httpBodyError('body_invalid_json', 'request body must be valid JSON', 400));
        else resolve({});
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (strict) reject(httpBodyError('body_invalid_object', 'request body must be a JSON object', 400));
        else resolve({});
        return;
      }
      resolve(parsed);
    };
    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      size += buffer.length;
      if (size > limit) {
        fail('body_too_large', `request body exceeds ${limit} bytes`, 413);
        if (typeof req.resume === 'function') {
          try { req.resume(); } catch { /* best effort drain */ }
        }
      }
    });
    req.on('end', done);
    req.on('error', () => fail('body_unavailable', 'request body could not be read', 400));
  });
}

/**
 * Count rows into fixed weekly buckets. The cumulative baseline is the count
 * strictly before the first bucket, matching the in-memory implementation.
 */
function weeklyBuckets(s, table, column, active, params, startMs, weekMs, buckets) {
  const endMs = startMs + weekMs * buckets;
  const base = Number(prepareCached(s.db,
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${active} AND ${column} < ?`
  ).get(...params, startMs).n ?? 0);
  const values = Array(buckets).fill(0);
  const rows = prepareCached(s.db, `
    SELECT CAST((${column} - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS n
    FROM ${table}
    WHERE ${active} AND ${column} >= ? AND ${column} < ?
    GROUP BY bucket ORDER BY bucket
  `).all(startMs, weekMs, ...params, startMs, endMs);
  for (const row of rows) {
    const index = Number(row.bucket);
    if (index >= 0 && index < buckets) values[index] = Number(row.n);
  }
  return { values, base };
}

/** Per-local-day counts, using the same wall-clock day key as the UI heatmap. */
function dailyBuckets(s, table, column, active, params, dayStartMs, dayEndMs) {
  return prepareCached(s.db, `
    SELECT date(${column} / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
    FROM ${table}
    WHERE ${active} AND ${column} >= ? AND ${column} < ?
    GROUP BY day
  `).all(...params, dayStartMs, dayEndMs).map(row => [row.day, Number(row.n)]);
}

/** Packet, candidate queue, browser list, overview, graph and node. */
export function attachSession(sessionId, cwd) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  const raw = String(cwd ?? '').trim();
  let project = raw ? projectKeyFromCwd(raw) : SCOPE_GLOBAL;
  if (raw) cwdBySession.set(id, raw);
  try {
    const db = openStore().db;
    if (raw) {
      ensureProjectAlias(db, raw);
      project = resolveProjectKey(db, raw);
    }
    metaSet(db, `agent_project:${id}`, project);
  } catch { /* best effort */ }
  projectByAgent.set(id, project);
  return project;
}
bindStoreRuntime({
  scopeClause, relationCardinality, normalizeProblemKey, projectForScope, invalidateProfile,
});

bindSearchRuntime({ invalidateProfile });

bindRouteRuntime({
  DB_FILE, HOST_OPENAPI, HTTP_TOOL_ALLOWLIST, MAX_CAPTURE_CHARS, PACKET_BUDGET, SCOPE_GLOBAL,
  activeVectorDim, auditCrossScope, autoRecallEnabled, buildMemoryPacket, buildSearchResult,
  consolidateProblemNotes, currentPackageVersion, dailyBuckets, discoverWorkspaces, dreamProposals,
  dreamReplace, dreamRollback, forgetMemory, hash, httpScope, ingestTranscript, invalidateProfile,
  isLoopback, hostHeaderAllowed, json, listNoteCandidates, localToolDefinitions, metaSet, mutationAllowed,
  normalizeScopeInput, normalizeWorkspaceLabel, now, openStore, personaGet, personaRefresh, personaSet,
  prepareCached, pendingVectors, projectByAgent, queryTerms, readJsonBody, resolveProjectKey, restoreMemory,
  routeState, runSearch, scopeClause, semanticStatus, serviceFrom, snapshotStore, solutionStatusOf, weeklyBuckets,
  getStore: () => store,
  getLastInjection: () => lastInjection,
  getLastSearchProfile: () => lastSearchProfile,
  getLastJudge: () => lastJudge,
  getVectorDropped: () => vectorDropped,
  getVectorLastDropAt: () => vectorLastDropAt,
  getHostCtx: () => hostCtx,
});

bindToolRuntime({
  DB_FILE, PROFILE_BUDGET, SCOPE_GLOBAL, SOLUTION_STATUSES, auditCrossScope, backfillRemoteBatch,
  ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, backfillVectors, buildProfileText, buildSearchResult, canonicalEntity, currentProject, decideScope,
  dreamProposals, dreamReplace, dreamRollback, dreamRun, dropDerivedIndexes, enqueueJudge, ensureRemoteDim,
  entityCache, exportBackup, feedbackFields, findNoteByTextIndex, flushPendingVectors, forgetMemory, hash,
  importBackup, insertChunk, invalidateProfile, json, linkEntity, localToolDefinitions, markContradictions,
  maybeRefreshPersona, newScopeFlag, normalizeProblemKey, normalizeScopeInput, now, openStore, pendingVectors,
  personaGet, personaRefresh, personaSet, prepareCached, queryTerms, rank, reindexBigrams, reindexRow,
  reindexSemantic, relationCardinality, resolveProjectKey, restoreMemory, runSearch, scopeClause,
  searchProblemKey, setRelationCardinality, solutionFields, solutionStatusOf, textBlock, transaction,
  writeScopeForTool,
  getHostCtx: () => hostCtx,
});


export function apply(ctx) {
  setHostCtx(ctx);
  ctx.effect(() => {
    const disposers = defineTools(ctx);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  }, 'omni-memory: tools');

  ctx.effect(() => {
    return registerWhenAvailable(ctx, 'webServer', inner => {
      try {
        const dispose = registerRoutes(inner);
        // The prompt section reports `routes` as a diagnostic; it used to stay
        // 'pending' forever because nothing ever updated this record.
        routeState = { status: 'mounted', count: routeState.count + 1, at: Date.now(), error: null };
        return dispose;
      } catch (error) {
        routeState = {
          status: 'failed',
          count: routeState.count,
          at: Date.now(),
          error: String(error?.message ?? error),
        };
        throw error;
      }
    });
  }, 'omni-memory: routes');

  // Transcript capture: post-commit feed only. Reading a Session projection or
  // preparing one here would blank the live conversation.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('session/event', (session, event) => captureEvent(session, event));
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: capture');

  // Auto-recall input: capture the user message as it is claimed into a turn, so
  // the synchronous prompt provider has something to recall against.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return undefined;
    const dispose = ctx.on('agent/inbox/claimed', payload => {
      rememberUserMessage(payload?.agent, payload?.message);
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, 'omni-memory: auto recall');

  // Always-injected profile: a small, cached block of the strongest notes, plus
  // the precomputed recall for this request when the switch is on.
  ctx.effect(() => {
    return registerWhenAvailable(ctx, 'systemPrompt', inner => {
      const prompt = (inner && typeof inner.section === 'function')
        ? inner
        : serviceFrom(inner, 'systemPrompt');
      if (!prompt || typeof prompt.section !== 'function') return undefined;
      const dispose = prompt.section({
      name: 'omni-memory',
      order: 600,
      text: assemblyContext => {
        const project = projectForScope(assemblyContext?.scope);
        const lines = [];
        try {
          lines.push(...personaLines(openStore().db));
        } catch { /* persona is optional */ }
        const body = cachedProfile(project);
        if (body) {
          lines.push('Long-term memory from earlier sessions. It may be stale; confirm with memory_search before relying on it for a destructive or irreversible action.');
          lines.push(body);
        }
        if (project) {
          lines.push(`Current project scope: ${project}. Pass it as \`scope\` to memory_write/memory_search for project-only knowledge; omit it for cross-project rules.`);
        }
        const recalled = recallFor(assemblyContext?.scope);
        const safeHits = (recalled?.hits ?? []).filter(hit => !hit.contested && !hit.superseded_by);
        if (safeHits.length) {
          lines.push('Recalled for this request (ranked by the same hybrid search; verify before acting on it):');
          for (const hit of safeHits.slice(0, 3)) {
            lines.push(`- [${hit.kind}#${hit.id}] ${String(hit.text).replace(/\s+/g, ' ').slice(0, 180)}`);
          }
        }
        // The budget applies to the whole injected section, including the header,
        // project line and recalled hits -- not just the profile body.
        let text = lines.join('\n');
        if (text.length > PROFILE_BUDGET) {
          const withoutRecall = lines.filter(line => !line.startsWith('Recalled for this request') && !line.startsWith('- ['));
          text = withoutRecall.join('\n').slice(0, PROFILE_BUDGET);
        }
        setLastInjection({
          at: now(),
          chars: text.length,
          recall: safeHits.length,
          auto: autoRecallEnabled(),
          project: project ?? SCOPE_GLOBAL,
          // Diagnostics: whether the optional HTTP route surface was attached.
          routes: routeState.status,
          // Diagnostics: whether the assembly handed us a usable scope id at all.
          scopeId: assemblyContext?.scope?.id ? String(assemblyContext.scope.id).slice(0, 12) : null,
        });
        return text;
      },
    });
    return () => { try { dispose?.(); } catch { /* ignore */ } };
    });
  }, 'omni-memory: prompt section');

  // Optional offline consolidation. Off by default: a background verifier that
  // costs model calls or disk churn must be an explicit choice.
  ctx.effect(() => {
    const intervalMs = Number(process.env.OMNI_DREAM_INTERVAL_MS ?? 0);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof setInterval !== 'function') return undefined;
    const timer = setInterval(() => {
      try {
        const s = openStore();
        // Several hosts can run this timer at once. The lease makes it one
        // verification pass per interval across the whole machine instead of one
        // per open window.
        const dreamLease = acquireLease(s.db, 'dream', intervalMs);
        if (!dreamLease) return;
        try { dreamRun(s, true); } finally { releaseLease(s.db, 'dream', dreamLease); }
      } catch { /* never break the host */ }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'omni-memory: dream timer');

  ctx.effect(() => () => {
    if (store) releaseSemanticLease(store);
    closeStore();
  }, 'omni-memory: store');
}

