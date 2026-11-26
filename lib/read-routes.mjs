// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
import path from 'node:path';
import { existsSync } from 'node:fs';
import { backendConfig } from './embed-provider.mjs';
import { indexProject, projectContext, projectImpact, projectSearch, projectStatus } from './project-index.mjs';
/**
 * Read/admin/write/persona HTTP routes. The route bodies live here; runtime
 * functions and mutable counters arrive through bindRouteRuntime() so this
 * module never imports the host half back (that would create a cycle).
 */
let DB_FILE, HOST_OPENAPI, HTTP_TOOL_ALLOWLIST, MAX_CAPTURE_CHARS, PACKET_BUDGET, SCOPE_GLOBAL, activeVectorDim, auditCrossScope, autoRecallEnabled, buildMemoryPacket, buildSearchResult, consolidateProblemNotes, currentPackageVersion, dailyBuckets, discoverWorkspaces, dreamProposals, dreamReplace, dreamRollback, forgetMemory, hash, hostHeaderAllowed, httpScope, ingestTranscript, invalidateProfile, isLoopback, json, listNoteCandidates, localToolDefinitions, metaSet, mutationAllowed, normalizeScopeInput, normalizeWorkspaceLabel, now, openStore, personaGet, personaRefresh, personaSet, prepareCached, pendingVectors, projectByAgent, queryTerms, readJsonBody, resolveProjectKey, restoreMemory, routeState, runSearch, scopeClause, semanticStatus, serviceFrom, snapshotStore, solutionStatusOf, weeklyBuckets;
let getStore, getLastInjection, getLastSearchProfile, getLastJudge, getVectorDropped, getVectorLastDropAt, getHostCtx;

export function bindRouteRuntime(deps) {
  ({
    DB_FILE, HOST_OPENAPI, HTTP_TOOL_ALLOWLIST, MAX_CAPTURE_CHARS, PACKET_BUDGET, SCOPE_GLOBAL, activeVectorDim, auditCrossScope, autoRecallEnabled, buildMemoryPacket, buildSearchResult, consolidateProblemNotes, currentPackageVersion, dailyBuckets, discoverWorkspaces, dreamProposals, dreamReplace, dreamRollback, forgetMemory, hash, hostHeaderAllowed, httpScope, ingestTranscript, invalidateProfile, isLoopback, json, listNoteCandidates, localToolDefinitions, metaSet, mutationAllowed, normalizeScopeInput, normalizeWorkspaceLabel, now, openStore, personaGet, personaRefresh, personaSet, prepareCached, pendingVectors, projectByAgent, queryTerms, readJsonBody, resolveProjectKey, restoreMemory, routeState, runSearch, scopeClause, semanticStatus, serviceFrom, snapshotStore, solutionStatusOf, weeklyBuckets,
    getStore, getLastInjection, getLastSearchProfile, getLastJudge, getVectorDropped, getVectorLastDropAt, getHostCtx,
  } = deps);
}

function registerReadRoutes(add) {
  add({
    kind: 'exact',
    path: '/omni-memory/packet',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        return json(res, 405, { ok: false, error: 'packet requires GET' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedScope = normalizeScopeInput(url.searchParams.get('scope'));
      const cwd = String(url.searchParams.get('cwd') ?? '').trim();
      const project = cwd ? resolveProjectKey(openStore().db, cwd) : SCOPE_GLOBAL;
      const scopeLabel = requestedScope || project;
      const scope = requestedScope === 'all' ? null : (requestedScope || project);
      const query = String(url.searchParams.get('q') ?? '').trim();
      const packet = await buildMemoryPacket(scope, query, {
        limit: Number(url.searchParams.get('limit') ?? 5),
        budget: Number(url.searchParams.get('budget') ?? PACKET_BUDGET),
      });
      const format = String(url.searchParams.get('format') ?? 'json').trim().toLowerCase();
      if (format === 'text') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(packet.text);
        return;
      }
      return json(res, 200, {
        ok: true,
        format: 'markdown',
        scope: scopeLabel,
        query,
        cwd: cwd || null,
        ...packet,
        generatedAt: now(),
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/candidates',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        return json(res, 405, { ok: false, error: 'candidates requires GET' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const sessionId = String(url.searchParams.get('sessionId') ?? '').trim() || null;
      try {
        const result = listNoteCandidates({
          status: url.searchParams.get('status') ?? 'pending',
          scope: url.searchParams.get('scope') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
          limit: url.searchParams.get('limit') ?? 20,
        }, { agent: { id: sessionId ?? undefined }, session: { id: sessionId ?? undefined } });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/list',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 40)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
      const scopeFilter = normalizeScopeInput(url.searchParams.get('scope') || 'all');
      // The working list shows live memory; `audit=1` keeps superseded notes and
      // expired facts browsable for review without mixing them into recall.
      const audit = String(url.searchParams.get('audit') ?? '') === '1';
      const noteActive = audit ? '' : 'AND superseded_by IS NULL';
      const factActive = audit ? '' : 'AND valid_to IS NULL';
      const deletedActive = audit ? '' : 'AND deleted_at IS NULL';
      // Layer filter: 'all' | 'global' | 'project' (any proj:*), or one exact key.
      let scopeSql = '';
      let scopeParams = [];
      if (scopeFilter === 'global') {
        scopeSql = "AND (scope = 'global' OR scope IS NULL)";
      } else if (scopeFilter === 'project') {
        scopeSql = "AND scope LIKE 'proj:%'";
      } else if (scopeFilter !== 'all') {
        scopeSql = "AND (scope = ? OR scope = 'global' OR scope IS NULL)";
        scopeParams = [scopeFilter];
      }
      const notes = prepareCached(s.db, `
        SELECT id, ts, scope, text, importance, source, revision, contested,
               superseded_by, verification, verified_at, evidence, deleted_at,
               problem_key, solution_status, solution_verified_at, reuse_count, last_used_at
        FROM notes WHERE 1 = 1 ${deletedActive} ${noteActive} ${scopeSql}
        ORDER BY importance DESC, ts DESC LIMIT ? OFFSET ?
      `).all(...scopeParams, limit, offset);
      const facts = prepareCached(s.db, `
        SELECT id, subject, relation, object, text, confidence, source,
               valid_from, valid_to, contested, scope, deleted_at
        FROM facts WHERE 1 = 1 ${deletedActive} ${factActive} ${scopeSql}
        ORDER BY valid_from DESC LIMIT ? OFFSET ?
      `).all(...scopeParams, limit, offset);
      const count = (table, extra = '', params = []) => Number(prepareCached(s.db,
        `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL ${extra}`
      ).get(...params).n);
      const totalNotes = count('notes', `${noteActive} ${scopeSql}`, scopeParams);
      const totalFacts = count('facts', `${factActive} ${scopeSql}`, scopeParams);
      const globalNotes = count('notes', "AND superseded_by IS NULL AND (scope = 'global' OR scope IS NULL)");
      const projectNotes = count('notes', "AND superseded_by IS NULL AND scope LIKE 'proj:%'");

      // Project overview: every project layer with what it actually holds. Notes
      // are model-written conclusions; transcripts are captured automatically, so
      // a project can have transcripts and no notes — the panel must show that.
      const projects = new Map();
      const bump = (scope, field, n, lastAt) => {
        const entry = projects.get(scope) ?? { scope, notes: 0, facts: 0, chunks: 0, lastAt: 0 };
        entry[field] = Number(n);
        entry.lastAt = Math.max(entry.lastAt, Number(lastAt ?? 0));
        projects.set(scope, entry);
      };
      for (const row of prepareCached(s.db,
        "SELECT scope, COUNT(*) AS n, MAX(ts) AS last FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'notes', row.n, row.last);
      for (const row of prepareCached(s.db,
        "SELECT scope, COUNT(*) AS n, MAX(valid_from) AS last FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'facts', row.n, row.last);
      for (const row of prepareCached(s.db,
        "SELECT scope, COUNT(*) AS n, MAX(ts) AS last FROM chunks WHERE deleted_at IS NULL AND scope LIKE 'proj:%' GROUP BY scope"
      ).all()) bump(row.scope, 'chunks', row.n, row.last);

      // Exact project view also lists its recent transcripts, so captured-but-not-
      // summarized work is visible instead of an empty list.
      let chunks = [];
      if (scopeFilter !== 'all' && scopeFilter !== 'global' && scopeFilter !== 'project') {
        chunks = prepareCached(s.db, `
          SELECT id, ts, role, source, text, deleted_at FROM chunks
          WHERE deleted_at IS NULL AND scope = ?
          ORDER BY ts DESC LIMIT 20
        `).all(scopeFilter).map(row => ({
          kind: 'chunk',
          id: Number(row.id),
          ts: Number(row.ts),
          role: row.role,
          source: row.source ?? '',
          text: String(row.text).slice(0, 300),
          deleted_at: row.deleted_at ?? null,
        }));
      }

      // Workspaces DSH knows but that hold no memories yet still belong in the
      // overview. Their folder names cannot be reversed into an exact scope key,
      // so they are listed as read-only placeholders (`empty: true`, no scope).
      const existingLabels = [...projects.keys()]
        .map(key => normalizeWorkspaceLabel(String(key).replace(/^proj:/, '').split('#')[0]))
        .filter(Boolean);
      const seenLabels = new Set(existingLabels);
      let emptyProjects = 0;
      for (const workspace of discoverWorkspaces()) {
        const normalized = workspace.normalized;
        if (!normalized || seenLabels.has(normalized)) continue;
        if (existingLabels.some(label => normalized.endsWith(label) || label.endsWith(normalized))) continue;
        seenLabels.add(normalized);
        projects.set(`workspace:${workspace.dir}`, {
          scope: '', label: workspace.label, notes: 0, facts: 0, chunks: 0, lastAt: 0, empty: true,
        });
        emptyProjects += 1;
      }

      const projectRows = [...projects.values()].sort((a, b) =>
        (b.lastAt - a.lastAt) || String(a.label ?? a.scope).localeCompare(String(b.label ?? b.scope)));

      return json(res, 200, {
        ok: true,
        db: path.basename(DB_FILE),
        fts: s.ftsMode,
        schema: s.schemaVersion,
        index: s.fts,
        page: {
          limit,
          offset,
          scope: scopeFilter,
          totalNotes,
          totalFacts,
          hasMoreNotes: offset + notes.length < totalNotes,
          hasMoreFacts: offset + facts.length < totalFacts,
        },
        stats: {
          notes: count('notes', 'AND superseded_by IS NULL'),
          facts: count('facts', 'AND valid_to IS NULL'),
          chunks: count('chunks'),
          globalNotes,
          projectNotes,
          contested: count('notes', 'AND contested = 1'),
          verified: count('notes', 'AND verification IS NOT NULL'),
          solutionsVerified: count('notes', "AND solution_status = 'verified'"),
          solutionsFailed: count('notes', "AND solution_status = 'failed'"),
        },
        projects: projectRows,
        projectTotal: projectRows.length,
        projectEmpty: emptyProjects,
        chunks,
        notes, facts,
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/overview',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const scope = normalizeScopeInput(url.searchParams.get('scope') || 'all');
      const range = ['4w', '6w', '12w', '26w'].includes(url.searchParams.get('range'))
        ? url.searchParams.get('range') : '12w';
      const buckets = Number(range.replace('w', ''));
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      const start = new Date(weekStart);
      start.setDate(start.getDate() - (buckets - 1) * 7);
      const startMs = start.getTime();
      const dayStart = new Date(today);
      dayStart.setDate(dayStart.getDate() - 83);

      const scopeFor = column => {
        if (scope === 'global') return { sql: `AND (${column} = 'global' OR ${column} IS NULL)`, params: [] };
        if (scope === 'project') return { sql: `AND (${column} LIKE 'proj:%' OR ${column} = 'project')`, params: [] };
        if (scope !== 'all') return { sql: `AND (${column} = ? OR ${column} = 'global' OR ${column} IS NULL)`, params: [scope] };
        return { sql: '', params: [] };
      };
      const noteScope = scopeFor('scope');
      const factScope = scopeFor('scope');
      const chunkScope = scopeFor('scope');
      const count = (sql, params = []) => Number(prepareCached(s.db, sql).get(...params).n ?? 0);
      const noteActive = `deleted_at IS NULL AND superseded_by IS NULL ${noteScope.sql}`;
      const factActive = `deleted_at IS NULL AND valid_to IS NULL ${factScope.sql}`;
      const chunkActive = `deleted_at IS NULL ${chunkScope.sql}`;

      const notesActive = count(`SELECT COUNT(*) AS n FROM notes WHERE ${noteActive}`, noteScope.params);
      const notesTotal = count(`SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL ${noteScope.sql}`, noteScope.params);
      const factsActive = count(`SELECT COUNT(*) AS n FROM facts WHERE ${factActive}`, factScope.params);
      const factsTotal = count(`SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL ${factScope.sql}`, factScope.params);
      const chunksActive = count(`SELECT COUNT(*) AS n FROM chunks WHERE ${chunkActive}`, chunkScope.params);
      const contestedNotes = count(`SELECT COUNT(*) AS n FROM notes WHERE ${noteActive} AND contested = 1`, noteScope.params);
      const contestedFacts = count(`SELECT COUNT(*) AS n FROM facts WHERE ${factActive} AND contested = 1`, factScope.params);
      const unverifiedNotes = count(`SELECT COUNT(*) AS n FROM notes WHERE ${noteActive} AND solution_status = 'unverified'`, noteScope.params);
      const pendingCandidates = count(`SELECT COUNT(*) AS n FROM note_candidates WHERE status = 'pending' ${noteScope.sql}`, noteScope.params);
      const supersededNotes = notesTotal - notesActive;
      const expiredFacts = factsTotal - factsActive;
      const invalid = supersededNotes + expiredFacts;
      const valid = Math.max(0, notesActive + factsActive - contestedNotes - contestedFacts - unverifiedNotes);
      const healthTotal = valid + contestedNotes + contestedFacts + unverifiedNotes + invalid;
      const healthScore = healthTotal ? Math.round(valid / healthTotal * 100) : 0;
      const pending = contestedNotes + contestedFacts + pendingCandidates + invalid;
      const globalNotes = count(`SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND (scope = 'global' OR scope IS NULL) ${noteScope.sql}`, noteScope.params);
      const projectNotes = count(`SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND (scope LIKE 'proj:%' OR scope = 'project') ${noteScope.sql}`, noteScope.params);

      const feedback = prepareCached(s.db, `
        SELECT SUM(recall_count) AS recall, SUM(useful_count) AS useful, SUM(misleading_count) AS misleading
        FROM notes WHERE ${noteActive}
      `).get(...noteScope.params);
      const factFeedback = prepareCached(s.db, `
        SELECT SUM(recall_count) AS recall, SUM(useful_count) AS useful, SUM(misleading_count) AS misleading
        FROM facts WHERE ${factActive}
      `).get(...factScope.params);
      const recallTotal = Number(feedback.recall ?? 0) + Number(factFeedback.recall ?? 0);
      const usefulCount = Number(feedback.useful ?? 0) + Number(factFeedback.useful ?? 0);
      const misleadingCount = Number(feedback.misleading ?? 0) + Number(factFeedback.misleading ?? 0);

      // Project overview: global plus every project layer that actually holds rows.
      const projects = new Map();
      const bump = (scopeKey, field, n, firstAt, lastAt) => {
        const key = scopeKey || 'global';
        const entry = projects.get(key) ?? {
          scope: key, notes: 0, facts: 0, chunks: 0, firstAt: 0, lastAt: 0, memoryFirstAt: 0, memoryLastAt: 0,
        };
        entry[field] = Number(n);
        const first = Number(firstAt ?? 0);
        const last = Number(lastAt ?? 0);
        if (last) entry.lastAt = Math.max(entry.lastAt, last);
        if (first && (!entry.firstAt || first < entry.firstAt)) entry.firstAt = first;
        if (field !== 'chunks') {
          if (last) entry.memoryLastAt = Math.max(entry.memoryLastAt, last);
          if (first && (!entry.memoryFirstAt || first < entry.memoryFirstAt)) entry.memoryFirstAt = first;
        }
        projects.set(key, entry);
      };
      for (const row of prepareCached(s.db,
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'notes', row.n, row.first, row.last);
      for (const row of prepareCached(s.db,
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n, MIN(valid_from) AS first, MAX(valid_from) AS last FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'facts', row.n, row.first, row.last);
      for (const row of prepareCached(s.db,
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM chunks WHERE deleted_at IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'chunks', row.n, row.first, row.last);
      const projectRows = [...projects.values()].map(entry => {
        const memory = entry.notes + entry.facts;
        const label = entry.scope === 'global' ? '全局记忆' : entry.scope === 'project' ? '未命名项目层' : String(entry.scope).replace(/^proj:/, '').split('#')[0];
        const status = memory === 0 && entry.chunks > 0 ? 'transcript'
          : entry.memoryLastAt >= now - 7 * 24 * 60 * 60 * 1000 ? 'active'
            : entry.memoryLastAt >= now - 30 * 24 * 60 * 60 * 1000 ? 'watch' : 'quiet';
        return { ...entry, memory, label, status };
      }).sort((a, b) => b.memory - a.memory || b.chunks - a.chunks || b.lastAt - a.lastAt);
      const visibleForScope = p => scope === 'global' ? p.scope === 'global'
        : scope === 'all' || scope === 'project' ? p.scope !== 'global'
          : p.scope === scope;
      const visibleProjectActive = scope === 'global' ? 0 : projectRows.filter(p => visibleForScope(p) && p.memory > 0).length;
      const visibleTranscriptProjects = scope === 'global' ? 0 : projectRows.filter(p => visibleForScope(p) && p.memory === 0 && p.chunks > 0).length;

      // Weekly series. Counts before the window become the cumulative baseline.
      const noteSeries = weeklyBuckets(s, 'notes', 'ts', noteActive, noteScope.params, startMs, weekMs, buckets);
      const factSeries = weeklyBuckets(s, 'facts', 'valid_from', factActive, factScope.params, startMs, weekMs, buckets);
      const chunkSeries = weeklyBuckets(s, 'chunks', 'ts', chunkActive, chunkScope.params, startMs, weekMs, buckets);
      const labels = Array.from({ length: buckets }, (_, i) => {
        const d = new Date(startMs);
        d.setDate(d.getDate() + i * 7);
        return `${d.getMonth() + 1}/${d.getDate()}`;
      });
      // Memory growth counts notes and facts only. Transcript chunks are storage
      // volume, not memories; including them would inflate the curve by orders of
      // magnitude and bury real note/fact activity.
      let cumulative = noteSeries.base + factSeries.base;
      const cumulativeSeries = noteSeries.values.map((n, i) => {
        cumulative += n + factSeries.values[i];
        return cumulative;
      });

      // Daily activity for the last 12 weeks (84 cells), same memory-only rule.
      const keyOf = d => {
        const date = new Date(d);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      };
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 84);
      const dailyCounts = new Map();
      for (const [day, n] of dailyBuckets(s, 'notes', 'ts', noteActive, noteScope.params, dayStart.getTime(), dayEnd.getTime())) {
        dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + n);
      }
      for (const [day, n] of dailyBuckets(s, 'facts', 'valid_from', factActive, factScope.params, dayStart.getTime(), dayEnd.getTime())) {
        dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + n);
      }
      const daily = Array.from({ length: 84 }, (_, i) => {
        const d = new Date(dayStart);
        d.setDate(d.getDate() + i);
        const date = keyOf(d);
        return { date, count: dailyCounts.get(date) ?? 0 };
      });

      // Recent activity across notes, facts and pending candidates.
      const recentNotes = prepareCached(s.db, `
        SELECT id, ts, scope, source, text FROM notes
        WHERE ${noteActive} ORDER BY ts DESC LIMIT 8
      `).all(...noteScope.params).map(row => ({
        id: Number(row.id), kind: 'note', ts: Number(row.ts), scope: row.scope ?? 'global',
        source: row.source ?? '', text: String(row.text).slice(0, 120),
      }));
      const recentFacts = prepareCached(s.db, `
        SELECT id, subject, relation, object, scope, valid_from FROM facts
        WHERE ${factActive} ORDER BY valid_from DESC LIMIT 4
      `).all(...factScope.params).map(row => ({
        id: Number(row.id), kind: 'fact', ts: Number(row.valid_from), scope: row.scope ?? 'global',
        source: '', text: `${row.subject} ${row.relation} ${row.object}`.slice(0, 120),
      }));
      const recentCandidates = prepareCached(s.db, `
        SELECT id, ts, scope, text FROM note_candidates
        WHERE status = 'pending' ${noteScope.sql} ORDER BY ts DESC LIMIT 4
      `).all(...noteScope.params).map(row => ({
        id: Number(row.id), kind: 'candidate', ts: Number(row.ts), scope: row.scope ?? 'global',
        source: '', text: String(row.text).slice(0, 120),
      }));
      const activity = [...recentNotes, ...recentFacts, ...recentCandidates]
        .sort((a, b) => b.ts - a.ts).slice(0, 8);

      // Persona: explicit key/value profile first, then preference-tagged global notes as signals.
      const personaRows = prepareCached(s.db,
        'SELECT key, value, updated_at FROM persona ORDER BY updated_at DESC'
      ).all();
      const persona = {};
      let personaUpdatedAt = 0;
      for (const row of personaRows) {
        persona[row.key] = row.value;
        personaUpdatedAt = Math.max(personaUpdatedAt, Number(row.updated_at ?? 0));
      }
      let signals = [];
      if (!personaRows.length) {
        signals = prepareCached(s.db, `
          SELECT id, ts, source, text FROM notes
          WHERE deleted_at IS NULL AND superseded_by IS NULL AND (scope = 'global' OR scope IS NULL)
            AND (source LIKE '%preference%' OR text LIKE '%用户偏好%')
          ORDER BY ts DESC LIMIT 5
        `).all().map(row => ({
          id: Number(row.id), ts: Number(row.ts), source: row.source ?? '', text: String(row.text).slice(0, 160),
        }));
      }

      // Graph summary: fact subject/relation/object is enough for the overview
      // constellation; the full graph route still owns the detailed map.
      const graphFacts = prepareCached(s.db, `
        SELECT subject, relation, object FROM facts
        WHERE deleted_at IS NULL AND valid_to IS NULL ${factScope.sql}
        ORDER BY confidence DESC, valid_from DESC LIMIT 60
      `).all(...factScope.params);
      const graphNodes = new Map();
      const graphLinks = [];
      for (const fact of graphFacts) {
        for (const name of [fact.subject, fact.object]) {
          if (name && !graphNodes.has(name)) graphNodes.set(name, { id: name, label: name, kind: 'entity', weight: 0 });
        }
        if (fact.subject && fact.object) {
          graphLinks.push({ source: fact.subject, target: fact.object, rel: fact.relation });
          if (graphNodes.has(fact.subject)) graphNodes.get(fact.subject).weight += 1;
          if (graphNodes.has(fact.object)) graphNodes.get(fact.object).weight += 1;
        }
      }
      const edgeCount = count('SELECT COUNT(*) AS n FROM edges WHERE valid_to IS NULL');
      const sourceNotes = count(
        `SELECT COUNT(*) AS n FROM notes WHERE ${noteActive} AND source IS NOT NULL AND source <> ''`,
        noteScope.params,
      );
      const sourceRate = notesActive ? Math.round(sourceNotes / notesActive * 1000) / 10 : null;
      const usefulRate = recallTotal ? Math.round(usefulCount / recallTotal * 1000) / 10 : null;
      const pendingBreakdown = {
        contestedNotes,
        contestedFacts,
        candidates: pendingCandidates,
        supersededNotes,
        expiredFacts,
        total: pending,
      };
      const factPerHundred = notesActive ? Math.round(factsActive / notesActive * 1000) / 10 : null;
      const graphDensity = graphNodes.size ? Math.round((graphLinks.length + edgeCount) / graphNodes.size * 100) / 100 : null;

      return json(res, 200, {
        ok: true,
        version: currentPackageVersion(),
        asOf: now,
        range,
        scope,
        stats: {
          notes: notesActive,
          facts: factsActive,
          chunks: chunksActive,
          projects: visibleProjectActive,
          transcriptProjects: visibleTranscriptProjects,
          globalNotes,
          projectNotes,
          contested: contestedNotes + contestedFacts,
          pending,
          pendingCandidates,
          pendingBreakdown,
          supersededNotes,
          expiredFacts,
          sourceNotes,
          sourceRate,
          recallTotal,
          usefulCount,
          misleadingCount,
          usefulRate,
          entities: graphNodes.size,
          relations: graphLinks.length + edgeCount,
          connections: graphLinks.length + edgeCount,
          coverage: {
            transcript: { chunks: chunksActive, projects: visibleTranscriptProjects },
            facts: { active: factsActive, perHundredNotes: factPerHundred },
            graph: { entities: graphNodes.size, relations: graphLinks.length + edgeCount, density: graphDensity },
            recall: { total: recallTotal, useful: usefulCount, misleading: misleadingCount, rate: usefulRate },
            source: { notes: sourceNotes, rate: sourceRate },
          },
        },
        health: {
          valid,
          contested: contestedNotes + contestedFacts,
          unverified: unverifiedNotes,
          invalid,
          total: healthTotal,
          score: healthScore,
        },
        series: {
          labels,
          notes: noteSeries.values,
          facts: factSeries.values,
          chunks: chunkSeries.values,
          base: noteSeries.base + factSeries.base,
          cumulative: cumulativeSeries,
        },
        daily,
        projects: projectRows,
        profile: { persona, updatedAt: personaUpdatedAt, signals },
        activity,
        graph: {
          nodes: [...graphNodes.values()],
          links: graphLinks,
          edges: edgeCount,
        },
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/graph',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requested = normalizeScopeInput(url.searchParams.get('scope') || 'global');

      // One map per layer: the global map and one per project. `all` merges them.
      const clause = requested === 'all'
        ? { sql: '', params: [] }
        : requested === 'project'
          ? { sql: "AND scope LIKE 'proj:%'", params: [] }
          : requested === 'global'
            ? { sql: "AND (scope = 'global' OR scope IS NULL)", params: [] }
            : { sql: 'AND scope = ?', params: [requested] };

      const nodes = new Map();
      const links = [];
      const addNode = (id, kind, label, weight, scope) => {
        if (!nodes.has(id)) nodes.set(id, { id, kind, label, weight, scope });
        return nodes.get(id);
      };

      // Facts become stars joined by their relation; scoped so a project map only
      // ever shows its own constellation.
      const facts = prepareCached(s.db, `
        SELECT subject, relation, object, scope FROM facts
        WHERE deleted_at IS NULL AND valid_to IS NULL ${clause.sql}
        ORDER BY confidence DESC, valid_from DESC LIMIT 500
      `).all(...clause.params);
      const degree = new Map();
      for (const fact of facts) {
        for (const name of [fact.subject, fact.object]) {
          if (!name) continue;
          degree.set(name, (degree.get(name) ?? 0) + 1);
        }
      }
      const keep = new Set([...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 220).map(([name]) => name));
      const layerScope = requested === 'all' ? 'global' : requested;
      for (const name of keep) {
        addNode(`e:${name}`, 'entity', name, Math.min(1, 0.35 + (degree.get(name) ?? 0) / 12), layerScope);
      }
      const seen = new Set();
      for (const fact of facts) {
        if (!keep.has(fact.subject) || !keep.has(fact.object)) continue;
        const key = `${fact.subject}|${fact.relation}|${fact.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: `e:${fact.subject}`, target: `e:${fact.object}`, rel: fact.relation });
      }

      // Notes are bright stars attached to the entities they mention.
      const notes = prepareCached(s.db, `
        SELECT id, text, scope, importance FROM notes
        WHERE deleted_at IS NULL AND superseded_by IS NULL ${clause.sql}
        ORDER BY importance DESC, ts DESC LIMIT 120
      `).all(...clause.params);
      for (const note of notes) {
        const id = `n:${note.id}`;
        addNode(id, 'note', String(note.text).slice(0, 30), Number(note.importance ?? 0.5), note.scope ?? 'global');
        for (const name of keep) {
          if (String(note.text).includes(name)) links.push({ source: id, target: `e:${name}`, rel: 'mentions' });
        }
      }

      // Layer directory for the map switcher.
      const scopes = new Map();
      const bump = (key, field, count) => {
        const entry = scopes.get(key) ?? { key, facts: 0, notes: 0 };
        entry[field] = Number(count);
        scopes.set(key, entry);
      };
      for (const row of prepareCached(s.db,
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'facts', row.n);
      for (const row of prepareCached(s.db,
        "SELECT COALESCE(scope, 'global') AS scope, COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL GROUP BY COALESCE(scope, 'global')"
      ).all()) bump(row.scope, 'notes', row.n);

      const directory = [...scopes.values()]
        .map(entry => ({
          key: entry.key,
          label: entry.key === 'global' ? 'global' : String(entry.key).replace(/^proj:/, '').split('#')[0],
          facts: entry.facts,
          notes: entry.notes,
        }))
        .sort((a, b) => (a.key === 'global' ? -1 : b.key === 'global' ? 1 : (b.facts + b.notes) - (a.facts + a.notes)));

      return json(res, 200, {
        ok: true,
        scope: requested,
        scopes: directory,
        nodes: [...nodes.values()],
        links,
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/node',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const node = String(url.searchParams.get('node') ?? '').trim();
      const { scope } = httpScope(url.searchParams.get('scope'));
      const noteFilter = scope ? scopeClause('scope', scope, false) : { sql: '', params: [] };
      const factFilter = scope ? scopeClause('scope', scope) : { sql: '', params: [] };

      if (node.startsWith('n:')) {
        const id = Number(node.slice(2));
        if (!Number.isFinite(id)) return json(res, 400, { ok: false });
        const row = prepareCached(s.db, `
          SELECT * FROM notes
          WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL ${noteFilter.sql}
        `).get(id, ...noteFilter.params);
        if (!row) return json(res, 404, { ok: false });
        return json(res, 200, {
          ok: true,
          node: {
            kind: 'note',
            id: row.id,
            text: row.text,
            scope: row.scope ?? 'global',
            importance: row.importance ?? 0.5,
            source: row.source ?? '',
            ts: row.ts ?? null,
            contested: Boolean(row.contested),
            verification: row.verification ?? null,
            verifiedAt: row.solution_verified_at ?? null,
            problemKey: row.problem_key ?? null,
            solutionStatus: solutionStatusOf(row.solution_status),
            reuseCount: Number(row.reuse_count ?? 0),
            lastUsedAt: row.last_used_at ?? null,
            evidence: row.evidence ?? null,
          },
        });
      }

      if (node.startsWith('e:')) {
        const name = node.slice(2).trim();
        if (!name) return json(res, 400, { ok: false });
        const facts = prepareCached(s.db, `
          SELECT subject, relation, object, scope, confidence, valid_from FROM facts
          WHERE deleted_at IS NULL AND valid_to IS NULL AND (subject = ? OR object = ?)
          ${factFilter.sql}
          ORDER BY confidence DESC, valid_from DESC LIMIT 40
        `).all(name, name, ...factFilter.params);
        return json(res, 200, { ok: true, node: { kind: 'entity', name, facts } });
      }

      return json(res, 400, { ok: false });
    },
  });
}

/** OpenAPI, status, search, export and dream review. */
function registerAdminRoutes(add) {
  add({
    kind: 'exact',
    path: '/omni-memory/openapi.json',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        return json(res, 405, { ok: false, error: 'openapi.json requires GET' });
      }
      return json(res, 200, HOST_OPENAPI);
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/status',
    handler: async (req, res) => {
      const s = openStore();
      const count = table => Number(prepareCached(s.db, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n);
      return json(res, 200, {
        ok: true,
        version: currentPackageVersion(),
        autoRecall: autoRecallEnabled(),
        lastInjection: getLastInjection(),
        routes: routeState,
        aliasRepair: s.aliasRepair,
        aliasMigration: s.aliasMigration,
        lastSearch: getLastSearchProfile(),
        lastJudge: getLastJudge(),
        embedding: {
          kind: backendConfig().kind,
          dim: activeVectorDim(),
          pending: pendingVectors.size,
          dropped: getVectorDropped(),
          lastDropAt: getVectorLastDropAt() || null,
        },
        semantic: semanticStatus(s),
        stats: {
          notes: count('notes'),
          facts: Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL').get().n),
          chunks: count('chunks'),
          contested: Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND contested = 1').get().n),
          verified: Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND verification IS NOT NULL').get().n),
        },
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/search',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const query = url.searchParams.get('q') ?? '';
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') ?? 30)));
      const requestedScope = url.searchParams.get('scope');
      const { requested, scope } = httpScope(requestedScope);
      if (!queryTerms(query).length) {
        return json(res, 200, { ok: true, ...buildSearchResult({ scope: requested || SCOPE_GLOBAL }) });
      }
      const rerank = url.searchParams.get('rerank') === '0' ? false : undefined;
      const result = await runSearch(s, query, limit, scope, { rerank });
      return json(res, 200, {
        ok: true,
        ...buildSearchResult({
          total: result.total,
          returned: result.returned,
          offset: 0,
          truncated: result.truncated,
          scope: requested || SCOPE_GLOBAL,
          hits: result.hits,
        }),
      });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/export',
    handler: async (req, res) => {
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const activeOnly = String(url.searchParams.get('activeOnly') ?? '') === '1';
      const snapshot = snapshotStore(s, { audit: !activeOnly });
      if (String(url.searchParams.get('download') ?? '') === '1') {
        const name = `omni-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        res.setHeader('content-disposition', `attachment; filename="${name}"`);
      }
      return json(res, 200, { ok: true, ...snapshot });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/proposals',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return json(res, 200, { ok: true, proposals: dreamProposals(openStore(), url.searchParams.get('limit')) });
    },
  });
}

/** Ingest, consolidation, candidate review and the tool bridge. */
function registerWriteRoutes(add) {
  add({
    kind: 'exact',
    path: '/omni-memory/ingest',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'ingest requires POST' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let body = {};
      try {
        // Capture text can be close to MAX_CAPTURE_CHARS; 4000 CJK characters
        // are ~12KB in UTF-8, so the old 8KB body cap rejected valid input.
        body = await readJsonBody(req, 64 * 1024, { strict: true });
      } catch (error) {
        if (error?.code === 'body_empty' && url.searchParams.get('text')) {
          body = {};
        } else {
          return json(res, error?.status === 413 ? 413 : 400, { ok: false, error: error?.message ?? 'invalid request body' });
        }
      }
      const text = String(url.searchParams.get('text') ?? body.text ?? '').trim();
      if (!text) return json(res, 400, { ok: false, error: 'text is required' });
      const sessionId = String(url.searchParams.get('sessionId') ?? body.sessionId ?? '').trim() || null;
      try {
        const result = ingestTranscript({
          text,
          role: url.searchParams.get('role') ?? body.role ?? 'user',
          source: url.searchParams.get('source') ?? body.source ?? undefined,
          sessionId,
          cwd: url.searchParams.get('cwd') ?? body.cwd ?? undefined,
          scope: url.searchParams.get('scope') ?? body.scope ?? undefined,
          importance: url.searchParams.get('importance') ?? body.importance ?? undefined,
          extract: url.searchParams.get('extract') ?? body.extract ?? '1',
        }, { agent: { id: sessionId ?? undefined }, session: { id: sessionId ?? undefined } });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/consolidate',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'consolidate requires POST' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readJsonBody(req);
      const problemKey = String(url.searchParams.get('problemKey') ?? body.problemKey ?? '').trim();
      const sessionId = String(url.searchParams.get('sessionId') ?? body.sessionId ?? '').trim() || null;
      try {
        const result = consolidateProblemNotes(problemKey, {
          scope: url.searchParams.get('scope') ?? body.scope ?? undefined,
          minNotes: url.searchParams.get('minNotes') ?? body.minNotes ?? 2,
          apply: url.searchParams.get('apply') === '1' || url.searchParams.get('apply') === 'true' || body.apply === true,
        }, { agent: { id: sessionId ?? undefined }, session: { id: sessionId ?? undefined } });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/candidate',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'candidate requires POST' });
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readJsonBody(req);
      const id = Number(url.searchParams.get('id') ?? body.id ?? 0);
      const action = String(url.searchParams.get('action') ?? body.action ?? '').trim();
      const sessionId = String(url.searchParams.get('sessionId') ?? body.sessionId ?? '').trim() || null;
      try {
        const result = reviewNoteCandidate(id, action, {
          scope: url.searchParams.get('scope') ?? body.scope ?? undefined,
          cwd: url.searchParams.get('cwd') ?? body.cwd ?? undefined,
          reason: url.searchParams.get('reason') ?? body.reason ?? undefined,
        }, { agent: { id: sessionId ?? undefined }, session: { id: sessionId ?? undefined } });
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/tool',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'tool requires POST' });
      }
      let body = {};
      try {
        body = await readJsonBody(req, 64 * 1024, { strict: true, allowMissing: false });
      } catch (error) {
        return json(res, error?.status === 413 ? 413 : 400, { ok: false, error: error?.message ?? 'invalid request body' });
      }
      const name = String(body.name ?? '').trim();
      if (!HTTP_TOOL_ALLOWLIST.has(name)) {
        return json(res, 400, { ok: false, error: `tool not allowed on the HTTP adapter: ${name || '(empty)'}` });
      }
      const definition = localToolDefinitions.get(name);
      if (!definition || typeof definition.execute !== 'function') {
        return json(res, 503, { ok: false, error: `tool unavailable: ${name}` });
      }
      const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? body.arguments
        : {};
      // The standalone HTTP adapter is not a DSH session, but it still serves
      // one workdir. Reuse the host context installed by bootHost() so an
      // omitted scope resolves to that project layer, not global. An explicit
      // `arguments.scope` still wins inside each tool.
      const host = typeof getHostCtx === 'function' ? getHostCtx() : null;
      const toolContext = host
        ? { agent: host.agent, session: host.session, scope: host.scope }
        : {};
      try {
        const value = await definition.execute(args, toolContext);
        let text = '';
        try {
          const rendered = typeof definition.output?.render === 'function' ? definition.output.render(args, value) : '';
          text = Array.isArray(rendered)
            ? rendered.map(block => String(block?.text ?? '')).join('\n')
            : String(rendered?.text ?? rendered ?? '');
        } catch { /* rendering is a convenience, not part of the result */ }
        return json(res, 200, { ok: true, name, value, text });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}

/** Persona, dream mutations, restore and forget. */
function registerPersonaRoutes(add) {
  add({
    kind: 'exact',
    path: '/omni-memory/persona',
    handler: async (req, res) => {
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'GET') return json(res, 200, { ok: true, persona: personaGet(s.db) });
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'persona requires GET or POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const queryValues = url.searchParams.get('values');
      const queryAction = String(url.searchParams.get('action') ?? '').trim().toLowerCase();
      let body = {};
      try {
        // Persona values are user-visible text; the old 8KB cap turned a normal
        // multi-field update into an empty body and then silently cleared it.
        body = await readJsonBody(req, 64 * 1024, {
          strict: true,
          allowMissing: Boolean(queryValues) || queryAction === 'clear',
        });
      } catch (error) {
        return json(res, error?.status === 413 ? 413 : 400, {
          ok: false, error: error?.message ?? 'values must be a JSON object',
        });
      }
      const action = queryAction || String(body?.action ?? '').trim().toLowerCase();
      if (action === 'clear') {
        return json(res, 200, { ok: true, persona: personaSet(s.db, {}) });
      }
      let values = body?.values ?? body;
      if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
        if (queryValues) {
          try {
            values = JSON.parse(queryValues);
          } catch {
            return json(res, 400, { ok: false, error: 'values must be a JSON object' });
          }
        }
      }
      if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
        return json(res, 400, { ok: false, error: 'values must be a non-empty JSON object; use action=clear to clear persona' });
      }
      try {
        return json(res, 200, { ok: true, persona: personaSet(s.db, values) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/persona/refresh',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'refresh requires POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const apply = String(url.searchParams.get('dryRun') ?? '') !== '1';
      const useModel = String(url.searchParams.get('model') ?? '') === '1';
      try {
        return json(res, 200, { ok: true, ...await personaRefresh(getHostCtx(), { apply, model: useModel }) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/replace',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'replace requires POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let noteId = Number(url.searchParams.get('noteId') ?? 0);
      let rawScope = normalizeScopeInput(url.searchParams.get('scope'));
      if (!noteId) {
        try {
          const body = await readJsonBody(req);
          noteId = Number(body.noteId ?? 0);
          rawScope = rawScope || normalizeScopeInput(body.scope);
        } catch { /* missing or consumed body: keep the query-string values */ }
      }
      if (!noteId) return json(res, 400, { ok: false, error: 'noteId required' });
      const s = openStore();
      const { requested, scope } = httpScope(rawScope);
      try {
        if (requested === 'all') auditCrossScope(s.db, 'http:dream/replace', noteId);
        return json(res, 200, { ok: true, ...dreamReplace(s, noteId, scope) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/rollback',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'rollback requires POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let noteId = Number(url.searchParams.get('noteId') ?? 0);
      let rawScope = normalizeScopeInput(url.searchParams.get('scope'));
      if (!noteId) {
        try {
          const body = await readJsonBody(req);
          noteId = Number(body.noteId ?? 0);
          rawScope = rawScope || normalizeScopeInput(body.scope);
        } catch { /* missing or consumed body: keep the query-string values */ }
      }
      if (!noteId) return json(res, 400, { ok: false, error: 'noteId required' });
      const s = openStore();
      const { requested, scope } = httpScope(rawScope);
      if (requested === 'all') auditCrossScope(s.db, 'http:dream/rollback', noteId);
      return json(res, 200, { ok: true, ...dreamRollback(s, noteId, scope) });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/restore',
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'restore requires POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let kind = String(url.searchParams.get('kind') ?? '');
      let id = Number(url.searchParams.get('id') ?? 0);
      let rawScope = normalizeScopeInput(url.searchParams.get('scope'));
      // The host server may pre-consume the request stream; the body is only a
      // fallback for clients that send the parameters as JSON instead of a query.
      if (!kind || !id) {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch {
          return json(res, 400, { ok: false, error: 'kind and id required' });
        }
        kind = String(body.kind ?? kind);
        id = Number(body.id ?? id);
        rawScope = rawScope || normalizeScopeInput(body.scope);
      }
      if (!kind || !id) return json(res, 400, { ok: false, error: 'kind and id required' });
      const s = openStore();
      const { requested, scope } = httpScope(rawScope);
      try {
        if (requested === 'all') auditCrossScope(s.db, 'http:restore', id);
        return json(res, 200, { ok: true, ...restoreMemory(s, String(kind), id, scope) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/forget',
    handler: async (req, res) => {
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'forget requires POST' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let kind = url.searchParams.get('kind') ?? '';
      let id = Number(url.searchParams.get('id') ?? 0);
      let rawScope = normalizeScopeInput(url.searchParams.get('scope'));
      // The host server may pre-consume the request stream, so the body is only a
      // fallback: parameters travel in the query string.
      if (!kind || !id) {
        const body = await readJsonBody(req);
        kind = String(body.kind ?? kind);
        id = Number(body.id ?? id);
        rawScope = rawScope || normalizeScopeInput(body.scope);
      }
      const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[kind];
      if (!table || !id) {
        return json(res, 400, { ok: false, error: 'kind and id required' });
      }
      const { requested, scope } = httpScope(rawScope);
      if (requested === 'all') auditCrossScope(s.db, 'http:forget', id);
      const forgotten = forgetMemory(s, kind, id, scope);
      invalidateProfile();
      return json(res, 200, { ok: true, forgotten, scope: rawScope || SCOPE_GLOBAL });
    },
  });
}
function projectRouteScope(rawScope, cwd = '') {
  const requested = normalizeScopeInput(rawScope);
  if (requested && requested !== 'project' && requested !== 'all') return requested;
  const db = openStore().db;
  const dir = String(cwd ?? '').trim();
  if (dir) {
    try { return resolveProjectKey(db, dir); } catch { /* fall through */ }
  }
  return SCOPE_GLOBAL;
}

function registerProjectRoutes(add) {
  add({
    kind: 'exact',
    path: '/omni-memory/project/status',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'project status requires GET' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const root = String(url.searchParams.get('root') ?? url.searchParams.get('cwd') ?? '').trim();
      const scope = projectRouteScope(url.searchParams.get('scope'), root);
      const value = projectStatus(openStore().db, root, { scope });
      return json(res, 200, { ...value, root: value.root || root || null });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/project/search',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'project search requires GET' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const root = String(url.searchParams.get('root') ?? url.searchParams.get('cwd') ?? '').trim();
      const scope = projectRouteScope(url.searchParams.get('scope'), root);
      const value = projectSearch(openStore().db, String(url.searchParams.get('q') ?? ''), {
        scope, root, kind: url.searchParams.get('kind') ?? 'all',
        path: url.searchParams.get('path') ?? undefined,
        module: url.searchParams.get('module') ?? undefined,
        method: url.searchParams.get('method') ?? undefined,
        limit: url.searchParams.get('limit') ?? 20,
      });
      return json(res, 200, value);
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/project/context',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'project context requires GET' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const root = String(url.searchParams.get('root') ?? url.searchParams.get('cwd') ?? '').trim();
      const scope = projectRouteScope(url.searchParams.get('scope'), root);
      const ref = String(url.searchParams.get('ref') ?? '').trim();
      if (!ref) return json(res, 400, { ok: false, error: 'ref required' });
      const value = projectContext(openStore().db, ref, {
        scope, root, budget: Number(url.searchParams.get('budget') ?? PACKET_BUDGET),
      });
      return json(res, 200, value);
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/project/impact',
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') return json(res, 405, { ok: false, error: 'project impact requires GET' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const root = String(url.searchParams.get('root') ?? url.searchParams.get('cwd') ?? '').trim();
      const scope = projectRouteScope(url.searchParams.get('scope'), root);
      const ref = String(url.searchParams.get('ref') ?? '').trim();
      if (!ref) return json(res, 400, { ok: false, error: 'ref required' });
      const value = projectImpact(openStore().db, ref, {
        scope, root, depth: Number(url.searchParams.get('depth') ?? 4),
      });
      return json(res, 200, value);
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/project/sync',
    handler: async (req, res) => {
      if (String(req.method ?? 'POST').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'project sync requires POST' });
      const body = await readJsonBody(req).catch(() => ({}));
      const root = String(body.root ?? body.cwd ?? '').trim();
      if (!root) return json(res, 400, { ok: false, error: 'root required' });
      if (!existsSync(root)) return json(res, 404, { ok: false, error: 'root not found' });
      const scope = projectRouteScope(body.scope, root);
      const value = indexProject(openStore().db, root, {
        scope, full: body.full === true, ctags: body.ctags !== false, gitCommit: body.gitCommit,
      });
      return json(res, 200, value);
    },
  });
}

export function registerRoutes(ctx) {
  const web = (ctx && typeof ctx.register === 'function' && typeof ctx.get !== 'function')
    ? ctx
    : serviceFrom(ctx, 'webServer');
  if (!web || typeof web.register !== 'function') {
    routeState = { status: 'pending', count: 0, at: now(), error: 'webServer not available' };
    return undefined;
  }

  const disposers = [];
  // Every HTTP route is loopback-only. Method/CSRF policy stays here so a new
  // route cannot forget the guard while its handler only deals with its payload.
  const routeGuards = new Map([
    ['/omni-memory/packet', { methods: ['GET'], error: 'packet requires GET' }],
    ['/omni-memory/ingest', { methods: ['POST'], error: 'ingest requires POST', mutating: true }],
    ['/omni-memory/consolidate', { methods: ['POST'], error: 'consolidate requires POST', mutating: true }],
    ['/omni-memory/candidates', { methods: ['GET'], error: 'candidates requires GET' }],
    ['/omni-memory/candidate', { methods: ['POST'], error: 'candidate requires POST', mutating: true }],
    ['/omni-memory/openapi.json', { methods: ['GET'], error: 'openapi.json requires GET' }],
    ['/omni-memory/tool', { methods: ['POST'], error: 'tool requires POST', mutating: true }],
    ['/omni-memory/list', {}],
    ['/omni-memory/overview', {}],
    ['/omni-memory/graph', {}],
    ['/omni-memory/node', {}],
    ['/omni-memory/persona', { methods: ['GET', 'POST'], error: 'persona requires GET or POST', mutating: true }],
    ['/omni-memory/persona/refresh', { methods: ['POST'], error: 'refresh requires POST', mutating: true }],
    ['/omni-memory/dream/proposals', {}],
    ['/omni-memory/dream/replace', { methods: ['POST'], error: 'replace requires POST', mutating: true }],
    ['/omni-memory/dream/rollback', { methods: ['POST'], error: 'rollback requires POST', mutating: true }],
    ['/omni-memory/export', { methods: ['GET'], error: 'export requires GET' }],
    ['/omni-memory/restore', { methods: ['POST'], error: 'restore requires POST', mutating: true }],
    ['/omni-memory/status', {}],
    ['/omni-memory/search', {}],
    ['/omni-memory/forget', { methods: ['POST'], error: 'forget requires POST', mutating: true }],
    ['/omni-memory/project/status', { methods: ['GET'], error: 'project status requires GET' }],
    ['/omni-memory/project/search', { methods: ['GET'], error: 'project search requires GET' }],
    ['/omni-memory/project/context', { methods: ['GET'], error: 'project context requires GET' }],
    ['/omni-memory/project/impact', { methods: ['GET'], error: 'project impact requires GET' }],
    ['/omni-memory/project/sync', { methods: ['POST'], error: 'project sync requires POST', mutating: true }],
  ]);
  const add = route => {
    const guard = routeGuards.get(String(route.path ?? ''));
    if (!guard) throw new Error(`route guard missing for ${route.path}`);
    try {
      const dispose = web.register({
        ...route,
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' });
          // Fail closed: a real HTTP/1.1 request always has Host, so a missing
          // one means a hand-built or downgraded client. The standalone server
          // already rejects it; the plugin route wrapper must not be weaker.
          if (!hostHeaderAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden host' });
          const method = String(req.method ?? 'GET').toUpperCase();
          if (guard.methods && !guard.methods.includes(method)) {
            return json(res, 405, { ok: false, error: guard.error });
          }
          if (guard.mutating && method === 'POST' && !mutationAllowed(req)) {
            return json(res, 403, { ok: false, error: 'forbidden' });
          }
          return route.handler(req, res);
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch { /* a missing route is not fatal */ }
  };

  registerReadRoutes(add);
  registerAdminRoutes(add);
  registerWriteRoutes(add);
  registerPersonaRoutes(add);
  registerProjectRoutes(add);

  routeState = { status: 'registered', count: disposers.length, at: now(), error: null };
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* already gone */ }
    }
    routeState = { status: 'disposed', count: 0, at: now(), error: null };
  };
}

/**
 * Host port for adapters that are not DSH.
 *
 * DSH learns a session's working directory from its event stream; an MCP server,
 * a CLI call or an HTTP request has no such stream. Those adapters announce the
 * working directory once at startup instead. The mapping is persisted in `meta`
 * as well, so a restarted adapter recovers the same layer without announcing
 * again — and so a DSH session opened later in the same directory sees the same
 * project layer.
 *
 * Returns the resolved project scope (`global` or `proj:<name>#<hash>`).
 */
