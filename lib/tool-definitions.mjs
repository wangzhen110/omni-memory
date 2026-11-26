// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import path from 'node:path';
import { backendConfig } from './embed-provider.mjs';
import { indexProject, projectContext, projectImpact, projectSearch, projectStatus } from './project-index.mjs';

/**
 * MCP/DSH tool definitions. The host half binds its runtime through
 * bindToolRuntime() before apply(), so this module stays acyclic.
 */
let DB_FILE, PROFILE_BUDGET, SCOPE_GLOBAL, SOLUTION_STATUSES, auditCrossScope, backfillRemoteBatch, ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, backfillVectors, buildProfileText, buildSearchResult, canonicalEntity, currentProject, decideScope, dreamProposals, dreamReplace, dreamRollback, dreamRun, dropDerivedIndexes, enqueueJudge, ensureRemoteDim, entityCache, exportBackup, feedbackFields, findNoteByTextIndex, flushPendingVectors, forgetMemory, hash, importBackup, insertChunk, invalidateProfile, json, linkEntity, localToolDefinitions, markContradictions, maybeRefreshPersona, newScopeFlag, normalizeProblemKey, normalizeScopeInput, now, openStore, pendingVectors, personaGet, personaRefresh, personaSet, prepareCached, queryTerms, rank, reindexBigrams, reindexRow, reindexSemantic, relationCardinality, resolveProjectKey, restoreMemory, runSearch, scopeClause, searchProblemKey, setRelationCardinality, solutionFields, solutionStatusOf, textBlock, transaction, writeScopeForTool;
let getHostCtx;

export function bindToolRuntime(deps) {
  ({
    DB_FILE, PROFILE_BUDGET, SCOPE_GLOBAL, SOLUTION_STATUSES, auditCrossScope, backfillRemoteBatch, ingestTranscript, listNoteCandidates, consolidateProblemNotes, reviewNoteCandidate, backfillVectors, buildProfileText, buildSearchResult, canonicalEntity, currentProject, decideScope, dreamProposals, dreamReplace, dreamRollback, dreamRun, dropDerivedIndexes, enqueueJudge, ensureRemoteDim, entityCache, exportBackup, feedbackFields, findNoteByTextIndex, flushPendingVectors, forgetMemory, hash, importBackup, insertChunk, invalidateProfile, json, linkEntity, localToolDefinitions, markContradictions, maybeRefreshPersona, newScopeFlag, normalizeProblemKey, normalizeScopeInput, now, openStore, pendingVectors, personaGet, personaRefresh, personaSet, prepareCached, queryTerms, rank, reindexBigrams, reindexRow, reindexSemantic, relationCardinality, resolveProjectKey, restoreMemory, runSearch, scopeClause, searchProblemKey, setRelationCardinality, solutionFields, solutionStatusOf, textBlock, transaction, writeScopeForTool,
    getHostCtx,
  } = deps);
}

function defineCaptureTools(ctx, registerLocalTool) {
  const disposers = [];

  disposers.push(registerLocalTool({
    name: 'memory_ingest',
    description: 'Ingest one user/assistant transcript turn from any host. Writes a transcript chunk and, by default, extracts at most three pending note candidates. It never writes a note directly; review candidates with memory_candidate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The transcript turn to store.' },
        role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool', 'note'], description: 'Speaker role; default user.' },
        source: { type: 'string', description: 'Optional provenance, e.g. session id plus turn.' },
        sessionId: { type: 'string', description: 'Optional host session id; also used to remember the project layer.' },
        cwd: { type: 'string', description: 'Working directory used to derive the project layer when scope is omitted.' },
        scope: { type: 'string', description: 'Explicit global/project key. scope=project means the current project; scope=all is rejected.' },
        importance: { type: 'number', description: '0..1 transcript weight (default 0.6 for user, 0.4 for assistant).' },
        extract: { type: 'boolean', description: 'Set false to store the transcript without creating candidates.' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'number' }, deduped: { type: 'boolean' }, scope: { type: 'string' }, sessionId: { type: 'string' }, chars: { type: 'number' }, truncated: { type: 'boolean' }, candidates: { type: 'array', items: {} } } },
      render: (_args, value) => textBlock(`ingested chunk #${value.id}${value.deduped ? ' (duplicate)' : ''} · ${value.candidates?.length ?? 0} candidate(s)`),
    },
    async execute(args, toolContext = {}) {
      return ingestTranscript(args, toolContext);
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_candidate',
    description: 'Review pending notes extracted from transcripts. action=list shows the queue; action=accept turns one candidate into a note; action=reject dismisses it. Acceptance never bypasses the normal note write path and keeps the chunk source.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'accept', 'reject'], description: 'Default list.' },
        id: { type: 'number', description: 'Candidate id for accept/reject.' },
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'all'], description: 'List filter; default pending.' },
        scope: { type: 'string', description: 'List/review visibility. Default current project + global; all requires explicit scope=all.' },
        cwd: { type: 'string', description: 'Derive the project layer from a working directory when scope is omitted.' },
        limit: { type: 'number', description: 'List size, 1..100 (default 20).' },
        reason: { type: 'string', description: 'Optional rejection reason.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { action: { type: 'string' }, total: { type: 'number' }, candidates: { type: 'array', items: {} }, noteId: { type: 'number' }, status: { type: 'string' } } },
      render: (_args, value) => value.action === 'list'
        ? textBlock(`${value.total} ${value.status} candidate(s)${value.candidates?.length ? ': ' + value.candidates.map(item => `#${item.id} ${String(item.text).slice(0, 100)}`).join(' | ') : ''}`)
        : textBlock(`${value.action} candidate #${value.id} -> ${value.status}${value.noteId ? ` (note #${value.noteId})` : ''}`),
    },
    async execute(args, toolContext = {}) {
      const action = String(args.action ?? 'list').trim().toLowerCase();
      if (action === 'list') return listNoteCandidates(args, toolContext);
      if (action === 'accept' || action === 'reject') {
        return reviewNoteCandidate(args.id, action, args, toolContext);
      }
      throw new Error('action must be list, accept or reject');
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_consolidate',
    description: 'Consolidate active notes sharing one problemKey into a source-linked summary. Dry-run by default; apply=true supersedes the inputs via superseded_by and preserves summed feedback counters.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        problemKey: { type: 'string', description: 'Stable problem fingerprint; matching is case-insensitive and whitespace-normalized.' },
        scope: { type: 'string', description: 'One exact scope: global or a project key. Defaults to the current project; all/project are rejected.' },
        minNotes: { type: 'number', description: 'Minimum active notes to consolidate, 2..10 (default 2).' },
        apply: { type: 'boolean', description: 'Write the summary and supersede inputs; default false (dry run).' },
      },
      required: ['problemKey'],
    },
    output: {
      schema: { type: 'object', properties: { problemKey: { type: 'string' }, scope: { type: 'string' }, applied: { type: 'boolean' }, notes: { type: 'number' }, noteId: { type: 'number' }, sourceIds: { type: 'array', items: { type: 'number' } }, summary: { type: 'string' }, reason: { type: 'string' } } },
      render: (_args, value) => textBlock(`${value.applied ? 'consolidated' : 'would consolidate'} ${value.notes} note(s)${value.noteId ? ` -> #${value.noteId}` : ''}${value.reason ? ` (${value.reason})` : ''}\n${String(value.summary ?? '').slice(0, 500)}`),
    },
    async execute(args, toolContext = {}) {
      return consolidateProblemNotes(args.problemKey, args, toolContext);
    },
  }));

  return disposers;
}

/** Write/read: durable writes, search, feedback and amendments. */
function defineWriteReadTools(ctx, registerLocalTool) {
  const disposers = [];

  disposers.push(registerLocalTool({
    name: 'memory_write',
    description: 'Store one durable memory. kind=note for conclusions, rules and problem-solving experience; kind=fact for subject/relation/object triples (text optional when the triple is complete); kind=episode for raw observations. Returns the stored id. For experience notes, set problemKey to the stable error signature and solutionStatus to what actually happened.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'episode'], description: 'Which layer to write.' },
        text: { type: 'string', description: 'The memory, stated so it is useful without the original conversation. Required for note and episode; optional for fact when the subject/relation/object triple is supplied. For a solution, include the symptom, what failed, what worked, and the preconditions.' },
        scope: {
          type: 'string',
          description: 'Optional. Omit to let the plugin judge: project-specific wording goes to the current project layer, cross-project rules to global. Pass a project key or global to override; all is read-only and rejected.',
        },
        importance: { type: 'number', description: '0..1 (default 0.35); higher survives prompt-budget trimming longer. Values outside 0..1 are rejected.' },
        source: { type: 'string', description: 'Where this came from, e.g. session id plus turn, or a file path.' },
        subject: { type: 'string', description: 'fact only: the entity.' },
        relation: { type: 'string', description: 'fact only: the predicate.' },
        object: { type: 'string', description: 'fact only: the value.' },
        cardinality: {
          type: 'string',
          enum: ['single', 'multi'],
          description: 'fact only: single (default) replaces the previous value; multi keeps several active values for the same subject+relation.',
        },
        contradicts: {
          type: 'array',
          items: { type: 'number' },
          description: 'note only: ids of earlier notes this one contradicts. Both sides are flagged contested for review; nothing is merged or deleted.',
        },
        problemKey: {
          type: 'string',
          description: 'note only: stable fingerprint for the problem, such as an error code plus the failing command or a short normalized symptom. Matching is case-insensitive and whitespace-normalized.',
        },
        solutionStatus: {
          type: 'string',
          enum: ['verified', 'unverified', 'failed', 'expired'],
          description: 'note only: real-world outcome. verified means the solution worked in practice; failed means a dead end worth remembering; expired means it no longer applies in the current environment.',
        },
        evidence: {
          type: 'string',
          description: 'note only: what proves the status, e.g. a command output, a test result, a URL, or a short verification note.',
        },
      },
      required: ['kind'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'number' }, kind: { type: 'string' }, deduped: { type: 'boolean' }, scopeNew: { type: 'boolean' }, contradictsIgnored: { type: 'array', items: {} } } },
      render: (_args, value) => {
      const layer = value.scope === 'global' ? 'global' : (value.scope ? 'project' : '');
      const detail = layer ? ` · ${layer}` : '';
      const reason = value.scopeReason && value.scopeReason !== 'explicit' ? ` (${value.scopeReason})` : '';
      return textBlock(`stored ${value.kind} #${value.id}${detail}${reason}${value.deduped ? ' (duplicate)' : ''}${value.scopeNew ? ' · new project scope' : ''}${value.contradictsIgnored?.length ? ` · ignored contradicts: ${value.contradictsIgnored.join(', ')}` : ''}`);
    },
    },
    async execute(args, toolContext = {}) {
      const s = openStore();
      const kind = String(args.kind ?? 'note').trim().toLowerCase();
      if (!['note', 'fact', 'episode'].includes(kind)) {
        throw new Error('kind must be note, fact, or episode');
      }
      const text = String(args.text ?? '').trim();
      let importance = 0.35;
      if (args.importance != null) {
        const value = Number(args.importance);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error('importance must be a number between 0 and 1');
        }
        importance = value;
      }
      if (kind === 'note' && text.length > 4000) {
        throw new Error(`note is ${text.length} characters; split it into smaller notes (max 4000)`);
      }
      const requestedStatus = args.solutionStatus == null ? null : String(args.solutionStatus).trim().toLowerCase();
      if (requestedStatus && !SOLUTION_STATUSES.has(requestedStatus)) {
        throw new Error('solutionStatus must be verified, unverified, failed, or expired');
      }
      if (kind !== 'note' && (args.problemKey || requestedStatus || args.evidence)) {
        throw new Error('problemKey, solutionStatus and evidence are note-only');
      }
      const problemKey = kind === 'note' ? normalizeProblemKey(args.problemKey) : '';
      const evidence = kind === 'note' ? String(args.evidence ?? '').trim() : '';
      const project = currentProject(toolContext);
      if (kind === 'fact') {
        const subject = canonicalEntity(s.db, args.subject ?? '');
        const relation = String(args.relation ?? 'is').trim();
        const object = String(args.object ?? args.text ?? '').trim();
        if (!subject) throw new Error('subject is required for kind=fact');
        const decision = decideScope(args.scope, text, project);
        const factScope = decision.scope;
        const factScopeNew = newScopeFlag(s.db, factScope);
        const requested = args.cardinality === 'single' || args.cardinality === 'multi' ? args.cardinality : null;
        const cardinality = requested ?? relationCardinality(s.db, relation);
        const ts = now();
        // Contradiction handling: same subject+relation in the same layer with a
        // different object is invalidated, not deleted. A project write must not
        // expire a global fact, and a global write must not expire project facts.
        const scopeFilter = factScope === SCOPE_GLOBAL
          ? "(scope = 'global' OR scope IS NULL)"
          : 'scope = ?';
        const result = transaction(s.db, () => {
          // Re-read under the write lock. Otherwise two hosts can both see "no
          // current value" and insert two active facts for a single-cardinality
          // relation -- a contradiction the store would then have to untangle.
          const current = prepareCached(s.db, `
            SELECT id, object, scope FROM facts
            WHERE subject = ? AND relation = ? AND valid_to IS NULL AND deleted_at IS NULL
              AND ${scopeFilter}
          `).all(subject, relation, ...(factScope === SCOPE_GLOBAL ? [] : [factScope]));
          if (requested) setRelationCardinality(s.db, relation, requested);
          const insertFact = () => {
            const factText = text || `${subject} ${relation} ${object}`;
            const info = prepareCached(s.db, `
              INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, scope, cardinality)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
            `).run(
              subject, relation, object, factText,
              ts, ts, 0.7, args.source ?? null, factScope, cardinality,
            );
            const factId = Number(info.lastInsertRowid);
            reindexRow(s, 'fact', factId, factText);
            prepareCached(s.db, 'INSERT OR IGNORE INTO entities(name) VALUES (?)').run(subject);
            if (object && object.length <= 80) prepareCached(s.db, 'INSERT OR IGNORE INTO entities(name) VALUES (?)').run(object);
            prepareCached(s.db, 'INSERT INTO edges(src, rel, dst, valid_from, scope, source) VALUES (?, ?, ?, ?, ?, ?)')
              .run(subject, relation, object, ts, factScope, args.source ?? null);
            return factId;
          };
          if (cardinality === 'multi') {
            // Several values may be true at once: keep siblings active, and treat
            // a repeated identical value as the same fact rather than a new one.
            const same = current.find(row => String(row.object ?? '') === object);
            if (same) {
              prepareCached(s.db, 'UPDATE facts SET recorded_at = ?, source = COALESCE(?, source) WHERE id = ?')
                .run(ts, args.source ?? null, Number(same.id));
              return { factId: Number(same.id), deduped: true, invalidated: 0 };
            }
            return { factId: insertFact(), deduped: false, invalidated: 0 };
          }
          for (const row of current) {
            prepareCached(s.db, 'UPDATE facts SET valid_to = ? WHERE id = ?').run(ts, Number(row.id));
            // Edges are the graph projection of a fact. If the fact stops being
            // current, the edge must stop being traversable too.
            prepareCached(s.db, `
              UPDATE edges SET valid_to = ?
              WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
                AND (scope = ? OR scope IS NULL)
            `).run(ts, subject, relation, String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL);
          }
          return { factId: insertFact(), deduped: false, invalidated: current.length };
        });
        entityCache = { names: [], at: 0 };
        invalidateProfile();
        maybeRefreshPersona(ctx);
        enqueueJudge(ctx, {
          kind: 'fact', table: 'facts', id: Number(result.factId),
          text: text || `${subject} ${relation} ${object}`,
          project, scope: factScope, confidence: decision.confidence, reason: decision.reason,
        });
        return {
          id: Number(result.factId),
          kind: 'fact',
          deduped: result.deduped,
          invalidated: result.invalidated,
          cardinality,
          scope: factScope,
          scopeReason: decision.reason,
          ...(factScopeNew ? { scopeNew: true } : {}),
        };
      }
      if (kind === 'episode') {
        const decision = decideScope(args.scope, text, project);
        const scopeNew = newScopeFlag(s.db, decision.scope);
        const row = insertChunk(s, {
          text, role: 'note', importance, source: args.source, sessionId: null,
          scope: decision.scope,
        });
        if (!row) throw new Error('text is required');
        invalidateProfile();
        enqueueJudge(ctx, {
          kind: 'episode', table: 'chunks', id: Number(row.id), text,
          project, scope: decision.scope, confidence: decision.confidence, reason: decision.reason,
        });
        return { id: row.id, kind: 'episode', deduped: row.deduped, scope: decision.scope, scopeReason: decision.reason, ...(scopeNew ? { scopeNew: true } : {}) };
      }
      const ts = now();
      const decision = decideScope(args.scope, text, project);
      const scope = decision.scope;
      const scopeNew = newScopeFlag(s.db, scope);
      if (!text.trim()) throw new Error('text is required');
      // Explicit ids that do not resolve are reported back instead of being
      // silently dropped: a bulk script must be able to see that it flagged
      // nothing.
      const invalidContradicts = [];
      for (const value of Array.isArray(args.contradicts) ? args.contradicts : []) {
        const id = Number(value);
        const ok = Number.isFinite(id) && id > 0 && id !== 0
          && prepareCached(s.db, 'SELECT id FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL AND scope = ?').get(id, scope);
        if (!ok) invalidContradicts.push(value);
      }
      // Scope is part of a note's identity: the same wording in two layers is two
      // deliberate records (a global rule and its project-specific restatement).
      const prev = findNoteByTextIndex(s.db, scope, text, 'AND deleted_at IS NULL AND superseded_by IS NULL');
      if (prev) {
        const updates = [];
        const values = [];
        if (problemKey) {
          updates.push('problem_key = ?');
          values.push(problemKey);
        }
        if (requestedStatus) {
          updates.push('solution_status = ?');
          values.push(requestedStatus);
          updates.push('solution_verified_at = ?');
          values.push(requestedStatus === 'verified' ? ts : null);
        }
        if (evidence) {
          updates.push('evidence = ?');
          values.push(evidence);
        }
        if (updates.length) {
          transaction(s.db, () => {
            prepareCached(s.db, `UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...values, Number(prev.id));
          });
          invalidateProfile();
        }
        return {
          id: Number(prev.id),
          kind: 'note',
          deduped: true,
          contradictsIgnored: invalidContradicts,
          scope,
          scopeReason: decision.reason,
          ...(scopeNew ? { scopeNew: true } : {}),
          problemKey: problemKey || prev.problem_key || null,
          solutionStatus: solutionStatusOf(requestedStatus ?? prev.solution_status),
          reuseCount: Number(prepareCached(s.db, 'SELECT reuse_count FROM notes WHERE id = ?').get(Number(prev.id))?.reuse_count ?? 0),
        };
      }
      const result = transaction(s.db, () => {
        // Re-check inside the write transaction. Two hosts can both miss the
        // earlier lookup and then queue up here; the loser of the race would
        // otherwise insert a second identical note.
        const raced = findNoteByTextIndex(s.db, scope, text, 'AND deleted_at IS NULL AND superseded_by IS NULL');
        if (raced) return { noteId: Number(raced.id), raced: true, contestedWith: [] };
        const info = prepareCached(s.db, `
          INSERT INTO notes(
            ts, scope, text, text_hash, importance, source, problem_key, solution_status,
            solution_verified_at, reuse_count, last_used_at, evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `).run(
          ts, scope, text, hash(text), importance, args.source ?? null,
          problemKey || null, requestedStatus,
          requestedStatus === 'verified' ? ts : null,
          evidence || null,
        );
        const noteId = Number(info.lastInsertRowid);
        reindexRow(s, 'note', noteId, text);
        const contestedWith = markContradictions(s, noteId, text, args.contradicts, scope);
        return { noteId, contestedWith };
      });
      if (result.raced) {
        // Another host won the race and wrote the same text first. Keep one
        // record, but still record the status/evidence this caller brought.
        const updates = [];
        const values = [];
        if (problemKey) { updates.push('problem_key = ?'); values.push(problemKey); }
        if (requestedStatus) {
          updates.push('solution_status = ?'); values.push(requestedStatus);
          updates.push('solution_verified_at = ?'); values.push(requestedStatus === 'verified' ? ts : null);
        }
        if (evidence) { updates.push('evidence = ?'); values.push(evidence); }
        if (updates.length) {
          transaction(s.db, () => {
            prepareCached(s.db, `UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...values, result.noteId);
          });
        }
        invalidateProfile();
        return {
          id: result.noteId,
          kind: 'note',
          deduped: true,
          contested: false,
          contestedWith: [],
          contradictsIgnored: invalidContradicts,
          scope,
          scopeReason: decision.reason,
          ...(scopeNew ? { scopeNew: true } : {}),
          problemKey: problemKey || null,
          solutionStatus: solutionStatusOf(requestedStatus),
          reuseCount: 0,
        };
      }
      invalidateProfile();
      enqueueJudge(ctx, {
        kind: 'note', table: 'notes', id: Number(result.noteId), text,
        project, scope, confidence: decision.confidence, reason: decision.reason,
      });
      return {
        id: Number(result.noteId),
        kind: 'note',
        deduped: false,
        contested: result.contestedWith.length > 0,
        contestedWith: result.contestedWith,
        contradictsIgnored: invalidContradicts,
        scope,
        scopeReason: decision.reason,
        ...(scopeNew ? { scopeNew: true } : {}),
        problemKey: problemKey || null,
        solutionStatus: solutionStatusOf(requestedStatus),
        reuseCount: 0,
      };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_search',
    description: "Recall stored notes, facts, transcripts and problem-solving experience. When blocked by an error or tool failure, search the exact problemKey first: verified solutions rank above unverified notes, while failed attempts stay visible but lower. Then widen to keywords or the web only if the stored experience is absent or weak.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, an entity, a file path, or a phrase from the original wording. Optional when problemKey is supplied.' },
        problemKey: {
          type: 'string',
          description: 'Exact normalized error signature, e.g. "EADDRINUSE: port 8000" or "npm test fails on node 22". Exact matches are returned first.',
        },
        status: {
          type: 'string',
          enum: ['all', 'verified', 'unverified', 'failed', 'expired'],
          description: 'Optional note status filter. all (default) keeps every layer; a concrete status restricts results to notes with that real-world outcome.',
        },
        kind: {
          type: 'string',
          enum: ['all', 'note', 'fact', 'chunk'],
          description: 'Optional layer filter: note, fact, chunk, or all (default).',
        },
        cwd: {
          type: 'string',
          description: 'Derive the project layer from a working directory when scope is omitted. CLI --dir uses this.',
        },
        limit: { type: 'number', description: 'Maximum hits, default 8, max 30.' },
        offset: { type: 'number', description: 'Skip this many ranked candidates before returning hits, 0..100 (default 0).' },
        semantic: {
          type: 'boolean',
          description: 'Set false to skip the bundled semantic model and use lexical + hashed-vector recall (CLI default for short-lived processes); MCP/HTTP default true.',
        },
        rerank: { type: 'boolean', description: 'Set false to skip the optional cross-encoder reranker (OMNI_RERANK_*); defaults to the configured provider.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when one is known.",
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'number' }, returned: { type: 'number' }, offset: { type: 'number' }, truncated: { type: 'boolean' }, scope: { type: 'string' }, problemKey: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.hits.length) return textBlock(`no memory matched (scope ${value.scope ?? 'all'})`);
        const total = Number(value.total ?? value.hits.length);
        const returned = Number(value.returned ?? value.hits.length);
        const offset = Number(value.offset ?? 0);
        const lines = value.hits.map((hit, index) => {
          const pointer = hit.source ? ` · ${hit.source}` : '';
          const flag = hit.contested ? ' · contested' : '';
          const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
          const solution = hit.solutionStatus && hit.solutionStatus !== 'unverified'
            ? ` · ${hit.solutionStatus}${hit.reuseCount ? ` ×${hit.reuseCount}` : ''}`
            : '';
          const problem = hit.problemKey ? ` · key: ${hit.problemKey}` : '';
          const feedback = (hit.usefulCount || hit.misleadingCount)
            ? ` · feedback +${hit.usefulCount ?? 0}/-${hit.misleadingCount ?? 0}`
            : '';
          const score = Number.isFinite(Number(hit.score)) ? ` · ${Number(hit.score).toFixed(3)}` : '';
          const why = hit.why ? ` · ${hit.why}` : '';
          const stale = hit.staleVersion ? ` · old:v${hit.staleVersion}` : '';
          const when = Number(hit.ts) ? ` · ${new Date(Number(hit.ts)).toISOString().slice(0, 10)}` : '';
          const body = String(hit.snippet ?? hit.text ?? '').replace(/\s+/g, ' ');
          return `${offset + index + 1}. [${hit.kind}#${hit.id}${layer}${flag}${solution}${problem}${feedback}${score}${stale}${when}${why}] ${body}${pointer}`;
        });
        return textBlock(`matched ${total} candidate(s) · showing ${returned}${offset ? ` from ${offset}` : ''} (scope ${value.scope ?? 'all'})\n${lines.join('\n')}`);
      },
    },
    async execute(args, toolContext = {}) {
      const s = openStore();
      let limit = 8;
      if (args.limit != null) {
        const value = Number(args.limit);
        if (!Number.isFinite(value) || value < 1 || value > 30) {
          throw new Error('limit must be a number between 1 and 30');
        }
        limit = Math.floor(value);
      }
      let offset = 0;
      if (args.offset != null) {
        const value = Number(args.offset);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw new Error('offset must be a number between 0 and 100');
        }
        offset = Math.floor(value);
      }
      const query = String(args.query ?? '');
      const problemKey = normalizeProblemKey(args.problemKey);
      const requestedStatus = String(args.status ?? 'all').trim().toLowerCase();
      if (!['all', ...SOLUTION_STATUSES].includes(requestedStatus)) {
        throw new Error('status must be all, verified, unverified, failed, or expired');
      }
      const requestedKind = String(args.kind ?? 'all').trim().toLowerCase();
      if (!['all', 'note', 'fact', 'chunk'].includes(requestedKind)) {
        throw new Error('kind must be all, note, fact, or chunk');
      }
      const requested = normalizeScopeInput(args.scope);
      // Retrieval judgement: an explicit request wins; otherwise scope to the
      // current project (plus the global layer), never to every project.
      const project = args.cwd ? resolveProjectKey(s.db, String(args.cwd)) : currentProject(toolContext);
      const scope = requested === 'all' ? null : (requested || project || SCOPE_GLOBAL);
      if (!queryTerms(query).length && !problemKey) {
        return buildSearchResult({ offset, scope: scope ?? 'all', hits: [] });
      }
      const poolLimit = Math.min(60, Math.max(limit + offset, limit * 3, 24));
      const exact = problemKey && (requestedKind === 'all' || requestedKind === 'note')
        ? searchProblemKey(s, problemKey, poolLimit, scope, { status: requestedStatus })
        : [];
      const result = queryTerms(query).length
        ? await runSearch(s, query, poolLimit, scope, { status: requestedStatus, kind: requestedKind, rerank: args.rerank, semantic: args.semantic !== false })
        : { total: 0, returned: 0, truncated: false, hits: [] };
      const merged = [];
      const seen = new Set();
      for (const hit of [...exact, ...result.hits]) {
        const key = `${hit.kind}:${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(hit);
      }
      const total = merged.length;
      const window = merged.slice(offset, offset + limit);
      return buildSearchResult({
        total,
        returned: window.length,
        offset,
        truncated: offset + window.length < total,
        scope: scope ?? 'all',
        problemKey,
        hits: window,
      });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_solution_report',
    description: 'Close the loop after trying a stored solution. success marks the note verified and increments its reuse count; failed records a dead end; expired marks it as no longer applicable. Call this after the result is known, not before.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'Note id returned by memory_write or memory_search.' },
        outcome: {
          type: 'string',
          enum: ['success', 'failed', 'expired'],
          description: 'success: the solution worked in practice; failed: it did not solve the problem; expired: it no longer applies in the current environment.',
        },
        evidence: {
          type: 'string',
          description: 'Optional: command output, test result, URL, or a short note showing why the outcome is credible.',
        },
      },
      required: ['id', 'outcome'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number' }, solutionStatus: { type: 'string' },
          reuseCount: { type: 'number' }, lastUsedAt: { type: 'number' },
        },
      },
      render: (_args, value) => textBlock(
        `solution #${value.id} -> ${value.solutionStatus} (reused ${value.reuseCount}×)`,
      ),
    },
    async execute(args = {}, toolContext = {}) {
      const id = Number(args.id);
      const outcome = String(args.outcome ?? '').trim().toLowerCase();
      if (!Number.isFinite(id) || id <= 0) throw new Error('id is required');
      if (!['success', 'failed', 'expired'].includes(outcome)) {
        throw new Error('outcome must be success, failed, or expired');
      }
      const s = openStore();
      const scope = writeScopeForTool(toolContext, args.scope);
      const filter = scopeClause('scope', scope);
      const note = prepareCached(s.db, `
        SELECT id, solution_status, reuse_count, problem_key
        FROM notes WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${filter.sql}
      `).get(id, ...filter.params);
      if (!note) throw new Error(`note ${id} not found, inactive, or outside the current project`);
      const ts = now();
      const status = outcome === 'success' ? 'verified' : outcome === 'failed' ? 'failed' : 'expired';
      transaction(s.db, () => {
        prepareCached(s.db, `
          UPDATE notes
          SET solution_status = ?, reuse_count = reuse_count + 1,
            last_used_at = ?, solution_verified_at = ?, evidence = COALESCE(?, evidence)
          WHERE id = ?
        `).run(status, ts, outcome === 'success' ? ts : null, String(args.evidence ?? '').trim() || null, id);
      });
      invalidateProfile();
      const updated = prepareCached(s.db, `
        SELECT solution_status, reuse_count, last_used_at, solution_verified_at
        FROM notes WHERE id = ?
      `).get(id);
      return {
        id,
        solutionStatus: solutionStatusOf(updated?.solution_status),
        reuseCount: Number(updated?.reuse_count ?? 0),
        lastUsedAt: updated?.last_used_at ?? ts,
        verifiedAt: updated?.solution_verified_at ?? null,
      };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_feedback',
    description: 'Record whether a recalled note or fact was useful or misleading. This is the quality signal for ranking: useful votes lift a memory, misleading votes push it down. Call it after actually using the memory and observing the outcome.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact'], description: 'Which memory type the id belongs to.' },
        id: { type: 'number', description: 'Id returned by memory_search or memory_get.' },
        rating: { type: 'string', enum: ['useful', 'misleading'], description: 'useful: it helped solve the task; misleading: it was stale, wrong, or sent you down a dead end.' },
        scope: { type: 'string', description: 'Omit for the current project plus global. Pass all only for an explicit cross-project audit.' },
      },
      required: ['kind', 'id', 'rating'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' }, id: { type: 'number' }, rating: { type: 'string' },
          usefulCount: { type: 'number' }, misleadingCount: { type: 'number' },
          feedbackCount: { type: 'number' }, lastFeedbackAt: { type: 'number' }, quality: { type: 'number' },
        },
      },
      render: (_args, value) => textBlock(
        `feedback ${value.kind}#${value.id} -> ${value.rating} (quality ${value.quality}; useful ${value.usefulCount}, misleading ${value.misleadingCount})`,
      ),
    },
    async execute(args = {}, toolContext = {}) {
      const kind = String(args.kind ?? '').trim().toLowerCase();
      if (kind !== 'note' && kind !== 'fact') throw new Error('kind must be note or fact');
      const id = Number(args.id);
      if (!Number.isFinite(id) || id <= 0) throw new Error('id is required');
      const rating = String(args.rating ?? '').trim().toLowerCase();
      if (rating !== 'useful' && rating !== 'misleading') throw new Error('rating must be useful or misleading');
      const requestedScope = args.scope;
      const scope = writeScopeForTool(toolContext, requestedScope, { allowAll: true });
      const s = openStore();
      if (scope === null) auditCrossScope(s.db, 'memory_feedback', id);
      const table = kind === 'note' ? 'notes' : 'facts';
      const activeSql = kind === 'fact' ? 'AND valid_to IS NULL' : 'AND superseded_by IS NULL';
      const filter = scopeClause('scope', scope);
      const row = prepareCached(s.db, `SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL ${activeSql} ${filter.sql}`).get(id, ...filter.params);
      if (!row) throw new Error(`${kind} ${id} not found, inactive, or outside the current project`);
      const ts = now();
      const useful = rating === 'useful' ? 1 : 0;
      const misleading = rating === 'misleading' ? 1 : 0;
      transaction(s.db, () => {
        prepareCached(s.db, `
          UPDATE ${table}
          SET recall_count = recall_count + 1, last_recall_at = ?,
            useful_count = useful_count + ?, misleading_count = misleading_count + ?
          WHERE id = ?
        `).run(ts, useful, misleading, id);
      });
      const updated = prepareCached(s.db, `
        SELECT recall_count, useful_count, misleading_count, last_recall_at FROM ${table} WHERE id = ?
      `).get(id);
      return {
        kind, id, rating,
        feedbackCount: Number(updated?.recall_count ?? 0),
        lastFeedbackAt: updated?.last_recall_at ?? null,
        usefulCount: Number(updated?.useful_count ?? 0),
        misleadingCount: Number(updated?.misleading_count ?? 0),
        quality: Number(feedbackFields(updated ?? {}).quality),
      };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_get',
    description: 'Progressive disclosure: fetch full records by id after memory_search returned a compact hit. Accepts up to 20 items. Scope defaults to the current project; pass all only when auditing across projects.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['note', 'fact', 'chunk'] },
              id: { type: 'number' },
            },
            required: ['kind', 'id'],
          },
        },
        scope: { type: 'string', description: 'Optional scope filter: a project key, global, project, or all. Defaults to the current project plus global.' },
      },
      required: ['items'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          missing: { type: 'array', items: { type: 'object' } },
          scope: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock(
        `loaded ${value.items.length} item(s)${value.missing.length ? `; missing ${value.missing.length}` : ''}\n`
        + value.items.map(item => `- [${item.kind}#${item.id}] ${String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 180)}`).join('\n'),
      ),
    },
    async execute(args = {}, toolContext = {}) {
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) throw new Error('items must contain at least one item');
      if (items.length > 20) throw new Error('items may contain at most 20 entries');
      const requested = normalizeScopeInput(args.scope);
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      const s = openStore();
      const loaded = [];
      const missing = [];
      for (const item of items) {
        const kind = String(item?.kind ?? '').trim().toLowerCase();
        const id = Number(item?.id);
        if (!['note', 'fact', 'chunk'].includes(kind) || !Number.isFinite(id) || id <= 0) {
          missing.push({ kind, id: Number.isFinite(id) ? id : null, reason: 'invalid item' });
          continue;
        }
        try {
          if (kind === 'note') {
            const filter = scopeClause('scope', scope, false);
            const row = prepareCached(s.db, `
              SELECT * FROM notes
              WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${filter.sql}
            `).get(id, ...filter.params);
            if (!row) { missing.push({ kind, id, reason: 'not active or out of scope' }); continue; }
            loaded.push({
              kind, id: Number(row.id), ts: Number(row.ts), scope: row.scope ?? 'global',
              text: String(row.text ?? ''), importance: Number(row.importance ?? 0.5),
              source: row.source ?? '', revision: Number(row.revision ?? 1),
              contested: Number(row.contested ?? 0) === 1,
              ...solutionFields(row), ...feedbackFields(row),
            });
          } else if (kind === 'fact') {
            const filter = scopeClause('scope', scope);
            const row = prepareCached(s.db, `
              SELECT * FROM facts
              WHERE id = ? AND deleted_at IS NULL AND valid_to IS NULL ${filter.sql}
            `).get(id, ...filter.params);
            if (!row) { missing.push({ kind, id, reason: 'not active or out of scope' }); continue; }
            loaded.push({
              kind, id: Number(row.id), ts: Number(row.valid_from), scope: row.scope ?? 'global',
              subject: row.subject, relation: row.relation, object: row.object,
              text: String(row.text ?? `${row.subject} ${row.relation} ${row.object}`),
              validFrom: Number(row.valid_from), validTo: row.valid_to === null ? null : Number(row.valid_to),
              confidence: Number(row.confidence ?? 0.7), source: row.source ?? '',
              contested: Number(row.contested ?? 0) === 1, ...feedbackFields(row),
            });
          } else {
            const filter = scopeClause('scope', scope);
            const row = prepareCached(s.db, `
              SELECT * FROM chunks
              WHERE id = ? AND deleted_at IS NULL ${filter.sql}
            `).get(id, ...filter.params);
            if (!row) { missing.push({ kind, id, reason: 'not active or out of scope' }); continue; }
            loaded.push({
              kind, id: Number(row.id), ts: Number(row.ts), scope: row.scope ?? null,
              role: row.role, sessionId: row.session_id ?? null, source: row.source ?? '',
              text: String(row.text ?? ''), importance: Number(row.importance ?? 0.5),
            });
          }
        } catch (error) {
          missing.push({ kind, id, reason: String(error?.message ?? error) });
        }
      }
      return { items: loaded, missing, scope: scope ?? 'all' };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_amend',
    description: 'Amend one note by creating a new revision. The old row is superseded, not deleted, so the revision chain remains auditable. Use this instead of write + contradicts + forget for a corrected note.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'Active note id to revise.' },
        text: { type: 'string', description: 'The complete corrected note text, max 4000 characters.' },
        reason: { type: 'string', description: 'Optional short reason for the amendment; stored as an [amend] entry in evidence.' },
        scope: { type: 'string', description: 'Omit for the current project plus global. Pass all only for an explicit cross-project audit.' },
      },
      required: ['id', 'text'],
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'number' }, revision: { type: 'number' }, superseded: { type: 'number' }, scope: { type: 'string' } } },
      render: (_args, value) => textBlock(`amended note #${value.superseded} -> #${value.id} (revision ${value.revision})`),
    },
    async execute(args = {}, toolContext = {}) {
      const id = Number(args.id);
      if (!Number.isFinite(id) || id <= 0) throw new Error('id is required');
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('text is required');
      if (text.length > 4000) throw new Error(`note is ${text.length} characters; split it into smaller notes (max 4000)`);
      const requestedScope = args.scope;
      const scope = writeScopeForTool(toolContext, requestedScope, { allowAll: true });
      const s = openStore();
      if (scope === null) auditCrossScope(s.db, 'memory_amend', id);
      const filter = scopeClause('scope', scope);
      const old = prepareCached(s.db, `
        SELECT * FROM notes
        WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${filter.sql}
      `).get(id, ...filter.params);
      if (!old) throw new Error(`note ${id} not found, inactive, or outside the current project`);
      if (String(old.text ?? '') === text) throw new Error('new text is identical to the current revision');
      const duplicate = findNoteByTextIndex(
        s.db, old.scope, text, 'AND deleted_at IS NULL AND superseded_by IS NULL AND id <> ?', [id],
      );
      if (duplicate) throw new Error(`an active note with the same text already exists: #${duplicate.id}`);
      const reason = String(args.reason ?? '').trim();
      const evidence = reason
        ? `${old.evidence ? `${old.evidence}\n` : ''}[amend] ${reason}`
        : (old.evidence ?? null);
      const ts = now();
      const result = transaction(s.db, () => {
        const info = prepareCached(s.db, `
          INSERT INTO notes(
            ts, scope, text, text_hash, importance, source, revision, contested,
            problem_key, solution_status, solution_verified_at, reuse_count, last_used_at, evidence,
            verification, verified_at, recall_count, last_recall_at, useful_count, misleading_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ts, old.scope, text, hash(text), Number(old.importance ?? 0.5), old.source ?? null,
          Number(old.revision ?? 1) + 1, Number(old.contested ?? 0),
          old.problem_key ?? null, old.solution_status ?? null, old.solution_verified_at ?? null,
          Number(old.reuse_count ?? 0), old.last_used_at ?? null, evidence,
          old.verification ?? null, old.verified_at ?? null,
          Number(old.recall_count ?? 0), old.last_recall_at ?? null,
          Number(old.useful_count ?? 0), Number(old.misleading_count ?? 0),
        );
        const newId = Number(info.lastInsertRowid);
        prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?').run(newId, id);
        dropDerivedIndexes(s, 'note', id);
        reindexRow(s, 'note', newId, text);
        return newId;
      });
      invalidateProfile();
      return {
        id: Number(result),
        revision: Number(old.revision ?? 1) + 1,
        superseded: id,
        scope: old.scope,
      };
    },
  }));

  return disposers;
}

/** Maintenance: reindex, persona, graph links, backup and forgetting. */
function defineMaintenanceTools(ctx, registerLocalTool) {
  const disposers = [];

  disposers.push(registerLocalTool({
    name: 'memory_reindex',
    description: 'Rebuild derived indexes. Vectors: backfill for the active embedding backend (after switching OMNI_EMBED_URL/model or restoring an old database). semantic: backfill the bundled local semantic index. bigrams: rebuild the whole CJK two-character index in one call (a large legacy store otherwise needs many restarts).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Maximum rows to process this call, default 200, max 1000.' },
        bigrams: { type: 'boolean', description: 'true rebuilds the entire CJK bigram index (explicit, can take a while on large stores).' },
        vectors: { type: 'boolean', description: 'Also run the active hashed/remote vector backfill.' },
        semantic: { type: 'boolean', description: 'true backfills the bundled local semantic index (BGE-small-zh int8, no model download).' },
        semanticForce: { type: 'boolean', description: 'With semantic: true, delete the current model signature first and rebuild it from source text (repairs stale vectors).' },
      },
    },
    output: {
      schema: { type: 'object', properties: { processed: { type: 'number' }, queued: { type: 'number' }, backend: { type: 'string' }, bigrams: { type: 'object' }, semantic: { type: 'object' } } },
      render: (_args, value) => textBlock(`reindexed ${value.processed} rows (${value.backend}${value.queued ? `, ${value.queued} queued` : ''})${value.semantic ? `; semantic ${value.semantic.processed ?? 0} (${value.semantic.enabled === false ? value.semantic.reason : value.semantic.model})` : ''}${value.bigrams ? `; bigrams ${value.bigrams.scanned} in ${value.bigrams.passes} pass(es)` : ''}`),
    },
    async execute(args = {}) {
      const s = openStore();
      const bigrams = args.bigrams === true ? reindexBigrams(s) : null;
      const config = backendConfig();
      const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 200)));
      const wantSemantic = args.semantic === true;
      const wantSemanticForce = args.semanticForce === true;
      if (wantSemanticForce && !wantSemantic) throw new Error('semanticForce requires semantic: true');
      const wantVectors = args.vectors === true || (args.semantic !== true && args.bigrams !== true);
      const semantic = wantSemantic ? await reindexSemantic(s, limit, { force: wantSemanticForce }) : null;
      if (!wantVectors) {
        return {
          processed: semantic?.processed ?? 0,
          queued: semantic?.pending ?? 0,
          backend: semantic?.enabled === false ? config.kind : 'local',
          bigrams,
          semantic,
        };
      }
      if (config.kind === 'hashed') {
        const before = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM vectors').get().n);
        backfillVectors(s.db, { limit });
        const after = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM vectors').get().n);
        return { processed: Math.max(0, after - before), queued: 0, backend: 'hashed', ...(bigrams ? { bigrams } : {}), ...(semantic ? { semantic } : {}) };
      }
      const dim = await ensureRemoteDim(s);
      if (!dim) throw new Error('remote embedding endpoint did not return a dimension');
      let processed = 0;
      while (processed < limit) {
        await backfillRemoteBatch(s);
        const before = pendingVectors.size;
        if (!before) break;
        await flushPendingVectors(s);
        const after = pendingVectors.size;
        if (after >= before) break;
        processed += before - after;
      }
      return { processed, queued: pendingVectors.size, backend: `remote:${dim}`, ...(bigrams ? { bigrams } : {}), ...(semantic ? { semantic } : {}) };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_persona',
    description: 'Read or write the long-lived user settings (name, personality, habits, preferences, custom fields). These are injected into the system prompt; values are plain text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'refresh'], description: 'get reads, set replaces, refresh synthesizes settings from recent global memory.' },
        values: {
          type: 'object',
          additionalProperties: true,
          description: 'set only: map of field -> text. Empty values are removed; total length is capped at 4000 characters.',
        },
        apply: { type: 'boolean', description: 'refresh only: false previews; true (default) writes the merged result. Unknown fields already in persona are preserved.' },
        useModel: { type: 'boolean', description: 'refresh only: true sends evidence to the host model for refinement; false (default) uses offline rules only.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { persona: { type: 'object' } } },
      render: (_args, value) => textBlock(
        Object.keys(value.persona).length
          ? Object.entries(value.persona).map(([key, text]) => `${key}：${text}`).join('\n')
          : 'no persona settings',
      ),
    },
    async execute(args = {}) {
      const s = openStore();
      if (String(args.action) === 'refresh') {
        return personaRefresh(getHostCtx(), {
          apply: args.apply !== false,
          model: args.useModel === true,
        });
      }
      if (String(args.action) === 'set') {
        if (!args.values || typeof args.values !== 'object') throw new Error('values is required for set');
        return { persona: personaSet(s.db, args.values) };
      }
      return { persona: personaGet(s.db) };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_link_entity',
    description: 'Register an entity alias and merge existing facts/edges written under that alias into the canonical name. Dry run by default; apply=true rewrites the rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        alias: { type: 'string', description: 'The alternate spelling, e.g. "deploy" or "上线".' },
        canonical: { type: 'string', description: 'The canonical entity name to merge into.' },
        apply: { type: 'boolean', description: 'false (default) reports how many facts/edges would move; true rewrites them.' },
      },
      required: ['alias', 'canonical'],
    },
    output: {
      schema: { type: 'object', properties: { alias: { type: 'string' }, canonical: { type: 'string' }, affectedFacts: { type: 'number' }, affectedEdges: { type: 'number' }, applied: { type: 'boolean' } } },
      render: (_args, value) => textBlock(`${value.applied ? 'linked' : 'would link'} "${value.alias}" -> "${value.canonical}" (${value.affectedFacts} facts, ${value.affectedEdges} edges)`),
    },
    async execute(args = {}) {
      return linkEntity(openStore(), args.alias, args.canonical, { apply: args.apply === true });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_export',
    description: 'Write a portable JSON backup (notes, facts, transcripts, edges, entities, relations, entity aliases, persona). Vectors are derived and excluded. Tombstones are included by default so a later restore can revive them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Backup file name (single basename, .json only) inside $OMNI_HOME/memory/backups. Defaults to a timestamped name; absolute paths and subdirectories are rejected.' },
        activeOnly: { type: 'boolean', description: 'true exports only live rows (no tombstones, superseded notes or expired facts).' },
      },
    },
    output: {
      schema: { type: 'object', properties: { path: { type: 'string' }, counts: { type: 'object' } } },
      render: (_args, value) => textBlock(`exported ${value.counts.notes} notes, ${value.counts.facts} facts, ${value.counts.chunks} transcripts -> ${value.path}`),
    },
    async execute(args = {}) {
      const s = openStore();
      return exportBackup(s, { path: args.path, audit: !args.activeOnly });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_import',
    description: 'Merge a JSON backup written by memory_export. Dry run by default: pass dryRun=false to write. Rows are deduplicated by content, not by id; vectors are rebuilt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Backup file name (single basename, .json only) inside $OMNI_HOME/memory/backups.' },
        dryRun: { type: 'boolean', description: 'true (default) reports what would be imported without writing.' },
      },
      required: ['path'],
    },
    output: {
      schema: { type: 'object', properties: { notes: { type: 'number' }, facts: { type: 'number' }, chunks: { type: 'number' }, edges: { type: 'number' }, relations: { type: 'number' }, entityAliases: { type: 'number' }, persona: { type: 'number' }, skipped: { type: 'number' }, dryRun: { type: 'boolean' } } },
      render: (_args, value) => textBlock(`${value.dryRun ? 'would import' : 'imported'} ${value.notes} notes, ${value.facts} facts, ${value.chunks} transcripts, ${value.edges} edges, ${value.relations} relations, ${value.entityAliases} aliases, ${value.persona} persona (skipped ${value.skipped})`),
    },
    async execute(args = {}) {
      const s = openStore();
      if (!args.path) throw new Error('path is required');
      return importBackup(s, { path: String(args.path), dryRun: args.dryRun !== false });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_restore',
    description: 'Revive one tombstoned memory (kind + id). Derived indexes are rebuilt; use the audit view to find deleted rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'chunk'], description: 'Which layer the row belongs to.' },
        id: { type: 'number', description: 'Row id from the audit view.' },
      },
      required: ['kind', 'id'],
    },
    output: {
      schema: { type: 'object', properties: { restored: { type: 'boolean' }, reason: { type: 'string' }, activeId: { type: 'number' } } },
      render: (_args, value) => textBlock(value.restored ? 'restored' : `nothing to restore${value.reason ? `: ${value.reason}` : ''}`),
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      return restoreMemory(s, String(args.kind), Number(args.id), writeScopeForTool(toolContext, args.scope));
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_forget',
    description: 'Tombstone one memory by kind and id. The row stays auditable; it stops appearing in recall and the profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['note', 'fact', 'chunk'] },
        id: { type: 'number' },
      },
      required: ['kind', 'id'],
    },
    output: {
      schema: { type: 'object', properties: { forgotten: { type: 'boolean' }, reason: { type: 'string' } } },
      render: (_args, value) => textBlock(value.forgotten ? 'tombstoned' : `nothing to forget${value.reason ? `: ${value.reason}` : ''}`),
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      const kind = String(args.kind);
      const id = Number(args.id);
      const forgotten = forgetMemory(s, kind, id, writeScopeForTool(toolContext, args.scope));
      invalidateProfile();
      return forgotten
        ? { forgotten: true }
        : { forgotten: false, reason: `no active ${kind} #${id}` };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_compact',
    description: 'Bound transcript growth by tombstoning the oldest chunks beyond a keep limit. Rows stay auditable and recoverable; the raw record is never destroyed. Dry run by default. Requires the host to have captured a transcript stream; under a plain MCP host with no sessions this is a no-op that reports total 0.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keepChunks: { type: 'number', description: 'How many newest chunks to keep. Default 5000, minimum 50.' },
        apply: { type: 'boolean', description: 'false (default) reports only; true tombstones the excess rows.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          excess: { type: 'number' },
          tombstoned: { type: 'number' },
          applied: { type: 'boolean' },
        },
      },
      render: (_args, value) => textBlock(
        `${value.applied ? 'applied' : 'dry-run'} · total ${value.total} · excess ${value.excess} · tombstoned ${value.tombstoned}`
      ),
    },
    async execute(args) {
      const s = openStore();
      const keep = Math.max(50, Number(args.keepChunks ?? 5000) || 5000);
      const apply = args.apply === true;
      const total = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM chunks WHERE deleted_at IS NULL').get().n);
      const excess = Math.max(0, total - keep);
      let tombstoned = 0;
      if (apply && excess > 0) {
        transaction(s.db, () => {
          const rows = prepareCached(s.db,
            'SELECT id FROM chunks WHERE deleted_at IS NULL ORDER BY ts ASC, id ASC LIMIT ?'
          ).all(excess);
          const stmt = prepareCached(s.db, 'UPDATE chunks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL');
          for (const row of rows) {
            const changed = Number(stmt.run(now(), Number(row.id)).changes);
            tombstoned += changed;
            if (changed > 0) dropDerivedIndexes(s, 'chunk', row.id);
          }
        });
      }
      return { total, excess, tombstoned, applied: apply };
    },
  }));

  return disposers;
}

/** Graph/dream: proposals, replace/rollback, profile, timeline and dream. */
function defineGraphTools(ctx, registerLocalTool) {
  const disposers = [];

  disposers.push(registerLocalTool({
    name: 'memory_dream_proposals',
    description: 'List replacement candidates produced by dream: flagged notes plus the evidence text that would replace them. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', description: 'Maximum proposals, default 50, max 200.' } },
    },
    output: {
      schema: { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.proposals.length) return textBlock('no replacement proposals');
        const lines = value.proposals.map(item => `#${item.noteId} [${item.verdict}] <- ${item.evidence}: ${item.proposedText.slice(0, 120)}`);
        return textBlock(`${value.proposals.length} proposal(s)\n${lines.join('\n')}`);
      },
    },
    async execute(args = {}) {
      return { proposals: dreamProposals(openStore(), args.limit) };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_dream_replace',
    description: 'Replace one flagged note with its evidence text. Requires confirm=true; the old note is superseded (kept for audit) and the replacement can be rolled back.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: { type: 'number', description: 'Note id from memory_dream_proposals.' },
        confirm: { type: 'boolean', description: 'Must be true; replacement is a semantic decision, not automatic.' },
      },
      required: ['noteId', 'confirm'],
    },
    output: {
      schema: { type: 'object', properties: { oldId: { type: 'number' }, replacementId: { type: 'number' } } },
      render: (_args, value) => textBlock(`replaced #${value.oldId} with #${value.replacementId} (rollback with memory_dream_rollback)`),
    },
    async execute(args = {}, toolContext = {}) {
      if (args.confirm !== true) throw new Error('confirm=true is required');
      return dreamReplace(openStore(), args.noteId, writeScopeForTool(toolContext, args.scope));
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_dream_rollback',
    description: 'Undo a dream replacement: revive the original note and tombstone the generated replacement. Only works on replacements created by memory_dream (source dream:<id>).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { noteId: { type: 'number', description: 'The original (superseded) note id.' } },
      required: ['noteId'],
    },
    output: {
      schema: { type: 'object', properties: { restored: { type: 'boolean' }, replacementId: { type: 'number' } } },
      render: (_args, value) => textBlock(value.restored ? `restored #${_args.noteId}` : `not rolled back: ${value.reason}`),
    },
    async execute(args = {}, toolContext = {}) {
      return dreamRollback(openStore(), args.noteId, writeScopeForTool(toolContext, args.scope));
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_profile',
    description: 'Read the hot memory profile: the highest-importance notes that fit the always-injected budget, plus store statistics. Scope defaults to the current project, or global when unknown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when known.",
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, stats: { type: 'object' } } },
      render: (_args, value) => textBlock(value.text || 'memory is empty'),
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      const requested = normalizeScopeInput(args.scope);
      const includeAll = requested === 'all';
      const projectKey = requested === 'all' || requested === 'global'
        ? null
        : (requested === 'project' ? currentProject(toolContext) : (requested || currentProject(toolContext))) || null;
      const text = buildProfileText(projectKey, { includeAll });
      const picked = text ? text.split('\n').filter(line => line.startsWith('- ')).length : 0;
      const count = table => Number(prepareCached(s.db, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n);
      const stats = {
        notes: count('notes'),
        facts: Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL').get().n),
        chunks: count('chunks'),
        db: path.basename(DB_FILE),
        fts: s.ftsMode,
      };
      return { text, stats, picked, budget: PROFILE_BUDGET };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_timeline',
    description: 'Show how knowledge about one entity changed over time: facts with their validity spans, plus notes that mention the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entity: { type: 'string', description: 'Subject or object name.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when known.",
        },
      },
      required: ['entity'],
    },
    output: {
      schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.entries.length) return textBlock('no entries for this entity');
        return textBlock(value.entries.map(entry => {
          if (entry.kind === 'note') {
            const date = new Date(entry.ts).toISOString().slice(0, 10);
            return `${date}  [note #${entry.id}] ${String(entry.text).replace(/\s+/g, ' ')}`;
          }
          const from = new Date(entry.validFrom).toISOString().slice(0, 10);
          const span = entry.validTo
            ? `${from} → ${new Date(entry.validTo).toISOString().slice(0, 10)}`
            : `${from} → now`;
          return `${span}  ${entry.subject} ${entry.relation} ${entry.object}`;
        }).join('\n'));
      },
    },
    async execute(args = {}, toolContext = {}) {
      const s = openStore();
      const rawName = String(args.entity ?? '').trim();
      if (!rawName) throw new Error('entity is required');
      // Facts are stored under their canonical subject; object values are not
      // canonicalised, so both spellings are matched.
      const name = canonicalEntity(s.db, rawName);
      const requested = normalizeScopeInput(args.scope);
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      const factFilter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };
      const noteFilter = scope ? scopeClause('scope', scope, false) : { sql: '', params: [] };
      const facts = prepareCached(s.db, `
        SELECT * FROM facts
        WHERE (subject = ? OR object LIKE ? OR object LIKE ?) AND deleted_at IS NULL ${factFilter.sql}
        ORDER BY valid_from ASC LIMIT 50
      `).all(name, `%${rawName}%`, `%${name}%`, ...factFilter.params).map(row => ({
        kind: 'fact',
        subject: row.subject,
        relation: row.relation,
        object: row.object,
        validFrom: Number(row.valid_from),
        validTo: row.valid_to === null ? null : Number(row.valid_to),
      }));
      const notes = prepareCached(s.db, `
        SELECT id, ts, text, scope FROM notes
        WHERE deleted_at IS NULL AND text LIKE ? ${noteFilter.sql}
        ORDER BY ts ASC LIMIT 30
      `).all(`%${name}%`, ...noteFilter.params).map(row => ({
        kind: 'note',
        id: Number(row.id),
        ts: Number(row.ts),
        scope: row.scope,
        text: String(row.text).slice(0, 200),
      }));
      const entries = [...facts, ...notes]
        .sort((a, b) => (a.validFrom ?? a.ts) - (b.validFrom ?? b.ts));
      return { entries };
    },
  }));

  disposers.push(registerLocalTool({
    name: 'memory_dream',
    description: 'Verify stored notes against the transcripts they came from. Dry run by default; apply=true records each verdict and flags unsupported notes as contested, but never replaces anything. commit=true (with apply) or memory_dream_replace performs a reversible replacement. Needs a captured session stream and an LLM; under a plain MCP host it reports no_source.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: { type: 'boolean', description: 'false (default) reports only; true writes verdicts and flags contested notes. It never replaces anything.' },
        commit: { type: 'boolean', description: 'Only with apply: also replace flagged notes with their evidence text. Off by default; replacement is reversible with memory_dream_rollback.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scanned: { type: 'number' },
          applied: { type: 'boolean' },
          actions: { type: 'array', items: { type: 'object' } },
        },
      },
      render: (_args, value) => {
        if (!value.scanned) return textBlock('no notes to verify');
        const counts = {};
        for (const action of value.actions) counts[action.verdict] = (counts[action.verdict] ?? 0) + 1;
        const summary = Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(' ');
        const flagged = value.actions
          .filter(action => ['unsupported', 'weak', 'contradicted'].includes(action.verdict))
          .slice(0, 10);
        const lines = flagged.map(action =>
          `- note#${action.noteId} ${action.verdict} (coverage ${action.score})${action.replacementId ? ` -> note#${action.replacementId}` : ''}`
        );
        return textBlock(`${value.applied ? 'applied' : 'dry-run'} · scanned ${value.scanned} · ${summary}${lines.length ? '\n' + lines.join('\n') : ''}`);
      },
    },
    async execute(args) {
      const s = openStore();
      return dreamRun(s, args.apply === true, { commit: args.commit === true });
    },
  }));

  return disposers;
}

function projectScopeFor(args = {}, toolContext = {}) {
  const explicit = normalizeScopeInput(args.scope);
  const project = currentProject(toolContext);
  if (explicit && explicit !== 'all' && explicit !== 'project') return explicit;
  if (explicit === 'project') return project || SCOPE_GLOBAL;
  const cwd = String(args.root ?? args.cwd ?? toolContext.cwd ?? '').trim();
  if (cwd) {
    try { return resolveProjectKey(openStore().db, cwd); } catch { /* fall through */ }
  }
  return project || SCOPE_GLOBAL;
}

function projectRootFor(args = {}, toolContext = {}) {
  return String(args.root ?? args.cwd ?? toolContext.cwd ?? process.cwd()).trim();
}

function projectSearchText(value) {
  const lines = [];
  if (value.modules.length) {
    lines.push('## 模块');
    for (const row of value.modules) lines.push(`- \`${row.key}\` ${row.name} — ${row.description || '(no summary)'}`);
  }
  if (value.symbols.length) {
    lines.push('## 符号');
    for (const row of value.symbols) lines.push(`- \`${row.path}:${row.line}\` ${row.kind} \`${row.qualifiedName}\`${row.signature ? ` ${row.signature}` : ''}${row.stale ? ' · stale' : ''}`);
  }
  if (value.apis.length) {
    lines.push('## API');
    for (const row of value.apis) lines.push(`- ${row.method} \`${row.route}\`${row.summary ? ` — ${row.summary}` : ''}${row.stale ? ' · stale' : ''} · ${row.path}:${row.line}`);
  }
  if (value.files.length) {
    lines.push('## 文件');
    for (const row of value.files) lines.push(`- \`${row.path}\` ${row.lang} · ${row.loc} loc${row.stale ? ' · stale' : ''}`);
  }
  if (!lines.length) lines.push(`未命中：${value.query || '(empty)'}`);
  return lines.join('\n');
}

function defineProjectTools(ctx, registerLocalTool) {
  const disposers = [];

  disposers.push(registerLocalTool({
    name: 'project_sync',
    description: 'Build or incrementally rebuild the derived code index for one project checkout. Stores paths, line numbers, signatures and API contracts only; never source bodies. Run this once per project, then use project_search/project_context/project_impact.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Project directory. Defaults to the host working directory.' },
        cwd: { type: 'string', description: 'Alias for root, used to resolve the project layer.' },
        scope: { type: 'string', description: 'Project layer; defaults to the layer derived from root/cwd.' },
        full: { type: 'boolean', description: 'Drop the previous cache for this scope and rescan everything.' },
        ctags: { type: 'boolean', description: 'Set false to skip optional universal-ctags enrichment.' },
        gitCommit: { type: 'string', description: 'Optional commit sha to stamp on scanned files.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, root: { type: 'string' }, scope: { type: 'string' }, files: { type: 'number' }, parsed: { type: 'number' }, unchanged: { type: 'number' }, removed: { type: 'number' }, symbols: { type: 'number' }, apis: { type: 'number' }, modules: { type: 'number' }, edges: { type: 'number' }, durationMs: { type: 'number' } } },
      render: (_args, value) => textBlock(`indexed ${value.files} files (${value.parsed} parsed, ${value.unchanged} unchanged, ${value.removed} removed) · ${value.modules} modules · ${value.symbols} symbols · ${value.apis} APIs · ${value.edges} edges · ${value.durationMs}ms`),
    },
    async execute(args = {}, toolContext = {}) {
      const root = projectRootFor(args, toolContext);
      const scope = projectScopeFor(args, toolContext);
      const report = indexProject(openStore().db, root, {
        scope, full: args.full === true, ctags: args.ctags !== false, gitCommit: args.gitCommit,
      });
      return report;
    },
  }));

  disposers.push(registerLocalTool({
    name: 'project_search',
    description: 'Exact-first search over the derived project index: modules, files, symbols, signatures and API routes. Fall back to memory_search for why/history/pitfalls. Every row carries sourceRef, line, sha and stale so the source file remains authoritative.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Symbol, module, path, route or API name.' },
        scope: { type: 'string', description: 'Project layer; defaults to the current/root project.' },
        root: { type: 'string', description: 'Project directory used to compute stale marks.' },
        kind: { type: 'string', description: 'all, symbol, api, module, file, or a symbol kind such as function/class.' },
        path: { type: 'string', description: 'Path substring filter.' },
        module: { type: 'string', description: 'Module key or name filter.' },
        method: { type: 'string', description: 'HTTP method filter for API results.' },
        limit: { type: 'number', description: 'Per-category result limit, max 80.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, query: { type: 'string' }, scope: { type: 'string' }, modules: { type: 'array', items: {} }, symbols: { type: 'array', items: {} }, apis: { type: 'array', items: {} }, files: { type: 'array', items: {} }, stale: { type: 'number' }, elapsedMs: { type: 'number' } } },
      render: (_args, value) => textBlock(projectSearchText(value)),
    },
    async execute(args = {}, toolContext = {}) {
      const scope = projectScopeFor(args, toolContext);
      return projectSearch(openStore().db, String(args.query ?? ''), {
        scope, root: projectRootFor(args, toolContext), kind: args.kind, path: args.path,
        module: args.module, method: args.method, limit: args.limit,
      });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'project_context',
    description: 'Return a bounded project packet for one module/symbol/file/route: module responsibility, signature, API contract, dependencies, tests and sourceRef/line/sha/stale. Use memory_search for the narrative why/history/pitfalls.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: 'module:key, code:path#Lx, spec:..., path, symbol name or HTTP route.' },
        scope: { type: 'string', description: 'Project layer.' },
        root: { type: 'string', description: 'Project directory used to compute stale marks.' },
        budget: { type: 'number', description: 'Character budget, default 1800, max 4000.' },
      },
      required: ['ref'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, refs: { type: 'array', items: {} }, stale: { type: 'number' }, chars: { type: 'number' } } },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args = {}, toolContext = {}) {
      const scope = projectScopeFor(args, toolContext);
      return projectContext(openStore().db, String(args.ref ?? ''), {
        scope, root: projectRootFor(args, toolContext), budget: args.budget,
      });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'project_status',
    description: 'Show index coverage for one project: files, modules, symbols, APIs, edges, last index time and how many files drifted or disappeared since indexing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', description: 'Project layer.' },
        root: { type: 'string', description: 'Project directory; defaults to the root recorded at index time.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, scope: { type: 'string' }, root: { type: 'string' }, counts: { type: 'object' }, stale: { type: 'number' }, missing: { type: 'number' }, indexedAt: { type: ['number', 'null'] } } },
      render: (_args, value) => textBlock(`project ${value.scope} · ${value.counts.files} files · ${value.counts.modules} modules · ${value.counts.symbols} symbols · ${value.counts.apis} APIs · ${value.counts.edges} edges · stale ${value.stale} · missing ${value.missing}`),
    },
    async execute(args = {}, toolContext = {}) {
      return projectStatus(openStore().db, args.root ? projectRootFor(args, toolContext) : '', { scope: projectScopeFor(args, toolContext) });
    },
  }));

  disposers.push(registerLocalTool({
    name: 'project_impact',
    description: 'Blast-radius lookup for one module/file/symbol/route: reverse static imports, owning modules and related tests. The first version covers static import/test edges, not a runtime call graph.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: 'module:key, path, symbol name or HTTP route.' },
        scope: { type: 'string', description: 'Project layer.' },
        root: { type: 'string', description: 'Project directory used to compute stale marks.' },
        depth: { type: 'number', description: 'Reverse import depth, default 4, max 8.' },
      },
      required: ['ref'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, targets: { type: 'array', items: {} }, files: { type: 'array', items: {} }, modules: { type: 'array', items: {} }, importers: { type: 'array', items: {} }, tests: { type: 'array', items: {} }, stale: { type: 'number' } } },
      render: (_args, value) => textBlock(`impact ${value.ok ? 'ok' : 'not found'} · ${value.importers?.length ?? 0} importer(s) · ${value.tests?.length ?? 0} test(s)${value.importers?.length ? '\n- ' + value.importers.slice(0, 12).join('\n- ') : ''}`),
    },
    async execute(args = {}, toolContext = {}) {
      const scope = projectScopeFor(args, toolContext);
      return projectImpact(openStore().db, String(args.ref ?? ''), {
        scope, root: projectRootFor(args, toolContext), depth: args.depth,
      });
    },
  }));

  return disposers;
}

export function defineTools(ctx) {
  const disposers = [];

  const registerLocalTool = definition => {
    localToolDefinitions.set(definition.name, definition);
    const dispose = ctx.tools.register(definition);
    return () => {
      if (localToolDefinitions.get(definition.name) === definition) localToolDefinitions.delete(definition.name);
      if (typeof dispose === 'function') dispose();
    };
  };

  for (const group of [defineCaptureTools, defineWriteReadTools, defineMaintenanceTools, defineGraphTools, defineProjectTools]) {
    disposers.push(...group(ctx, registerLocalTool));
  }

  return disposers;
}
