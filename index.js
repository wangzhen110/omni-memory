// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
// NonCommercial use only; attribution required. See LICENSE and ATTRIBUTION.md.
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
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './lib/embed.mjs';
import { backendConfig, embedRemote } from './lib/embed-provider.mjs';
import { extractCandidateTexts } from './lib/capture-rules.mjs';
import { rerankConfig, rerankRemote } from './lib/rerank-provider.mjs';
import { semanticConfig, embedSemantic } from './lib/semantic-embed.mjs';

// Data home resolution, in priority order:
//   1. OMNI_HOME   — set by non-DSH adapters (MCP, CLI, HTTP) to point at a shared store
//   2. DSH_HOME    — kept for existing DSH installs, so their memory carries over untouched
//   3. ~/.dsh      — historical default
// The store file itself stays `memory/omni.db` under that home, so a DSH install and a
// standalone adapter that resolve to the same home share one database instead of forking.
const DSH_HOME = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
const DB_DIR = path.join(DSH_HOME, 'memory');
const DB_FILE = path.join(DB_DIR, 'omni.db');
// Backups are the one place a model-facing tool is allowed to touch the disk.
// Keeping that directory fixed turns export/import from an arbitrary read/write
// primitive into a narrow, auditable file exchange.
const BACKUP_DIR = path.resolve(process.env.OMNI_BACKUP_DIR || path.join(DB_DIR, 'backups'));
const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const PROFILE_BUDGET = 1200;
const PROFILE_CACHE_MS = 30_000;
const MAX_CAPTURE_CHARS = 4000;
// How long a write waits for the file lock before giving up. Every host shares
// one SQLite file, so concurrent writers are normal, not exceptional.
const BUSY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OMNI_BUSY_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(raw) || raw < 0) return 5000;
  return Math.min(raw, 60_000);
})();

let store;

/** Tool definitions registered by this module instance, for non-DSH HTTP adapters. */
const localToolDefinitions = new Map();

/** HTTP tool bridge: read/write/recall only; destructive maintenance stays on MCP/CLI. */
const HTTP_TOOL_ALLOWLIST = new Set([
  'memory_write', 'memory_search', 'memory_solution_report', 'memory_feedback',
  'memory_get', 'memory_amend', 'memory_profile', 'memory_timeline',
]);

// Prepared statements are compiled once per SQL string and database. The hot
// paths used to re-compile the same SELECT/INSERT every row, which shows up
// most clearly during backfills and repeated panel reads.
const statementCache = new WeakMap();
const STATEMENT_CACHE_MAX = 256;

function prepareCached(db, sql) {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    if (cache.size >= STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value);
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

/**
 * Scope layers.
 *
 * `global`  — cross-project rules and preferences; injected everywhere.
 * `proj:x`  — one workspace; recalled and injected only inside that workspace.
 *
 * The workspace is derived from `session.header.cwd`, so a conversation in a
 * project directory writes project-scoped transcripts and sees project notes,
 * while a conversation elsewhere sees only the global layer.
 */
const SCOPE_GLOBAL = 'global';
const cwdBySession = new Map();
const projectByAgent = new Map();
const MAX_PENDING_VECTORS = 4096;
const REMOTE_PROBE_TEXT = 'omni-memory embedding dimension probe';

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function projectKeyFromCwd(cwd, platform = process.platform) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return SCOPE_GLOBAL;
  const normalized = raw.replaceAll('\\', '/').replace(/\/+$/, '') || raw;
  // Windows and macOS paths are case-insensitive by default. Keeping the hash
  // case-sensitive there meant the same workspace opened as `C:\Repo` and
  // `c:\repo` produced two project layers; Linux stays case-sensitive.
  const identity = (platform === 'win32' || platform === 'darwin')
    ? normalized.toLowerCase()
    : normalized;
  return projectKeyFromPath(identity);
}

/** The pre-3.9.4 key, kept only so an existing layer can be migrated. */
function legacyProjectKeyFromCwd(cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return SCOPE_GLOBAL;
  const normalized = raw.replaceAll('\\', '/').replace(/\/+$/, '') || raw;
  return projectKeyFromPath(normalized);
}

function projectKeyFromPath(normalized) {
  const base = normalized.split('/').pop() ?? normalized;
  const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `proj:${safe || 'project'}#${fnv1a(normalized).toString(16).slice(0, 6)}`;
}

export { projectKeyFromCwd, legacyProjectKeyFromCwd };
export { openStore, migrateScopeAlias, scopeHasRows };

const WORKSPACES_DIR = path.join(DSH_HOME, 'sessions');

/**
 * DSH names a workspace folder after its path: ASCII stays, and other code
 * units become '~XXXX'. Separators and literals are both '-', so the decode is
 * only good enough for a human-readable label — never for identity.
 */
function workspaceLabelFromDirName(name) {
  const text = String(name ?? '');
  if (!text.startsWith('--') || !text.endsWith('--') || text.length < 6) return '';
  const decoded = text
    .slice(2, -2)
    .replace(/~([0-9a-fA-F]{4,6})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  const marker = /-(?:Desktop|Documents|Downloads|src|projects|code)-/i.exec(decoded);
  const tail = marker ? decoded.slice(marker.index + marker[0].length) : decoded;
  return tail
    .replace(/^项目-/, '')
    .replace(/^-+|-+$/g, '')
    .trim();
}

/** Compare labels ignoring the separators the folder name collapses. */
function normalizeWorkspaceLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');
}

let workspaceCache = { at: 0, list: [] };
const WORKSPACE_CACHE_MS = 60_000;

/** Workspaces DSH knows about, whether or not they hold any memories. */
function discoverWorkspaces() {
  if (Date.now() - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.list;
  const list = [];
  try {
    for (const entry of readdirSync(WORKSPACES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Temp probes and the internal IM workspace are not user projects.
      if (/AppData-Local-Temp|acp-probe|\.dsh-im/i.test(entry.name)) continue;
      const label = workspaceLabelFromDirName(entry.name);
      if (!label) continue;
      list.push({ dir: entry.name, label, normalized: normalizeWorkspaceLabel(label) });
    }
  } catch { /* no session folder yet: show what the database has */ }
  workspaceCache = { at: Date.now(), list };
  return list;
}

/**
 * Layer judgement at write time.
 *
 * Explicit `scope` always wins. Otherwise the wording decides: artifacts that
 * only make sense in one workspace go to the project layer, cross-project rules
 * and preferences go to the global layer, and an ambiguous statement stays in
 * the project it was said in (the cheaper error: a rule that needs promoting is
 * easy to find later, whereas a leaked project detail is not).
 */
const GLOBAL_HINTS = [
  '偏好', '习惯', '以后', '总是', '永远', '一律', '所有项目', '跨项目', '通用',
  '铁律', '禁止', '不要再', '宁可不',
];
const PROJECT_HINTS = [
  '本项目', '这个项目', '当前项目', '本仓库', '本工程', '这个插件', '本插件',
  'src/', 'docs/', 'package.json', '.mjs', '.ts', '.js', '构建', '部署', '迁移', '表结构', '字段',
];

function classifyScope(text, project) {
  const value = String(text ?? '');
  const globalScore = GLOBAL_HINTS.filter(hint => value.includes(hint)).length;
  const projectScore = PROJECT_HINTS.filter(hint => value.includes(hint)).length;
  if (!project) return { scope: SCOPE_GLOBAL, reason: 'no-project', confidence: 1 };
  if (globalScore > 0 && projectScore === 0) {
    return { scope: SCOPE_GLOBAL, reason: 'cross-project wording', confidence: 0.8 };
  }
  if (projectScore > 0) return { scope: project, reason: 'project-specific wording', confidence: 0.85 };
  return { scope: project, reason: 'default-to-project', confidence: 0.55 };
}

function normalizeScopeInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return lower === 'all' || lower === 'project' || lower === 'global' ? lower : raw;
}

function decideScope(explicit, text, project = currentProject()) {
  const given = normalizeScopeInput(explicit);
  if (given === 'all') throw new Error('scope=all is read-only; choose global or a project scope');
  if (given === 'project') {
    return project
      ? { scope: project, reason: 'explicit', confidence: 1 }
      : { scope: SCOPE_GLOBAL, reason: 'no-project', confidence: 1 };
  }
  if (given) return { scope: given === SCOPE_GLOBAL ? SCOPE_GLOBAL : given, reason: 'explicit', confidence: 1 };
  return classifyScope(text, project);
}

/**
 * An explicit layer that has never been written before is legal (a new project
 * must be able to create itself), but the caller should be told: an orphan key
 * is far more often a typo than a new workspace.
 */
function newScopeFlag(db, scope) {
  if (scope === SCOPE_GLOBAL) return undefined;
  const project = currentProject();
  if (project && scope === project) return undefined;
  const row = prepareCached(db, `
    SELECT 1 AS hit FROM notes WHERE scope = ?
    UNION ALL SELECT 1 FROM facts WHERE scope = ?
    UNION ALL SELECT 1 FROM chunks WHERE scope = ?
    LIMIT 1
  `).get(scope, scope, scope);
  return row ? undefined : true;
}

/** The path identity used only for alias lookup; never persists this form. */
function normalizeProjectPath(cwd) {
  return String(cwd ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

function projectPathsEqual(left, right, platform = process.platform) {
  const a = normalizeProjectPath(left);
  const b = normalizeProjectPath(right);
  return (platform === 'win32' || platform === 'darwin')
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** Follow a chain of old scope keys until a canonical scope is reached. */
function resolveScopeAlias(db, scope) {
  let current = String(scope ?? '');
  for (let pass = 0; pass < 16; pass += 1) {
    if (!current) return current;
    let row;
    try {
      row = prepareCached(db, 'SELECT canonical FROM scope_aliases WHERE alias = ?').get(current);
    } catch {
      return current;
    }
    if (!row?.canonical || row.canonical === current) return current;
    current = row.canonical;
  }
  return current;
}

/** Resolve a working directory to the one canonical project key. */
function resolveProjectKey(db, cwd) {
  const key = projectKeyFromCwd(cwd);
  if (key === SCOPE_GLOBAL) return key;
  return resolveScopeAlias(db, key);
}

/** Keep the alias's original creation time when its canonical target changes. */
function upsertScopeAlias(db, alias, canonical) {
  prepareCached(db, `
    INSERT INTO scope_aliases(alias, canonical, created_at) VALUES (?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical
  `).run(alias, canonical, now());
}

function scopeHasRows(db, scope) {
  try {
    const row = prepareCached(db, `
      SELECT 1 AS hit FROM notes WHERE scope = ?
      UNION ALL SELECT 1 FROM facts WHERE scope = ?
      UNION ALL SELECT 1 FROM chunks WHERE scope = ?
      UNION ALL SELECT 1 FROM note_candidates WHERE scope = ?
      UNION ALL SELECT 1 FROM edges WHERE scope = ?
      UNION ALL SELECT 1 FROM meta WHERE value = ? AND key LIKE 'agent_project:%'
      LIMIT 1
    `).get(scope, scope, scope, scope, scope, scope);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Merge one project scope into another.
 *
 * A cased legacy key and its lowercase twin are the same workspace, but merging
 * blindly across arbitrary project keys would merge same-named folders from
 * different drives. Callers must establish the alias from a real path first.
 * Chunks have a partial unique index on (hash, scope): the destination wins and
 * the duplicate source row is tombstoned, never hard-deleted.
 */
function migrateScopeAlias(db, from, to, options = {}) {
  const source = options.literal ? String(from ?? '').trim() : resolveScopeAlias(db, from);
  const target = resolveScopeAlias(db, to);
  if (!source || !target || source === target) return { migrated: false, from: source, to: target };
  const counts = { notes: 0, facts: 0, chunks: 0, candidates: 0, edges: 0, chunksTombstoned: 0, meta: 0 };
  transaction(db, () => {
    // Active chunk hashes already present at the destination must not collide.
    const targetHashes = new Set(
      prepareCached(db, 'SELECT hash FROM chunks WHERE scope = ? AND deleted_at IS NULL').all(target)
        .map(row => row.hash),
    );
    for (const row of prepareCached(db, 'SELECT id, hash, deleted_at FROM chunks WHERE scope = ?').all(source)) {
      if (row.deleted_at === null && targetHashes.has(row.hash)) {
        prepareCached(db, 'UPDATE chunks SET deleted_at = ? WHERE id = ?').run(now(), row.id);
        dropDerivedRows(db, 'chunk', row.id);
        counts.chunksTombstoned += 1;
      } else {
        prepareCached(db, 'UPDATE chunks SET scope = ? WHERE id = ?').run(target, row.id);
        counts.chunks += 1;
        if (row.deleted_at === null) targetHashes.add(row.hash);
      }
    }
    counts.notes = Number(prepareCached(db, 'UPDATE notes SET scope = ? WHERE scope = ?').run(target, source).changes);
    counts.facts = Number(prepareCached(db, 'UPDATE facts SET scope = ? WHERE scope = ?').run(target, source).changes);
    counts.candidates = Number(prepareCached(db, 'UPDATE note_candidates SET scope = ? WHERE scope = ?').run(target, source).changes);
    counts.edges = Number(prepareCached(db, 'UPDATE edges SET scope = ? WHERE scope = ?').run(target, source).changes);
    for (const row of prepareCached(db, "SELECT key FROM meta WHERE key LIKE 'agent_project:%' AND value = ?").all(source)) {
      metaSet(db, row.key, target);
      counts.meta += 1;
    }
    // Keep the path map on the canonical key, not the old spelling.
    if (options.path && (metaGet(db, `project_path:${target}`) ?? '') !== options.path) {
      metaSet(db, `project_path:${target}`, options.path);
    }
    prepareCached(db, 'DELETE FROM meta WHERE key = ?').run(`project_path:${source}`);
    upsertScopeAlias(db, source, target);
  });
  return { migrated: true, from: source, to: target, ...counts };
}

/**
 * Called when a workspace is opened. The current path's legacy key is known,
 * so it can be merged without guessing; historical keys with no path mapping
 * stay untouched until an explicit alias is supplied.
 */
function ensureProjectAlias(db, cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return { migrated: false, canonical: SCOPE_GLOBAL };
  const canonical = resolveScopeAlias(db, projectKeyFromCwd(raw));
  if (canonical === SCOPE_GLOBAL) return { migrated: false, canonical };
  const candidates = new Set();
  const addCandidate = value => {
    const candidate = String(value ?? '').trim();
    if (!candidate || candidate === SCOPE_GLOBAL || candidate === canonical) return;
    candidates.add(candidate);
  };

  // The legacy key must be considered literally. Resolving it first would turn
  // it into the canonical key whenever an alias already exists, which is exactly
  // the case where leftover rows still need migration.
  addCandidate(legacyProjectKeyFromCwd(raw));

  // A path remembered on a previous run can recover cased spellings that are
  // no longer the process cwd. Full-path equality prevents same-basename merges.
  try {
    for (const row of prepareCached(db, "SELECT key, value FROM meta WHERE key LIKE 'project_path:%'").all()) {
      if (!projectPathsEqual(row.value, raw)) continue;
      addCandidate(String(row.key).slice('project_path:'.length));
    }
  } catch { /* the path map is best effort */ }

  // Any alias already pointing at this canonical may still own rows. The old
  // implementation resolved the alias first, saw it equal the target, and never
  // inspected its rows -- leaving transcripts invisible to the project view.
  try {
    for (const row of prepareCached(db, 'SELECT alias FROM scope_aliases WHERE canonical = ?').all(canonical)) {
      addCandidate(row.alias);
    }
  } catch { /* schema repair is best effort */ }

  const result = { migrated: false, canonical, merged: [], candidates: [...candidates] };
  for (const candidate of candidates) {
    if (!scopeHasRows(db, candidate)) {
      // Still remember the old key, so a later import cannot split the layer.
      try {
        upsertScopeAlias(db, candidate, canonical);
        result.merged.push({ from: candidate, to: canonical, migrated: false });
      } catch { /* schema repair is best effort */ }
      continue;
    }
    result.merged.push(migrateScopeAlias(db, candidate, canonical, {
      literal: true,
      path: normalizeProjectPath(raw),
    }));
    if (result.merged.at(-1).migrated) result.migrated = true;
  }
  try {
    const pathKey = `project_path:${canonical}`;
    if (metaGet(db, pathKey) !== normalizeProjectPath(raw)) metaSet(db, pathKey, normalizeProjectPath(raw));
  } catch { /* best effort */ }
  return result;
}

const SCOPE_ALIAS_REPAIR_VERSION = '1';

/**
 * One-time startup repair for aliases that were recorded before their rows
 * existed. `ensureProjectAlias` now handles the current cwd, but an old alias
 * can still own rows from a previous process; moving them once prevents a
 * permanent split between the exact project view and `scope=all`.
 */
function repairScopeAliases(db) {
  const version = SCOPE_ALIAS_REPAIR_VERSION;
  if (metaGet(db, 'scope_alias_repair_version') === version) {
    return { skipped: true, version, checked: 0, migrated: 0, failed: [] };
  }
  const report = { skipped: false, version, checked: 0, migrated: 0, failed: [], at: now() };
  let rows = [];
  try {
    rows = prepareCached(db, 'SELECT alias, canonical FROM scope_aliases WHERE alias <> canonical').all();
  } catch (error) {
    report.failed.push({ alias: null, error: String(error?.message ?? error) });
  }
  for (const row of rows) {
    const alias = String(row.alias ?? '').trim();
    const canonical = String(row.canonical ?? '').trim();
    if (!alias || !canonical || alias === canonical || alias === SCOPE_GLOBAL || canonical === SCOPE_GLOBAL) continue;
    report.checked += 1;
    let hasRows = false;
    try { hasRows = scopeHasRows(db, alias); } catch { hasRows = false; }
    if (!hasRows) continue;
    try {
      const result = migrateScopeAlias(db, alias, canonical, { literal: true });
      if (result.migrated) report.migrated += 1;
    } catch (error) {
      report.failed.push({ alias, canonical, error: String(error?.message ?? error) });
    }
  }
  try {
    if (report.failed.length) {
      metaSet(db, 'scope_alias_repair_last_error', JSON.stringify(report.failed.slice(0, 20)).slice(0, 2000));
      metaSet(db, 'scope_alias_repair_failed_at', now());
    } else {
      metaSet(db, 'scope_alias_repair_version', version);
      metaSet(db, 'scope_alias_repair_last_error', '');
      metaSet(db, 'scope_alias_repair_last_run_at', now());
    }
  } catch { /* repair diagnostics are best effort */ }
  return report;
}

/**
 * Rules are cheap but keyword-blind; the host `llm` service can do better. Writes
 * never wait for it: the row lands immediately under the rule's verdict and a
 * background call re-checks ambiguous cases, moving the row when the model
 * disagrees. Mode: OMNI_SCOPE_JUDGE=off|auto|always (default off = no upload).
 */
const judgeQueue = [];
const MAX_JUDGE_QUEUE = 256;
let judgeBusy = false;
let lastJudge = null;

function judgeMode() {
  // Default is `off`: memory writes must not upload their body to a model
  // unless the user explicitly opts in with OMNI_SCOPE_JUDGE=auto|always.
  return String(process.env.OMNI_SCOPE_JUDGE ?? 'off');
}

async function pickJudgeRoute(llm) {
  const provider = process.env.OMNI_JUDGE_PROVIDER || (llm.listProviders?.() ?? [])[0]?.id;
  if (!provider) return null;
  if (process.env.OMNI_JUDGE_MODEL) return { provider, model: process.env.OMNI_JUDGE_MODEL };
  const models = (await llm.listModels?.(provider)) ?? [];
  const cheap = models.find(model => /flash|mini|haiku|small|lite/i.test(String(model.id))) ?? models[0];
  return cheap ? { provider, model: cheap.id } : null;
}

function enqueueJudge(ctx, item) {
  const mode = judgeMode();
  if (mode === 'off') return;
  // Explicit scope is the caller's decision; the model must not overrule it.
  if (item.reason === 'explicit') return;
  // Without a project there is no layer choice to make.
  if (!item.project) return;
  if (mode === 'auto' && Number(item.confidence ?? 0) >= 0.8) return;
  // Never grow an unbounded queue when the host has no llm service or the
  // user is offline. A dropped job keeps the rule verdict, which is safe.
  if (judgeQueue.length >= MAX_JUDGE_QUEUE) return;
  if (!ctx || typeof ctx.get !== 'function' || !ctx.get('llm')) return;
  judgeQueue.push(item);
  void flushJudge(ctx);
}

async function flushJudge(ctx) {
  if (judgeBusy) return;
  judgeBusy = true;
  try {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
    if (!llm || typeof llm.stream !== 'function') return;
    const route = await pickJudgeRoute(llm);
    if (!route) return;
    while (judgeQueue.length) {
      const item = judgeQueue.shift();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        let out = '';
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          system: 'Classify one memory as global (a rule that applies across projects) or project (meaningful only inside one workspace). Answer with exactly one word.',
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `workspace: ${item.project ?? 'none'}\nmemory: ${item.text}\nanswer:` }],
          }],
          maxTokens: 8,
          temperature: 0,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') out += chunk.text ?? '';
          else if (chunk?.type === 'finish') break;
        }
        clearTimeout(timer);
        // An empty answer is not "global". It is a failed judgement: keep the
        // rule's verdict rather than silently promoting a project note.
        const answer = out.trim();
        const verdict = answer ? (/(?:project|项目)/i.test(answer) ? (item.project ?? SCOPE_GLOBAL) : SCOPE_GLOBAL) : item.scope;
        const moved = verdict !== item.scope;
        if (moved) {
          const s = openStore();
          const oldScope = item.scope ?? SCOPE_GLOBAL;
          prepareCached(s.db, `UPDATE ${item.table} SET scope = ? WHERE id = ?`).run(verdict, Number(item.id));
          if (item.kind === 'fact') {
            const fact = prepareCached(s.db, 'SELECT subject, relation, object FROM facts WHERE id = ?').get(Number(item.id));
            if (fact) {
              prepareCached(s.db, `
                UPDATE edges SET scope = ?
                WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
                  AND (scope = ? OR scope IS NULL)
              `).run(verdict, fact.subject, fact.relation, String(fact.object ?? ''), oldScope);
            }
          }
          invalidateProfile();
        }
        lastJudge = {
          at: now(), kind: item.kind, id: Number(item.id),
          from: item.scope, to: verdict, moved,
          model: `${route.provider}/${route.model}`,
        };
      } catch { /* keep the rule's verdict */ }
    }
  } catch { /* judging must never break a write */ } finally {
    judgeBusy = false;
  }
}

function currentProject(context = null) {
  const raw = context?.agent?.id ?? context?.session?.id ?? context?.scope?.id ?? context?.scope ?? '';
  const id = String(raw ?? '').trim();
  if (!id) return null;
  return projectForScope({ id });
}

/**
 * Auto-recall state.
 *
 * `AssembleContext` exposes only `scope` and `signal`, so the prompt section
 * cannot read the incoming user message. The message is captured from the
 * inbox-claimed event and recall is precomputed asynchronously; the synchronous
 * section provider then reads the cached result. A missed race degrades to
 * profile-only injection, never to an error.
 */
const AUTO_RECALL_TTL_MS = 120_000;
const lastUserByAgent = new Map();
const recallByAgent = new Map();
let lastInjection = { at: 0, chars: 0, recall: 0, auto: false };

function autoRecallEnabled() {
  // Switch: OMNI_AUTO_RECALL=0 disables; anything else (including unset) enables.
  return process.env.OMNI_AUTO_RECALL !== '0';
}

function now() {
  return Date.now();
}

function hash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
}

function openStore() {
  if (store) return store;
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  // Several AI hosts can hold the same file open at once. Set the busy timeout
  // before switching journal mode: concurrent first opens race on that PRAGMA
  // and would otherwise fail with "database is locked" before the handler exists.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Keep the WAL from growing without bound when many readers keep snapshots
  // alive; the limit is applied at the next checkpoint.
  db.exec('PRAGMA journal_size_limit = 16777216');
  // The lease table must exist before anything else can coordinate, including
  // the schema migration itself.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      source TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      source TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      superseded_by INTEGER,
      contested INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      problem_key TEXT,
      solution_status TEXT,
      solution_verified_at INTEGER,
      reuse_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      relation TEXT NOT NULL,
      object TEXT NOT NULL,
      text TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      recorded_at INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7,
      source TEXT,
      contested INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL,
      rel TEXT NOT NULL,
      dst TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      scope TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS bigrams (
      layer TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      gram TEXT NOT NULL,
      PRIMARY KEY (layer, owner_id, gram)
    );
    CREATE INDEX IF NOT EXISTS bigrams_gram ON bigrams(gram, layer, owner_id);
  `);

  // Trigram tokenisation is what makes CJK substring recall work; fall back to
  // the default tokenizer when the bundled SQLite lacks it.
  let ftsMode = 'like';
  const createFts = (table) => {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text, tokenize='trigram')`);
      return 'trigram';
    } catch {
      try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(text)`);
        return 'unicode61';
      } catch {
        return null;
      }
    }
  };
  const chunksMode = createFts('chunks_fts');
  const notesMode = createFts('notes_fts');
  const factsMode = createFts('facts_fts');
  ftsMode = chunksMode ?? notesMode ?? factsMode ?? 'like';

  // Schema migrations. A fresh database and an upgraded one must converge on the
  // same structure, so every structural change is a numbered migration.
  // Schema migrations. A fresh database and an upgraded one must converge on the
  // same structure, so every structural change is a numbered migration.
  // One process migrates and rebuilds; the rest wait for the lease to clear so
  // two hosts opening at the same moment never run DDL against each other.
  const MAINTENANCE = 'open-maintenance';
  let lease = acquireLease(db, MAINTENANCE, 120_000);
  for (let attempt = 0; !lease && attempt < 25; attempt += 1) {
    sleepSync(200);
    lease = acquireLease(db, MAINTENANCE, 120_000);
  }
  if (!lease) throw new Error('database maintenance lease unavailable; refusing to read an unmigrated store');

  // Migration and derived-index maintenance are one owner-only unit. Running
  // migrate() outside the lease let a second process replay destructive DDL
  // (for example the v4 vector reset) after the first process already set the
  // backfill marker, silently breaking vector recall.
  let schemaVersion = SCHEMA_VERSION;
  let semanticGcReport = null;
  let aliasRepair = null;
  try {
    schemaVersion = migrate(db);
    try {
      aliasRepair = repairScopeAliases(db);
    } catch (error) {
      aliasRepair = {
        skipped: false,
        version: SCOPE_ALIAS_REPAIR_VERSION,
        checked: 0,
        migrated: 0,
        failed: [{ alias: null, error: String(error?.message ?? error) }],
        at: now(),
      };
    }
    // One-time derived-index repair. Forget/compact now delete semantic rows in
    // the same transaction; this sweep removes rows left behind by older builds.
    if (metaGet(db, 'semantic_gc_version') !== String(SCHEMA_VERSION)) {
      semanticGcReport = pruneSemanticVectors(db);
      if (semanticGcReport.ok) {
        metaSet(db, 'semantic_gc_version', SCHEMA_VERSION);
        metaSet(db, 'semantic_gc_last_error', '');
      } else {
        metaSet(db, 'semantic_gc_last_error', semanticGcReport.error);
        metaSet(db, 'semantic_gc_failed_at', now());
      }
    }
    const ftsMarker = metaGet(db, 'fts_backfill_version');
    if (ftsMarker !== String(SCHEMA_VERSION)) {
      let ftsOk = true;
      if (chunksMode) ftsOk = backfillFts(db, 'chunks_fts', 'chunks') && ftsOk;
      if (notesMode) ftsOk = backfillFts(db, 'notes_fts', 'notes') && ftsOk;
      if (factsMode) ftsOk = backfillFts(db, 'facts_fts', 'facts') && ftsOk;
      if (ftsOk) metaSet(db, 'fts_backfill_version', SCHEMA_VERSION);
    }
    backfillBigrams(db);
    restoreRemoteState(db);
    if (backendConfig().kind === 'hashed') {
      const vectorMarker = `${SCHEMA_VERSION}:${DIM}`;
      if (metaGet(db, 'vector_backfill_version') !== vectorMarker) {
        const report = backfillVectors(db, { limit: STARTUP_VECTOR_BATCH });
        if (!report.remaining && report.errors === 0) metaSet(db, 'vector_backfill_version', vectorMarker);
      }
    }
  } finally {
    releaseLease(db, MAINTENANCE, lease);
  }

  prepareCached(db, 'INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fts_mode', ftsMode);
  store = {
    db,
    ftsMode,
    schemaVersion,
    semanticGc: semanticGcReport,
    aliasRepair,
    fts: { chunks: Boolean(chunksMode), notes: Boolean(notesMode), facts: Boolean(factsMode) },
  };
  // A host launched from this directory should never silently split its layer
  // from a legacy cased key. The same check also runs in attachSession for
  // explicit cwds (CLI --dir, MCP projects).
  try {
    store.aliasMigration = ensureProjectAlias(db, process.cwd());
  } catch (error) {
    store.aliasMigration = { migrated: false, error: error?.message ?? String(error) };
  }
  // Start the bundled semantic index in the background only when the store
  // actually has missing rows. A fresh store and an already-indexed store do
  // not pay the 216MB model load just because a host opened.
  scheduleSemanticBackfill(store, 800);
  return store;
}

export const SCHEMA_VERSION = 16;
let hostCtx = null;

function columnExists(db, table, column) {
  try {
    return prepareCached(db, `PRAGMA table_info(${table})`).all().some(row => row.name === column);
  } catch {
    return false;
  }
}

function addColumn(db, table, column, type) {
  if (columnExists(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/** Optional derived tables differ by schema age; only skip when truly absent. */
function tableExists(db, table) {
  try {
    return Boolean(prepareCached(db, "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

/**
 * Indexes for the read hot paths: active lists, timeline, fact lookup and graph
 * joins. They are deliberately not on full note text (which can exceed SQLite's
 * index row limit); scope + ts + state covers the panel queries.
 */
function ensureHotIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS notes_scope_state_ts
      ON notes(scope, deleted_at, superseded_by, ts);
    CREATE INDEX IF NOT EXISTS notes_ts ON notes(ts);
    CREATE INDEX IF NOT EXISTS facts_subject_relation_scope_valid
      ON facts(subject, relation, scope, valid_to);
    CREATE INDEX IF NOT EXISTS facts_object_scope_valid
      ON facts(object, scope, valid_to);
    CREATE INDEX IF NOT EXISTS chunks_scope_state_ts
      ON chunks(scope, deleted_at, ts);
    CREATE INDEX IF NOT EXISTS edges_src_rel_dst_scope
      ON edges(src, rel, dst, scope);
  `);
}

/**
 * Ordered migrations. Index = target version. Never edit a shipped step; append
 * a new one instead so existing databases replay the same history.
 */
const MIGRATIONS = [
  null,
  // v1: baseline schema is created by CREATE TABLE IF NOT EXISTS above.
  () => {},
  // v2: per-layer scope columns so a project filter covers facts and transcripts.
  db => {
    addColumn(db, 'facts', 'scope', 'TEXT');
    addColumn(db, 'chunks', 'scope', 'TEXT');
  },
  // v3: vector index for the vector half of hybrid retrieval.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        kind TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (kind, owner_id)
      );
    `);
  },
  // v4: embedding dimensionality changed (256 → 512). Vectors are a derived
  // index, so the migration drops and rebuilds them from the source rows.
  db => {
    try { db.exec('DELETE FROM vectors'); } catch { /* table may be absent */ }
  },
  // v5: dream verification state — which note was checked against which evidence.
  db => {
    addColumn(db, 'notes', 'verified_at', 'INTEGER');
    addColumn(db, 'notes', 'verification', 'TEXT');
    addColumn(db, 'notes', 'evidence', 'TEXT');
  },
  // v6: legacy manual scopes (`proj:name`, no hash) predate the project layer and
  // were never enforced by the profile. Keeping them would silently hide those
  // rows from every derived project key, so they become global instead — the same
  // visibility they had before the split.
  db => {
    for (const table of ['notes', 'facts', 'chunks']) {
      try {
        prepareCached(db, `UPDATE ${table} SET scope = 'global' WHERE scope LIKE 'proj:%' AND scope NOT LIKE '%#%'`).run();
      } catch { /* column may be absent on very old databases */ }
    }
  },
  // v7: revision-aware chunks and scoped edges.
  //
  // The old global UNIQUE(hash) index made a compacted chunk impossible to
  // re-capture and made identical text in two projects collide. Deduplicate only
  // among *active* rows in the same scope; tombstoned rows stay as audit history.
  // Edges also need the fact scope, otherwise graph traversal can cross projects
  // even after fact filters were added.
  db => {
    try { db.exec('DROP INDEX IF EXISTS chunks_hash'); } catch { /* absent */ }
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS chunks_hash_active
        ON chunks(hash, IFNULL(scope, 'global'))
        WHERE deleted_at IS NULL
      `);
    } catch { /* best effort; insertChunk still guards duplicates */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS bigrams (
        layer TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        gram TEXT NOT NULL,
        PRIMARY KEY (layer, owner_id, gram)
      );
      CREATE INDEX IF NOT EXISTS bigrams_gram ON bigrams(gram, layer, owner_id);
    `);
    addColumn(db, 'edges', 'scope', 'TEXT');
    try {
      db.exec(`
        UPDATE edges
        SET scope = (
          SELECT f.scope FROM facts f
          WHERE f.subject = edges.src AND f.relation = edges.rel AND f.object = edges.dst
          ORDER BY f.valid_from DESC LIMIT 1
        )
        WHERE scope IS NULL
      `);
    } catch { /* legacy rows may not line up; null remains visible as global */ }
    for (const [table, column, type] of [
      ['facts', 'recorded_at', 'INTEGER'],
    ]) {
      addColumn(db, table, column, type);
    }
  },
  // v8: multi-valued relations. Existing facts stay single-valued.
  db => {
    addColumn(db, 'facts', 'cardinality', "TEXT NOT NULL DEFAULT 'single'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        name TEXT PRIMARY KEY,
        cardinality TEXT NOT NULL DEFAULT 'single',
        aliases TEXT,
        updated_at INTEGER
      );
    `);
  },
  // v9: entity aliases. Facts are canonicalised at write time; aliases merge
  // existing rows only when explicitly requested by memory_link_entity.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS entity_aliases_canonical ON entity_aliases(canonical);
    `);
  },
  // v10: user-defined persona settings (personality, habits, preferences...).
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER
      );
    `);
  },
  // v11: turn notes into problem-solving memory. `verification` remains the
  // transcript-coverage verdict from dreaming; `solution_status` is the real-world
  // outcome (verified / unverified / failed / expired).
  db => {
    addColumn(db, 'notes', 'problem_key', 'TEXT');
    addColumn(db, 'notes', 'solution_status', 'TEXT');
    addColumn(db, 'notes', 'solution_verified_at', 'INTEGER');
    addColumn(db, 'notes', 'reuse_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'notes', 'last_used_at', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS notes_problem_key ON notes(problem_key);
      CREATE INDEX IF NOT EXISTS notes_solution_status ON notes(solution_status);
    `);
  },
  // v12: recall quality feedback for notes and facts. Useful/misleading is a
  // first-class signal rather than a second hand-written note; the counters are
  // additive and survive revision chains.
  db => {
    for (const table of ['notes', 'facts']) {
      addColumn(db, table, 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, table, 'last_recall_at', 'INTEGER');
      addColumn(db, table, 'useful_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, table, 'misleading_count', 'INTEGER NOT NULL DEFAULT 0');
    }
  },
  // v13: host-agnostic transcript candidates. Extraction never writes a note
  // directly; it parks the proposal until a human or agent accepts it.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        source TEXT,
        chunk_id INTEGER,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at INTEGER,
        note_id INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS note_candidates_status
        ON note_candidates(status, scope, ts);
      CREATE INDEX IF NOT EXISTS note_candidates_hash
        ON note_candidates(hash, scope, status);
    `);
  },
  // v14: bundled local semantic vectors. Kept separate from the hashed `vectors`
  // table so switching between hashed, remote and local never mixes vector
  // spaces; the old routes stay usable while the semantic index backfills.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_vectors (
        kind TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (kind, owner_id, model)
      );
      CREATE INDEX IF NOT EXISTS semantic_vectors_model
        ON semantic_vectors(model, kind, owner_id);
    `);
  },
  // v15: project scope aliases. Windows/macOS cased paths used to hash to
  // different project keys; the alias table keeps an old key -> canonical key
  // mapping so a one-time merge is observable and repeatable.
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scope_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scope_aliases_canonical ON scope_aliases(canonical);
    `);
  },
  // v16: read hot-path indexes. The panel's list/timeline/graph queries scan
  // notes and facts by scope/state; without these 100k rows cross the 100ms
  // budget even when the result set is tiny.
  db => ensureHotIndexes(db),
];

function migrate(db) {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  if (!Number.isFinite(version) || version < 1) {
    // Unversioned database: treat as v1 and apply the remaining steps.
    version = 1;
  }
  for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
    const step = MIGRATIONS[next];
    if (typeof step === 'function') step(db);
  }
  // Repair path: never trust the version marker alone. A database whose marker
  // is current but lacks a table/column is repaired in place; this is what a
  // migration inserted at the wrong array index used to produce.
  if (SCHEMA_VERSION >= 8 && !columnExists(db, 'facts', 'cardinality')) {
    addColumn(db, 'facts', 'cardinality', "TEXT NOT NULL DEFAULT 'single'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        name TEXT PRIMARY KEY,
        cardinality TEXT NOT NULL DEFAULT 'single',
        aliases TEXT,
        updated_at INTEGER
      );
    `);
  }
  if (SCHEMA_VERSION >= 9) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS entity_aliases_canonical ON entity_aliases(canonical);
    `);
  }
  if (SCHEMA_VERSION >= 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER
      );
    `);
  }
  if (SCHEMA_VERSION >= 11) {
    addColumn(db, 'notes', 'problem_key', 'TEXT');
    addColumn(db, 'notes', 'solution_status', 'TEXT');
    addColumn(db, 'notes', 'solution_verified_at', 'INTEGER');
    addColumn(db, 'notes', 'reuse_count', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'notes', 'last_used_at', 'INTEGER');
    db.exec(`
      CREATE INDEX IF NOT EXISTS notes_problem_key ON notes(problem_key);
      CREATE INDEX IF NOT EXISTS notes_solution_status ON notes(solution_status);
    `);
  }
  if (SCHEMA_VERSION >= 12) {
    for (const table of ['notes', 'facts']) {
      addColumn(db, table, 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, table, 'last_recall_at', 'INTEGER');
      addColumn(db, table, 'useful_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, table, 'misleading_count', 'INTEGER NOT NULL DEFAULT 0');
    }
  }
  if (SCHEMA_VERSION >= 13) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        source TEXT,
        chunk_id INTEGER,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at INTEGER,
        note_id INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS note_candidates_status
        ON note_candidates(status, scope, ts);
      CREATE INDEX IF NOT EXISTS note_candidates_hash
        ON note_candidates(hash, scope, status);
    `);
  }
  if (SCHEMA_VERSION >= 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scope_aliases (
        alias TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scope_aliases_canonical ON scope_aliases(canonical);
    `);
  }
  // Repair path for a marker that is already 16 but indexes were interrupted.
  if (SCHEMA_VERSION >= 16) ensureHotIndexes(db);
  prepareCached(db, "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)")
    .run(String(SCHEMA_VERSION));
  return SCHEMA_VERSION;
}

function backfillFts(db, ftsTable, sourceTable) {
  try {
    db.exec(`
      INSERT INTO ${ftsTable}(rowid, text)
      SELECT id, text FROM ${sourceTable}
      WHERE id NOT IN (SELECT rowid FROM ${ftsTable})
    `);
    return true;
  } catch { return false; }
}

const CJK_BIGRAM = /^[\u4e00-\u9fff]{2}$/;

/** Keep the two-character CJK index in sync with one source row. */
function indexBigrams(db, layer, id, text) {
  try {
    const grams = [...new Set(tokenize(text).filter(token => CJK_BIGRAM.test(token)))];
    prepareCached(db, 'DELETE FROM bigrams WHERE layer = ? AND owner_id = ?').run(layer, Number(id));
    const insert = prepareCached(db, 'INSERT OR IGNORE INTO bigrams(layer, owner_id, gram) VALUES (?, ?, ?)');
    for (const gram of grams) insert.run(layer, Number(id), gram);
  } catch { /* optional index */ }
}

const BIGRAM_BACKFILL_BATCH = 10_000;

function backfillBigrams(db, options = {}) {
  const report = { scanned: 0, remaining: false };
  try {
    if (!options.force && metaGet(db, 'bigrams_version') === String(SCHEMA_VERSION)) return report;
    const limit = Math.max(1, Number(options.limit ?? BIGRAM_BACKFILL_BATCH));
    let remaining = false;
    for (const [layer, table] of [['note', 'notes'], ['fact', 'facts'], ['chunk', 'chunks']]) {
      const cursorKey = `bigrams_cursor_${layer}`;
      let cursor = options.force ? 0 : Number(metaGet(db, cursorKey) ?? 0);
      if (options.force) metaSet(db, cursorKey, 0);
      const rows = prepareCached(db, `
        SELECT id, text FROM ${table}
        WHERE deleted_at IS NULL AND id > ?
        ORDER BY id LIMIT ?
      `).all(cursor, limit);
      if (!rows.length) continue;
      transaction(db, () => {
        for (const row of rows) indexBigrams(db, layer, row.id, row.text);
        metaSet(db, cursorKey, Number(rows[rows.length - 1].id));
      });
      report.scanned += rows.length;
      cursor = Number(rows[rows.length - 1].id);
      if (rows.length >= limit) remaining = true;
    }
    if (!remaining) metaSet(db, 'bigrams_version', SCHEMA_VERSION);
    report.remaining = remaining;
  } catch { /* backfill is best effort */ }
  return report;
}

/**
 * Full rebuild of the CJK bigram index.
 *
 * Opening a large legacy database only backfills one batch per layer, so a big
 * store needed many restarts before 2-character search was complete. This walks
 * the whole corpus in batches inside one call; it is explicit (never on open)
 * because it rewrites a derived index and can take a while on a large store.
 */
function reindexBigrams(s, options = {}) {
  const { db } = s;
  const limit = Math.max(1000, Math.min(50_000, Number(options.limit ?? BIGRAM_BACKFILL_BATCH)));
  transaction(db, () => {
    db.exec('DELETE FROM bigrams');
    for (const layer of ['note', 'fact', 'chunk']) metaSet(db, `bigrams_cursor_${layer}`, 0);
    metaSet(db, 'bigrams_version', '0');
  });
  let scanned = 0;
  let passes = 0;
  let report = { remaining: true, scanned: 0 };
  while (report.remaining && passes < 10_000) {
    report = backfillBigrams(db, { limit });
    scanned += report.scanned;
    passes += 1;
    if (!report.scanned) break;
  }
  return { scanned, passes, done: !report.remaining };
}

/**
 * Vector indexing entry point.
 *
 * The hashed backend writes synchronously (microseconds). The remote backend
 * needs the network, so rows are queued and flushed lazily before the next
 * search: writes never block a turn, and retrieval never waits for a batch that
 * a failed request left behind.
 */
const pendingVectors = new Map();
let remoteDim = 0;
let remoteSignatureValue = '';
let remoteProbeFailedAt = 0;
let vectorDropped = 0;
let vectorLastDropAt = 0;
const REMOTE_PROBE_COOLDOWN_MS = 60_000;

function metaGet(db, key) {
  try {
    return prepareCached(db, 'SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function metaSet(db, key, value) {
  try {
    prepareCached(db, 'INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
  } catch { /* meta is best effort */ }
}

function remoteSignature(config = backendConfig()) {
  if (config.kind !== 'remote') return '';
  return hash(`${config.url}\u0000${config.model}`).slice(0, 16);
}

/**
 * Remote dimensions are a property of the endpoint/model, not of the process.
 * Persisting them is what makes a restart keep the vector route alive. A model
 * or URL change starts a new signature; old vectors remain on disk as history
 * but the active dimension is rebuilt from the new backend.
 */
function restoreRemoteState(db) {
  const config = backendConfig();
  if (config.kind !== 'remote') {
    remoteDim = 0;
    remoteSignatureValue = '';
    return;
  }
  const signature = remoteSignature(config);
  const storedSignature = metaGet(db, 'remote_signature');
  const storedDim = Number(metaGet(db, 'remote_dim') ?? 0);
  if (storedSignature === signature && Number.isFinite(storedDim) && storedDim > 0) {
    remoteDim = storedDim;
    remoteSignatureValue = signature;
    return;
  }
  remoteDim = 0;
  remoteSignatureValue = signature;
  metaSet(db, 'remote_signature', signature);
  metaSet(db, 'remote_dim', 0);
}

async function ensureRemoteDim(s) {
  const config = backendConfig();
  if (config.kind !== 'remote') return DIM;
  if (remoteDim > 0) return remoteDim;
  // An unreachable endpoint must not add its timeout to every search: remember
  // the failure and retry the probe after a cooldown while lexical recall answers.
  if (now() - remoteProbeFailedAt < REMOTE_PROBE_COOLDOWN_MS) return 0;
  try {
    const probe = await embedRemote([REMOTE_PROBE_TEXT], config);
    remoteDim = probe[0]?.length ?? 0;
    if (remoteDim > 0) {
      remoteProbeFailedAt = 0;
      remoteSignatureValue = remoteSignature(config);
      metaSet(s.db, 'remote_signature', remoteSignatureValue);
      metaSet(s.db, 'remote_dim', remoteDim);
    } else {
      remoteProbeFailedAt = now();
    }
  } catch {
    remoteProbeFailedAt = now();
  }
  return remoteDim;
}

function enqueueVector(kind, id, text) {
  const key = `${kind}:${id}`;
  if (!pendingVectors.has(key) && pendingVectors.size >= MAX_PENDING_VECTORS) {
    vectorDropped += 1;
    vectorLastDropAt = now();
    return;
  }
  pendingVectors.set(key, { kind, id: Number(id), text: String(text ?? '') });
}

/** Store (or refresh) one vector for a memory row. */
function upsertVector(s, kind, id, text) {
  indexVector(s, kind, id, text);
}

/**
 * Vector indexing entry point.
 *
 * The hashed backend writes synchronously (microseconds). The remote backend
 * needs the network, so rows are queued and flushed lazily before the next
 * search: writes never block a turn, and retrieval never waits for a batch that
 * a failed request left behind.
 */
function indexVector(s, kind, id, text) {
  // The local semantic route is independent of the hashed/remote vector route:
  // a failed model leaves the other routes untouched.
  enqueueSemantic(s, kind, id, text);
  const config = backendConfig();
  if (config.kind === 'hashed') {
    try {
      const vector = embedText(text);
      prepareCached(s.db, 'INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
        .run(kind, Number(id), DIM, toBlob(vector));
    } catch { /* the vector route is optional */ }
    return;
  }
  enqueueVector(kind, id, text);
}

/** Queue a bounded batch of old rows that lack a vector at the active dimension. */
async function backfillRemoteBatch(s) {
  if (backendConfig().kind !== 'remote' || remoteDim <= 0) return;
  for (const [kind, table] of [['note', 'notes'], ['fact', 'facts'], ['chunk', 'chunks']]) {
    try {
      const rows = prepareCached(s.db, `
        SELECT t.id AS id, t.text AS text
        FROM ${table} t
        WHERE t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.dim = ?
          )
        ORDER BY t.id
        LIMIT 32
      `).all(kind, remoteDim);
      for (const row of rows) enqueueVector(kind, row.id, row.text);
    } catch { /* backfill is best effort */ }
  }
}

/** Flush queued rows through the remote embedder; never throws. */
async function flushPendingVectors(s) {
  const config = backendConfig();
  if (config.kind !== 'remote') return;
  const dim = await ensureRemoteDim(s);
  if (!dim) return;
  await backfillRemoteBatch(s);
  const entries = [...pendingVectors.values()].slice(0, 32);
  if (!entries.length) return;
  try {
    const vectors = await embedRemote(entries.map(entry => entry.text), config);
    remoteDim = vectors[0].length;
    for (const [index, entry] of entries.entries()) {
      prepareCached(s.db, 'INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
        .run(entry.kind, entry.id, remoteDim, toBlob(vectors[index]));
      pendingVectors.delete(`${entry.kind}:${entry.id}`);
    }
    metaSet(s.db, 'remote_signature', remoteSignatureValue || remoteSignature(config));
    metaSet(s.db, 'remote_dim', remoteDim);
  } catch { /* keep the queue; lexical recall still answers */ }
}

/** Which vector dimension the active backend produces, or 0 when unknown. */
function activeVectorDim() {
  const config = backendConfig();
  return config.kind === 'hashed' ? DIM : remoteDim;
}

// Bundled local semantic index. It is deliberately a separate route and a
// separate table: the hashed and remote vectors keep working while this index
// fills in, and changing the semantic model never invalidates old rows.
const SEMANTIC_BATCH = 8;
const SEMANTIC_BACKFILL_SCAN = 64;
const SEMANTIC_MAX_PENDING = 4096;
const SEMANTIC_MIN_COSINE = 0.25;
const SEMANTIC_LEASE_MS = 120_000;
const SEMANTIC_RETRY_BASE_MS = 1_000;
const SEMANTIC_RETRY_MAX_MS = 30_000;
const semanticStates = new WeakMap();

function semanticState(s) {
  let state = semanticStates.get(s.db);
  if (!state) {
    state = {
      pending: new Map(),
      seq: 0,
      timer: null,
      running: false,
      flushing: null,
      backfillTimer: null,
      backfillLease: null,
      exitHandler: null,
      indexed: 0,
      dropped: 0,
      lastDropAt: 0,
      failureCount: 0,
      retryAt: 0,
      lastError: '',
      backfillDone: false,
    };
    semanticStates.set(s.db, state);
  }
  return state;
}

function semanticBackoffMs(failures) {
  const exponent = Math.max(0, Number(failures) - 1);
  return Math.min(SEMANTIC_RETRY_MAX_MS, SEMANTIC_RETRY_BASE_MS * (2 ** Math.min(exponent, 5)));
}

function noteSemanticFailure(state, error) {
  state.failureCount += 1;
  state.lastError = String(error?.message ?? error);
  state.retryAt = now() + semanticBackoffMs(state.failureCount);
}

function clearSemanticFailure(state) {
  state.failureCount = 0;
  state.retryAt = 0;
  state.lastError = '';
}

function scheduleSemanticWorker(s, delay = 0) {
  const config = semanticConfig();
  if (!config.enabled) return;
  const state = semanticState(s);
  if (state.running || state.timer) return;
  const timer = setTimeout(() => {
    state.timer = null;
    runSemanticWorker(s).catch(() => {});
  }, Math.max(0, delay));
  state.timer = timer;
  timer.unref?.();
}

function enqueueSemantic(s, kind, id, text) {
  if (!semanticConfig().enabled) return;
  const state = semanticState(s);
  const key = `${kind}:${id}`;
  if (!state.pending.has(key) && state.pending.size >= SEMANTIC_MAX_PENDING) {
    state.dropped += 1;
    state.lastDropAt = now();
    return;
  }
  state.seq += 1;
  state.pending.set(key, {
    kind,
    id: Number(id),
    text: String(text ?? ''),
    seq: state.seq,
  });
  scheduleSemanticWorker(s);
}

function releaseSemanticLease(s) {
  const state = semanticState(s);
  if (state.backfillLease) {
    try { releaseLease(s.db, 'semantic-backfill', state.backfillLease); } catch { /* db already closed */ }
    state.backfillLease = null;
  }
  if (state.backfillTimer) {
    clearTimeout(state.backfillTimer);
    state.backfillTimer = null;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.exitHandler) {
    process.removeListener('exit', state.exitHandler);
    state.exitHandler = null;
  }
}

/** Remove every derived index row for a source row, with only a bare db handle. */
function dropDerivedRows(db, kind, id) {
  const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[String(kind)];
  if (!table) return;
  if (tableExists(db, 'semantic_vectors')) {
    prepareCached(db, 'DELETE FROM semantic_vectors WHERE kind = ? AND owner_id = ?')
      .run(kind, Number(id));
  }
  if (tableExists(db, `${table}_fts`)) {
    prepareCached(db, `DELETE FROM ${table}_fts WHERE rowid = ?`).run(Number(id));
  }
  if (tableExists(db, 'bigrams')) {
    prepareCached(db, 'DELETE FROM bigrams WHERE layer = ? AND owner_id = ?').run(kind, Number(id));
  }
  if (tableExists(db, 'vectors')) {
    prepareCached(db, 'DELETE FROM vectors WHERE kind = ? AND owner_id = ?').run(kind, Number(id));
  }
}

/** Remove every derived index for a row whose source data is gone or inactive. */
function dropDerivedIndexes(s, kind, id) {
  pendingVectors.delete(`${kind}:${Number(id)}`);
  dropDerivedRows(s.db, kind, id);
}

/**
 * Drop semantic rows whose source row is tombstoned, superseded or expired.
 * Derived data has no audit value; a stale vector only costs disk and can make
 * a deleted note compete in ranking if a future query bypasses the JOIN.
 */
function pruneSemanticVectors(db) {
  const report = { ok: true, deleted: 0, error: '' };
  try {
    transaction(db, () => {
      for (const [kind, table, extra] of [
        ['note', 'notes', 'AND t.superseded_by IS NULL'],
        ['fact', 'facts', 'AND t.valid_to IS NULL'],
        ['chunk', 'chunks', ''],
      ]) {
        if (!tableExists(db, 'semantic_vectors')) continue;
        const info = prepareCached(db, `
          DELETE FROM semantic_vectors
          WHERE kind = ?
            AND NOT EXISTS (
              SELECT 1 FROM ${table} t
              WHERE t.id = semantic_vectors.owner_id
                AND t.deleted_at IS NULL ${extra}
            )
        `).run(kind);
        report.deleted += Number(info.changes ?? 0);
      }
    });
  } catch (error) {
    // A failed sweep must remain observable instead of silently committing a
    // half-clean index. The main store still opens; lexical recall is unaffected.
    report.ok = false;
    report.error = String(error?.message ?? error);
  }
  return report;
}

function semanticHasMissing(s, config) {
  for (const [kind, table, extra] of [
    ['note', 'notes', 'AND t.superseded_by IS NULL'],
    ['fact', 'facts', 'AND t.valid_to IS NULL'],
    ['chunk', 'chunks', ''],
  ]) {
    try {
      const row = prepareCached(s.db, `
        SELECT 1 AS found
        FROM ${table} t
        WHERE t.deleted_at IS NULL ${extra}
          AND NOT EXISTS (
            SELECT 1 FROM semantic_vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.model = ?
          )
        LIMIT 1
      `).get(kind, config.signature);
      if (row) return true;
    } catch { /* a missing table only means there is nothing to backfill */ }
  }
  return false;
}

/**
 * Start the one-time backfill. The cross-process lease keeps N AI hosts from
 * each loading the 216MB model and re-running the same scan on first open.
 * Once every row has a vector this returns without touching the model at all.
 */
function scheduleSemanticBackfill(s, delay = 800) {
  const config = semanticConfig();
  if (!config.enabled) return;
  const state = semanticState(s);
  if (state.backfillDone || state.backfillTimer || state.running || state.backfillLease) return;
  if (!semanticHasMissing(s, config)) {
    state.backfillDone = true;
    return;
  }
  const lease = acquireLease(s.db, 'semantic-backfill', SEMANTIC_LEASE_MS);
  if (!lease) return;
  state.backfillLease = lease;
  if (!state.exitHandler) {
    // A host that exits mid-backfill must not leave a long lease behind for
    // every other host. A short TTL plus per-batch renewal is the crash fallback.
    state.exitHandler = () => {
      if (!state.backfillLease) return;
      try {
        releaseLease(s.db, 'semantic-backfill', state.backfillLease);
      } catch { /* the process is already leaving; TTL covers a closed db */ }
      state.backfillLease = null;
    };
    process.once('exit', state.exitHandler);
  }
  const timer = setTimeout(() => {
    state.backfillTimer = null;
    runSemanticWorker(s).catch(() => {});
  }, Math.max(0, delay));
  state.backfillTimer = timer;
  timer.unref?.();
}

function semanticBackfill(s, config, limit = SEMANTIC_BACKFILL_SCAN) {
  const state = semanticState(s);
  if (state.backfillDone) return;
  let found = 0;
  for (const [kind, table, extra] of [
    ['note', 'notes', 'AND t.superseded_by IS NULL'],
    ['fact', 'facts', 'AND t.valid_to IS NULL'],
    ['chunk', 'chunks', ''],
  ]) {
    try {
      const rows = prepareCached(s.db, `
        SELECT t.id AS id, t.text AS text
        FROM ${table} t
        WHERE t.deleted_at IS NULL ${extra}
          AND NOT EXISTS (
            SELECT 1 FROM semantic_vectors v
            WHERE v.kind = ? AND v.owner_id = t.id AND v.model = ?
          )
        ORDER BY t.id
        LIMIT ?
      `).all(kind, config.signature, limit);
      for (const row of rows) {
        found += 1;
        enqueueSemantic(s, kind, row.id, row.text);
      }
    } catch { /* a missing table only means there is nothing to backfill */ }
  }
  if (!found) state.backfillDone = true;
}

function writeSemantic(s, config, entries, vectors) {
  const insert = prepareCached(s.db, `
    INSERT OR REPLACE INTO semantic_vectors(kind, owner_id, model, dim, vec)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    insert.run(entry.kind, entry.id, config.signature, config.dim, toBlob(vectors[index]));
  }
}

/**
 * Embed and persist up to `limit` queued rows. Search awaits this before its
 * semantic query so a note written in the same turn is recallable immediately.
 * The `flushing` promise makes a foreground search and the background timer
 * share one inference instead of racing over the same queue.
 */
async function flushSemanticPending(s, config, limit = SEMANTIC_BATCH) {
  const state = semanticState(s);
  // A foreground search may arrive while the worker is embedding an older
  // snapshot. Wait for that batch, then take a fresh snapshot so a note written
  // during the flight is not hidden behind the worker's promise.
  if (state.flushing) {
    try { await state.flushing; } catch { /* the caller below reports its own failure */ }
  }
  const entries = [...state.pending.values()].slice(0, Math.max(1, limit));
  if (!entries.length) return 0;
  state.flushing = (async () => {
    // Snapshot versions, not just keys. An amend/replace can overwrite the same
    // key while inference is in flight; deleting that key afterwards would
    // swallow the newer text and leave a permanently stale vector.
    const active = entries.filter(entry => {
      const current = state.pending.get(`${entry.kind}:${entry.id}`);
      return current && current.seq === entry.seq;
    });
    if (!active.length) return 0;
    const vectors = await embedSemantic(active.map(entry => entry.text), config);
    if (vectors.some(vector => vector.length !== config.dim)) {
      throw new Error(`semantic dimension mismatch: expected ${config.dim}, got ${vectors[0]?.length ?? 0}`);
    }
    const stillCurrent = [];
    for (let index = 0; index < active.length; index += 1) {
      const entry = active[index];
      const current = state.pending.get(`${entry.kind}:${entry.id}`);
      if (!current || current.seq !== entry.seq) continue;
      stillCurrent.push({ entry, vector: vectors[index] });
    }
    if (!stillCurrent.length) return 0;
    writeSemantic(s, config, stillCurrent.map(item => item.entry), stillCurrent.map(item => item.vector));
    for (const item of stillCurrent) {
      state.pending.delete(`${item.entry.kind}:${item.entry.id}`);
    }
    state.indexed += stillCurrent.length;
    clearSemanticFailure(state);
    return stillCurrent.length;
  })();
  try {
    return await state.flushing;
  } finally {
    state.flushing = null;
  }
}

async function runSemanticWorker(s) {
  const config = semanticConfig();
  if (!config.enabled) return;
  const state = semanticState(s);
  if (state.running) return;
  state.running = true;
  let scheduleNext = false;
  let scheduleDelay = 0;
  try {
    if (state.retryAt > now()) {
      scheduleNext = state.pending.size > 0 || !state.backfillDone;
      scheduleDelay = Math.max(0, state.retryAt - now());
      return;
    }
    if (state.backfillLease) {
      const renewed = renewLease(s.db, 'semantic-backfill', state.backfillLease, SEMANTIC_LEASE_MS);
      if (renewed) state.backfillLease = renewed;
      else state.backfillLease = null;
    }
    if (state.pending.size < SEMANTIC_BATCH) semanticBackfill(s, config);
    if (!state.pending.size) {
      state.backfillDone = true;
      return;
    }
    await flushSemanticPending(s, config, SEMANTIC_BATCH);
    scheduleNext = state.pending.size > 0 || !state.backfillDone;
  } catch (error) {
    // A missing or corrupt model must not spin the worker or break retrieval.
    noteSemanticFailure(state, error);
    scheduleNext = state.pending.size > 0 || !state.backfillDone;
    scheduleDelay = Math.max(0, state.retryAt - now());
  } finally {
    state.running = false;
    if (state.backfillDone && state.backfillLease) {
      releaseLease(s.db, 'semantic-backfill', state.backfillLease);
      state.backfillLease = null;
    }
    // Schedule after clearing `running`: scheduleSemanticWorker refuses while a
    // worker is marked active, so scheduling inside the try would silently stop
    // the backfill after the first batch.
    if (scheduleNext) scheduleSemanticWorker(s, scheduleDelay);
  }
}

function semanticStatus(s) {
  const config = semanticConfig();
  const state = semanticState(s);
  let indexed = 0;
  try {
    indexed = Number(prepareCached(s.db, 'SELECT COUNT(*) AS n FROM semantic_vectors WHERE model = ?')
      .get(config.signature).n);
  } catch { /* schema not migrated yet */ }
  return {
    enabled: config.enabled,
    reason: config.reason ?? '',
    kind: config.kind,
    model: config.model,
    dim: config.dim,
    signature: config.signature,
    pending: state.pending.size,
    indexed,
    dropped: state.dropped,
    lastDropAt: state.lastDropAt || null,
    failureCount: state.failureCount,
    retryAt: state.retryAt > now() ? state.retryAt : null,
    running: state.running,
    backfillDone: state.backfillDone,
    lastError: state.lastError,
    gcError: metaGet(s.db, 'semantic_gc_last_error') ?? '',
    gcFailedAt: Number(metaGet(s.db, 'semantic_gc_failed_at') ?? 0) || null,
  };
}

async function reindexSemantic(s, limit, options = {}) {
  const config = semanticConfig();
  if (!config.enabled) return { enabled: false, reason: config.reason, model: config.model, processed: 0 };
  const state = semanticState(s);
  if (options.force === true) {
    try {
      prepareCached(s.db, 'DELETE FROM semantic_vectors WHERE model = ?').run(config.signature);
    } catch { /* schema not migrated yet */ }
    state.pending.clear();
    state.backfillDone = false;
  }
  let processed = 0;
  try {
    while (processed < limit) {
      if (state.pending.size < SEMANTIC_BATCH) semanticBackfill(s, config);
      const done = await flushSemanticPending(s, config, Math.min(SEMANTIC_BATCH, limit - processed));
      if (!done) break;
      processed += done;
    }
  } catch (error) {
    noteSemanticFailure(state, error);
    return { enabled: true, model: config.model, dim: config.dim, processed, error: String(error?.message ?? error) };
  }
  return {
    enabled: true,
    model: config.model,
    dim: config.dim,
    processed,
    pending: semanticState(s).pending.size,
    backfillDone: semanticState(s).backfillDone,
    forced: options.force === true,
  };
}

const STARTUP_VECTOR_BATCH = 20_000;

function backfillVectors(db, options = {}) {
  if (backendConfig().kind !== 'hashed') return { processed: 0, remaining: false, errors: 0, supported: false };
  const limit = Math.max(0, Number(options.limit ?? STARTUP_VECTOR_BATCH));
  let remaining = limit;
  let processed = 0;
  let errors = 0;
  let hasMore = false;
  const jobs = [
    ['note', 'notes', 'text'],
    ['fact', 'facts', 'text'],
    ['chunk', 'chunks', 'text'],
  ];
  const missingSql = table => `
    SELECT t.id AS id, t.text AS text
    FROM ${table} t
    WHERE t.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM vectors v
        WHERE v.kind = ? AND v.owner_id = t.id AND v.dim = ?
      )
  `;
  for (const [kind, table] of jobs) {
    try {
      const base = missingSql(table);
      const quota = Math.max(0, remaining);
      // If the batch is exhausted, still check whether this table has missing
      // rows so the caller knows whether the index is complete.
      const sql = quota > 0 ? `${base} LIMIT ?` : `${base} LIMIT 1`;
      const rows = quota > 0
        ? prepareCached(db, sql).all(kind, DIM, quota + 1)
        : prepareCached(db, sql).all(kind, DIM);
      if (quota <= 0) {
        if (rows.length) hasMore = true;
        continue;
      }
      const take = rows.length > quota ? rows.slice(0, quota) : rows;
      if (rows.length > quota) hasMore = true;
      if (take.length) {
        transaction(db, () => {
          const insert = prepareCached(db, 'INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)');
          for (const row of take) insert.run(kind, Number(row.id), DIM, toBlob(embedText(row.text)));
        });
        processed += take.length;
        remaining -= take.length;
      }
      if (remaining <= 0) continue;
    } catch {
      errors += 1;
      hasMore = true;
    }
  }
  return { processed, remaining: hasMore, errors, supported: true };
}

/** Run a multi-step write atomically. SQLite has no nested transaction here. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lease: `meta` holds `lease:<name>` with an expiry timestamp.
 * Whoever writes it first owns the work for the TTL; every other process skips
 * instead of doing the same rebuild on top of the first one.
 *
 * This matters once several AI hosts each spawn their own server process: at
 * startup they all want to migrate the schema and backfill indexes.
 */
function acquireLease(db, name, ttlMs) {
  const key = `lease:${name}`;
  try {
    return transaction(db, () => {
      const row = prepareCached(db, 'SELECT value FROM meta WHERE key = ?').get(key);
      const until = Number(row?.value ?? 0);
      if (Number.isFinite(until) && until > now()) return false;
      const token = now() + ttlMs;
      prepareCached(db, 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(token));
      return token;
    });
  } catch {
    return false;
  }
}

function releaseLease(db, name, token) {
  const key = `lease:${name}`;
  try {
    if (token === undefined || token === null) {
      prepareCached(db, 'DELETE FROM meta WHERE key = ?').run(key);
    } else {
      // If this owner exceeded its TTL and another process took over, do not
      // delete the new owner's lease.
      prepareCached(db, 'DELETE FROM meta WHERE key = ? AND value = ?').run(key, String(token));
    }
  } catch { /* a stale lease expires on its own */ }
}

/** Extend a lease only when the caller still owns the current token. */
function renewLease(db, name, token, ttlMs) {
  const key = `lease:${name}`;
  if (!token) return null;
  const until = now() + Math.max(1, Number(ttlMs) || 0);
  try {
    const info = prepareCached(db, 'UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(String(until), key, String(token));
    return Number(info.changes) > 0 ? until : null;
  } catch {
    return null;
  }
}

/** Tombstone one row and keep its derived graph edges consistent. */
function forgetMemory(s, kind, id, scope = SCOPE_GLOBAL) {
  const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[String(kind)];
  if (!table) throw new Error('kind must be note, fact or chunk');
  const filter = scopeClause('scope', scope);
  return transaction(s.db, () => {
    let fact = null;
    if (table === 'facts') {
      fact = prepareCached(s.db, `SELECT subject, relation, object, scope FROM facts WHERE id = ? ${filter.sql}`)
        .get(Number(id), ...filter.params);
      if (!fact) return false;
    }
    let row = null;
    if (table !== 'facts') {
      row = prepareCached(s.db, `SELECT id FROM ${table} WHERE id = ? ${filter.sql}`)
        .get(Number(id), ...filter.params);
      if (!row) return false;
    }
    const info = prepareCached(s.db, `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(now(), Number(id));
    if (Number(info.changes) > 0) dropDerivedIndexes(s, kind, id);
    if (fact && Number(info.changes) > 0) {
      prepareCached(s.db, `
        UPDATE edges SET valid_to = ?
        WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
          AND (scope = ? OR scope IS NULL)
      `).run(now(), fact.subject, fact.relation, String(fact.object ?? ''), fact.scope ?? SCOPE_GLOBAL);
    }
    return Number(info.changes) > 0;
  });
}

const EXPORT_FORMAT = 'omni-memory-backup';
const EXPORT_VERSION = 1;
const IMPORT_VERDICTS = new Set(['supported', 'weak', 'unsupported', 'contradicted']);
const IMPORT_SOLUTION_STATUSES = new Set(['verified', 'unverified', 'failed', 'expired']);

/** Clamp an imported number so a hand-edited backup cannot bypass ranking bounds. */
function importNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('imported numeric field is not finite');
  return Math.min(max, Math.max(min, number));
}

/** Keep lineage pointers inside the imported snapshot; unresolved ids become null. */
function importLineage(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Build one portable snapshot of the store. Vectors are derived and excluded. */
function snapshotStore(s, options = {}) {
  const audit = options.audit !== false;
  const notesWhere = audit ? '' : 'WHERE deleted_at IS NULL AND superseded_by IS NULL';
  const factsWhere = audit ? '' : 'WHERE deleted_at IS NULL AND valid_to IS NULL';
  const chunksWhere = audit ? '' : 'WHERE deleted_at IS NULL';
  const edgesWhere = audit ? '' : 'WHERE valid_to IS NULL';
  const candidatesWhere = audit ? '' : "WHERE status = 'pending'";
  const notes = prepareCached(s.db, `SELECT * FROM notes ${notesWhere} ORDER BY id`).all();
  const facts = prepareCached(s.db, `SELECT * FROM facts ${factsWhere} ORDER BY id`).all();
  const chunks = prepareCached(s.db, `SELECT * FROM chunks ${chunksWhere} ORDER BY id`).all();
  const edges = prepareCached(s.db, `SELECT * FROM edges ${edgesWhere} ORDER BY id`).all();
  const candidates = prepareCached(s.db, `SELECT * FROM note_candidates ${candidatesWhere} ORDER BY id`).all();
  const entities = prepareCached(s.db, 'SELECT name FROM entities ORDER BY name').all().map(row => row.name);
  const relations = prepareCached(s.db, 'SELECT name, cardinality, aliases, updated_at FROM relations ORDER BY name').all();
  const entityAliases = prepareCached(s.db, 'SELECT alias, canonical, updated_at FROM entity_aliases ORDER BY alias').all();
  const persona = prepareCached(s.db, 'SELECT key, value, updated_at FROM persona ORDER BY key').all();
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now(),
    schema: SCHEMA_VERSION,
    source: path.basename(DB_FILE),
    counts: {
      notes: notes.length, facts: facts.length, chunks: chunks.length,
      edges: edges.length, entities: entities.length,
      relations: relations.length, entityAliases: entityAliases.length, persona: persona.length,
      candidates: candidates.length,
    },
    notes, facts, chunks, edges, entities, relations, entityAliases, persona, candidates,
  };
}

/**
 * Resolve a backup name inside BACKUP_DIR.
 *
 * Only a single basename is accepted. Absolute paths, drive letters, UNC
 * prefixes, separators and `..` are rejected before they reach the filesystem,
 * and an existing symlink is never followed. `existing: true` is used by import
 * and requires a regular file; export refuses to overwrite for the same reason.
 */
function backupPath(input, { existing = false } = {}) {
  const raw = String(input ?? '').trim();
  if (raw.includes('\0')) throw new Error('backup name contains a NUL byte');
  if (raw && (path.isAbsolute(raw) || /[\\/]/.test(raw) || raw === '..' || raw.startsWith('../') || raw.startsWith('..\\'))) {
    throw new Error('backup name must be a single file name inside the backup directory');
  }
  const name = raw || `omni-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  if (name === '.' || name === '..' || !name.toLowerCase().endsWith('.json')) {
    throw new Error('backup name must end in .json');
  }
  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const target = path.resolve(BACKUP_DIR, name);
  if (path.dirname(target) !== BACKUP_DIR) throw new Error('backup name escapes the backup directory');
  let info = null;
  try {
    info = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('cannot inspect backup target');
  }
  if (info?.isSymbolicLink()) throw new Error('backup target is a symbolic link');
  if (existing) {
    if (!info || !info.isFile()) throw new Error('backup file does not exist');
    if (Number(info.size) > BACKUP_MAX_BYTES) throw new Error('backup file is too large');
  } else if (info) {
    throw new Error('backup target already exists');
  }
  return target;
}

function exportBackup(s, options = {}) {
  const snapshot = snapshotStore(s, options);
  const target = backupPath(options.path);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temporary file may never have existed */ }
    throw error;
  }
  return { path: target, counts: snapshot.counts, audit: options.audit !== false };
}

function importBackup(s, options = {}) {
  const file = String(options.path ?? '').trim();
  if (!file) throw new Error('path is required');
  const target = backupPath(file, { existing: true });
  let snapshot;
  try {
    const raw = readFileSync(target, 'utf8');
    // Never echo the parser message or file prefix: it turns a failed import
    // into an oracle for the first bytes of any readable file.
    snapshot = JSON.parse(raw);
  } catch {
    throw new Error('cannot read backup: invalid JSON');
  }
  return mergeSnapshot(s, snapshot, options);
}

/**
 * Merge a snapshot into the live store.
 *
 * Safe default is a dry run: import touches every table, so the caller has to
 * pass dryRun=false explicitly. Rows are matched by natural identity (text, fact
 * triple, chunk hash, edge triple) rather than by id; a note's `superseded_by`
 * pointer is remapped when ids are reassigned. Vectors are rebuilt, never imported.
 */
function mergeSnapshot(s, snapshot, options = {}) {
  if (!snapshot || snapshot.format !== EXPORT_FORMAT) throw new Error('not an omni-memory backup');
  if (Number(snapshot.version) > EXPORT_VERSION) throw new Error('backup was written by a newer version');
  const dryRun = options.dryRun !== false;
  const stats = {
    notes: 0, facts: 0, chunks: 0, edges: 0, entities: 0,
    relations: 0, entityAliases: 0, persona: 0, candidates: 0, skipped: 0, dryRun,
  };
  const plan = {
    notes: [], facts: [], chunks: [], edges: [], entities: [], relations: [], entityAliases: [], persona: [],
    candidates: [],
  };

  const noteExists = prepareCached(s.db, 'SELECT id FROM notes WHERE scope = ? AND text = ? AND superseded_by IS NULL');
  const factExists = prepareCached(s.db, 'SELECT id FROM facts WHERE subject = ? AND relation = ? AND object = ? AND scope = ?');
  const activeFactRows = prepareCached(s.db, `
    SELECT id, object, valid_from, scope FROM facts
    WHERE subject = ? AND relation = ? AND valid_to IS NULL AND deleted_at IS NULL
      AND (scope = ? OR (scope IS NULL AND ? = 'global'))
  `);
  const chunkExists = prepareCached(s.db, "SELECT id FROM chunks WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");
  const edgeExists = prepareCached(s.db, "SELECT id FROM edges WHERE src = ? AND rel = ? AND dst = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");
  const candidateExists = prepareCached(s.db, `
    SELECT id FROM note_candidates
    WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')
  `);

  for (const note of Array.isArray(snapshot.notes) ? snapshot.notes : []) {
    if (!note?.text) { stats.skipped += 1; continue; }
    if (noteExists.get(note.scope ?? SCOPE_GLOBAL, note.text)) { stats.skipped += 1; continue; }
    const verification = IMPORT_VERDICTS.has(String(note.verification ?? '')) ? String(note.verification) : null;
    const solutionStatus = IMPORT_SOLUTION_STATUSES.has(String(note.solution_status ?? note.solutionStatus ?? ''))
      ? String(note.solution_status ?? note.solutionStatus) : null;
    plan.notes.push({
      ...note,
      ts: importNumber(note.ts, now(), 0, Number.MAX_SAFE_INTEGER),
      scope: String(note.scope ?? SCOPE_GLOBAL),
      text: String(note.text),
      importance: importNumber(note.importance, 0.5, 0, 1),
      revision: Math.floor(importNumber(note.revision, 1, 1, 1_000_000)),
      contested: importNumber(note.contested, 0, 0, 1) ? 1 : 0,
      superseded_by: importLineage(note.superseded_by),
      deleted_at: note.deleted_at == null ? null : importNumber(note.deleted_at, now(), 0, Number.MAX_SAFE_INTEGER),
      verification,
      verified_at: verification ? importNumber(note.verified_at, now(), 0, Number.MAX_SAFE_INTEGER) : null,
      evidence: note.evidence ?? null,
      problem_key: note.problem_key ?? note.problemKey ?? null,
      solution_status: solutionStatus,
      solution_verified_at: solutionStatus ? importNumber(note.solution_verified_at ?? note.solutionVerifiedAt, now(), 0, Number.MAX_SAFE_INTEGER) : null,
      reuse_count: Math.floor(importNumber(note.reuse_count ?? note.reuseCount, 0, 0, 1_000_000_000)),
      last_used_at: note.last_used_at == null ? null : importNumber(note.last_used_at ?? note.lastUsedAt, now(), 0, Number.MAX_SAFE_INTEGER),
      recall_count: Math.floor(importNumber(note.recall_count ?? note.recallCount, 0, 0, 1_000_000_000)),
      last_recall_at: note.last_recall_at == null ? null : importNumber(note.last_recall_at ?? note.lastRecallAt, now(), 0, Number.MAX_SAFE_INTEGER),
      useful_count: Math.floor(importNumber(note.useful_count ?? note.usefulCount, 0, 0, 1_000_000_000)),
      misleading_count: Math.floor(importNumber(note.misleading_count ?? note.misleadingCount, 0, 0, 1_000_000_000)),
    });
  }
  for (const fact of Array.isArray(snapshot.facts) ? snapshot.facts : []) {
    if (!fact?.subject || !fact?.relation) { stats.skipped += 1; continue; }
    if (factExists.get(fact.subject, fact.relation, String(fact.object ?? ''), fact.scope ?? SCOPE_GLOBAL)) {
      stats.skipped += 1;
      continue;
    }
    plan.facts.push({
      ...fact,
      subject: String(fact.subject),
      relation: String(fact.relation),
      object: String(fact.object ?? ''),
      text: String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`),
      scope: String(fact.scope ?? SCOPE_GLOBAL),
      confidence: importNumber(fact.confidence, 0.7, 0, 1),
      contested: importNumber(fact.contested, 0, 0, 1) ? 1 : 0,
      valid_from: importNumber(fact.valid_from, now(), 0, Number.MAX_SAFE_INTEGER),
      valid_to: fact.valid_to == null ? null : importNumber(fact.valid_to, now(), 0, Number.MAX_SAFE_INTEGER),
      deleted_at: fact.deleted_at == null ? null : importNumber(fact.deleted_at, now(), 0, Number.MAX_SAFE_INTEGER),
      cardinality: fact.cardinality === 'multi' ? 'multi' : (fact.cardinality === 'single' ? 'single' : undefined),
      recall_count: Math.floor(importNumber(fact.recall_count ?? fact.recallCount, 0, 0, 1_000_000_000)),
      last_recall_at: fact.last_recall_at == null ? null : importNumber(fact.last_recall_at ?? fact.lastRecallAt, now(), 0, Number.MAX_SAFE_INTEGER),
      useful_count: Math.floor(importNumber(fact.useful_count ?? fact.usefulCount, 0, 0, 1_000_000_000)),
      misleading_count: Math.floor(importNumber(fact.misleading_count ?? fact.misleadingCount, 0, 0, 1_000_000_000)),
    });
  }
  for (const chunk of Array.isArray(snapshot.chunks) ? snapshot.chunks : []) {
    if (!chunk?.text) { stats.skipped += 1; continue; }
    const digest = hash(String(chunk.text));
    if (chunkExists.get(digest, chunk.scope ?? 'global')) { stats.skipped += 1; continue; }
    plan.chunks.push({
      ...chunk,
      text: String(chunk.text),
      ts: importNumber(chunk.ts, now(), 0, Number.MAX_SAFE_INTEGER),
      importance: importNumber(chunk.importance, 0.5, 0, 1),
      scope: chunk.scope == null ? null : String(chunk.scope),
      deleted_at: chunk.deleted_at == null ? null : importNumber(chunk.deleted_at, now(), 0, Number.MAX_SAFE_INTEGER),
    });
  }
  for (const edge of Array.isArray(snapshot.edges) ? snapshot.edges : []) {
    if (!edge?.src || !edge?.rel || !edge?.dst) { stats.skipped += 1; continue; }
    if (edgeExists.get(edge.src, edge.rel, edge.dst, edge.scope ?? SCOPE_GLOBAL)) { stats.skipped += 1; continue; }
    plan.edges.push({
      ...edge,
      src: String(edge.src), rel: String(edge.rel), dst: String(edge.dst),
      valid_from: importNumber(edge.valid_from, now(), 0, Number.MAX_SAFE_INTEGER),
      valid_to: edge.valid_to == null ? null : importNumber(edge.valid_to, now(), 0, Number.MAX_SAFE_INTEGER),
    });
  }
  for (const candidate of Array.isArray(snapshot.candidates) ? snapshot.candidates : []) {
    const text = String(candidate?.text ?? '').trim();
    if (!text || (candidate.status && candidate.status !== 'pending')) { stats.skipped += 1; continue; }
    const scope = candidate.scope ?? SCOPE_GLOBAL;
    const digest = hash(`${scope}\n${text}`);
    if (candidateExists.get(digest, scope)) { stats.skipped += 1; continue; }
    plan.candidates.push({ ...candidate, text, scope, hash: digest });
  }
  for (const name of Array.isArray(snapshot.entities) ? snapshot.entities : []) {
    if (!name) { stats.skipped += 1; continue; }
    plan.entities.push(String(name));
  }
  for (const relation of Array.isArray(snapshot.relations) ? snapshot.relations : []) {
    const name = String(relation?.name ?? '').trim();
    if (!name) { stats.skipped += 1; continue; }
    plan.relations.push({ ...relation, name });
  }
  for (const alias of Array.isArray(snapshot.entityAliases) ? snapshot.entityAliases : (Array.isArray(snapshot.aliases) ? snapshot.aliases : [])) {
    const name = String(alias?.alias ?? '').trim();
    const canonical = String(alias?.canonical ?? '').trim();
    if (!name || !canonical) { stats.skipped += 1; continue; }
    plan.entityAliases.push({ ...alias, alias: name, canonical });
  }
  const personaRows = Array.isArray(snapshot.persona)
    ? snapshot.persona
    : Object.entries(snapshot.persona ?? {}).map(([key, value]) => ({ key, value }));
  for (const item of personaRows) {
    const key = String(item?.key ?? '').trim();
    const value = String(item?.value ?? '').trim();
    if (!key || !value) { stats.skipped += 1; continue; }
    plan.persona.push({ ...item, key, value });
  }

  stats.notes = plan.notes.length;
  stats.facts = plan.facts.length;
  stats.chunks = plan.chunks.length;
  stats.edges = plan.edges.length;
  stats.entities = plan.entities.length;
  stats.relations = plan.relations.length;
  stats.entityAliases = plan.entityAliases.length;
  stats.persona = plan.persona.length;
  stats.candidates = plan.candidates.length;
  if (dryRun) return stats;

  const idMap = new Map();
  transaction(s.db, () => {
    for (const note of plan.notes) {
      const info = prepareCached(s.db, `
        INSERT INTO notes(
          ts, scope, text, importance, source, revision, superseded_by, contested, deleted_at,
          verification, verified_at, evidence, problem_key, solution_status,
          solution_verified_at, reuse_count, last_used_at,
          recall_count, last_recall_at, useful_count, misleading_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(note.ts ?? now()), note.scope ?? SCOPE_GLOBAL, String(note.text),
        Number(note.importance ?? 0.5), note.source ?? null, Number(note.revision ?? 1),
        note.superseded_by ?? null, Number(note.contested ?? 0), note.deleted_at ?? null,
        note.verification ?? null, note.verified_at ?? null, note.evidence ?? null,
        note.problem_key ?? note.problemKey ?? null,
        note.solution_status ?? note.solutionStatus ?? null,
        note.solution_verified_at ?? note.solutionVerifiedAt ?? null,
        Number(note.reuse_count ?? note.reuseCount ?? 0),
        note.last_used_at ?? note.lastUsedAt ?? null,
        Number(note.recall_count ?? note.recallCount ?? 0),
        note.last_recall_at ?? note.lastRecallAt ?? null,
        Number(note.useful_count ?? note.usefulCount ?? 0),
        Number(note.misleading_count ?? note.misleadingCount ?? 0),
      );
      const newId = Number(info.lastInsertRowid);
      idMap.set(Number(note.id), newId);
      if (s.fts.notes) {
        try { prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(newId, String(note.text)); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'note', newId, String(note.text));
      upsertVector(s, 'note', newId, String(note.text));
    }
    // Remap note lineage pointers to the ids assigned in this database. A
    // pointer outside the imported snapshot must become null; falling back to
    // the source id would point at an unrelated local note with that id.
    for (const note of plan.notes) {
      const replacement = Number(note.superseded_by ?? 0);
      if (!replacement) continue;
      const newId = idMap.get(Number(note.id));
      const target = idMap.get(replacement);
      if (newId) {
        prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?')
          .run(target ?? null, newId);
      }
    }
    plan.facts.sort((a, b) => Number(a.valid_from ?? 0) - Number(b.valid_from ?? 0));
    for (const fact of plan.facts) {
      const factScope = fact.scope ?? SCOPE_GLOBAL;
      const factFrom = Number(fact.valid_from ?? now());
      const cardinality = fact.cardinality === 'multi' ? 'multi' : relationCardinality(s.db, String(fact.relation));
      const factActive = fact.valid_to === null || fact.valid_to === undefined;
      let validTo = fact.valid_to ?? null;
      // Importing a snapshot used to bypass the write path's single-value rule:
      // local "裸机" and imported "Docker" both stayed valid_to=NULL. Sort by
      // valid_from and close the rows this imported value actually replaces;
      // if a newer local fact already exists, keep the imported one historical.
      if (factActive && !fact.deleted_at && cardinality !== 'multi') {
        const current = activeFactRows.all(String(fact.subject), String(fact.relation), factScope, factScope);
        const newer = current.filter(row => Number(row.valid_from ?? 0) > factFrom);
        if (newer.length) {
          validTo = Math.min(...newer.map(row => Number(row.valid_from)));
        } else {
          for (const row of current) {
            prepareCached(s.db, 'UPDATE facts SET valid_to = ? WHERE id = ?').run(factFrom, Number(row.id));
            prepareCached(s.db, `
              UPDATE edges SET valid_to = ?
              WHERE src = ? AND rel = ? AND dst = ? AND valid_to IS NULL
                AND (scope = ? OR scope IS NULL)
            `).run(factFrom, String(fact.subject), String(fact.relation), String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL);
          }
        }
      }
      const info = prepareCached(s.db, `
        INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, contested, scope, deleted_at, cardinality,
          recall_count, last_recall_at, useful_count, misleading_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(fact.subject), String(fact.relation), String(fact.object ?? ''),
        String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`),
        factFrom, validTo, fact.recorded_at ?? null,
        Number(fact.confidence ?? 0.7), fact.source ?? null, Number(fact.contested ?? 0),
        factScope, fact.deleted_at ?? null, cardinality,
        Number(fact.recall_count ?? fact.recallCount ?? 0),
        fact.last_recall_at ?? fact.lastRecallAt ?? null,
        Number(fact.useful_count ?? fact.usefulCount ?? 0),
        Number(fact.misleading_count ?? fact.misleadingCount ?? 0),
      );
      const newId = Number(info.lastInsertRowid);
      if (s.fts.facts) {
        try { prepareCached(s.db, 'INSERT INTO facts_fts(rowid, text) VALUES (?, ?)').run(newId, String(fact.text ?? '')); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'fact', newId, String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`));
      upsertVector(s, 'fact', newId, String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`));
    }
    for (const chunk of plan.chunks) {
      const text = String(chunk.text);
      const info = prepareCached(s.db, `
        INSERT INTO chunks(ts, session_id, role, text, hash, source, importance, scope, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(chunk.ts ?? now()), chunk.session_id ?? null, chunk.role ?? 'note', text,
        hash(text), chunk.source ?? null, Number(chunk.importance ?? 0.5), chunk.scope ?? null,
        chunk.deleted_at ?? null,
      );
      const newId = Number(info.lastInsertRowid);
      if (s.fts.chunks) {
        try { prepareCached(s.db, 'INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(newId, text); } catch { /* duplicate */ }
      }
      indexBigrams(s.db, 'chunk', newId, text);
      upsertVector(s, 'chunk', newId, text);
    }
    for (const candidate of plan.candidates) {
      prepareCached(s.db, `
        INSERT INTO note_candidates(ts, scope, text, hash, source, chunk_id, confidence, status)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending')
      `).run(
        Number(candidate.ts ?? now()), candidate.scope ?? SCOPE_GLOBAL, String(candidate.text),
        String(candidate.hash), candidate.source ?? null, Number(candidate.confidence ?? 0.5),
      );
    }
    for (const edge of plan.edges) {
      prepareCached(s.db, `
        INSERT INTO edges(src, rel, dst, valid_from, valid_to, scope, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(edge.src), String(edge.rel), String(edge.dst),
        Number(edge.valid_from ?? now()), edge.valid_to ?? null,
        edge.scope ?? null, edge.source ?? null,
      );
    }
    for (const name of plan.entities) prepareCached(s.db, 'INSERT OR IGNORE INTO entities(name) VALUES (?)').run(name);
    for (const relation of plan.relations) {
      prepareCached(s.db, `
        INSERT INTO relations(name, cardinality, aliases, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          cardinality = excluded.cardinality,
          aliases = excluded.aliases,
          updated_at = excluded.updated_at
      `).run(
        String(relation.name), String(relation.cardinality ?? 'single'),
        relation.aliases === null || relation.aliases === undefined ? null : String(relation.aliases),
        Number(relation.updated_at ?? now()),
      );
    }
    for (const alias of plan.entityAliases) {
      prepareCached(s.db, `
        INSERT INTO entity_aliases(alias, canonical, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET
          canonical = excluded.canonical,
          updated_at = excluded.updated_at
      `).run(String(alias.alias), String(alias.canonical), Number(alias.updated_at ?? now()));
    }
    for (const setting of plan.persona) {
      prepareCached(s.db, `
        INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(String(setting.key), String(setting.value), Number(setting.updated_at ?? now()));
    }
  });
  entityCache = { names: [], at: 0 };
  invalidateProfile();
  return stats;
}

/** Revive one tombstoned row and restore its derived indexes. */
function restoreMemory(s, kind, id, scope = SCOPE_GLOBAL) {
  const table = { note: 'notes', fact: 'facts', chunk: 'chunks' }[String(kind)];
  if (!table) throw new Error('kind must be note, fact or chunk');
  const filter = scopeClause('scope', scope);
  const result = transaction(s.db, () => {
    const row = prepareCached(s.db, `SELECT * FROM ${table} WHERE id = ? ${filter.sql}`)
      .get(Number(id), ...filter.params);
    if (!row) return { restored: false, reason: 'not found or outside the current project' };
    if (!row.deleted_at) return { restored: false, reason: 'not tombstoned' };
    if (table === 'chunks') {
      // The unique index is (hash, scope) among active rows. Restoring an old
      // copy while a newer active copy exists would abort the whole transaction
      // with a raw UNIQUE error; return a structured conflict instead.
      const active = prepareCached(s.db, `
        SELECT id FROM chunks
        WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')
          AND deleted_at IS NULL AND id <> ?
      `).get(row.hash, row.scope, Number(id));
      if (active) return { restored: false, reason: 'active duplicate', activeId: Number(active.id) };
    }
    if (table === 'facts') {
      // Facts use bi-temporal validity, not a tombstone-only model. Restoring an
      // old version while a newer version of the same triple is active would
      // create two concurrent truths. Refuse and report the active row.
      const active = prepareCached(s.db, `
        SELECT id, object FROM facts
        WHERE subject = ? AND relation = ? AND object = ?
          AND IFNULL(scope, 'global') = ?
          AND valid_to IS NULL AND deleted_at IS NULL AND id <> ?
      `).get(row.subject, row.relation, String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL, Number(id));
      if (active) return { restored: false, reason: 'active duplicate', activeId: Number(active.id) };
      // Single-valued relations may not hold two different active objects either.
      // Restore is an undo, not an override: the caller must forget/expire the
      // current value first, then restore the old one.
      if (relationCardinality(s.db, row.relation) === 'single') {
        const activeValue = prepareCached(s.db, `
          SELECT id, object FROM facts
          WHERE subject = ? AND relation = ? AND IFNULL(scope, 'global') = ?
            AND valid_to IS NULL AND deleted_at IS NULL AND id <> ?
          LIMIT 1
        `).get(row.subject, row.relation, row.scope ?? SCOPE_GLOBAL, Number(id));
        if (activeValue) {
          return {
            restored: false,
            reason: 'single-valued relation already has an active value',
            activeId: Number(activeValue.id),
            activeObject: activeValue.object,
          };
        }
      }
    }
    if (table === 'notes') {
      // Restoring a tombstoned note while another active note has the same text
      // in the same scope would recreate the duplicate FR-01 forbids.
      const activeText = prepareCached(s.db, `
        SELECT id FROM notes
        WHERE IFNULL(scope, 'global') = ? AND text = ?
          AND deleted_at IS NULL AND superseded_by IS NULL AND id <> ?
      `).get(row.scope ?? SCOPE_GLOBAL, row.text, Number(id));
      if (activeText) return { restored: false, reason: 'active duplicate', activeId: Number(activeText.id) };
      // A tombstoned note may also have been superseded by a newer conclusion.
      // Restoring it must clear both states, otherwise the row is visible in the
      // audit list but still excluded from active search.
      prepareCached(s.db, 'UPDATE notes SET deleted_at = NULL, superseded_by = NULL WHERE id = ?').run(Number(id));
    } else if (table === 'facts') {
      prepareCached(s.db, 'UPDATE facts SET deleted_at = NULL, valid_to = NULL WHERE id = ?').run(Number(id));
    } else {
      prepareCached(s.db, 'UPDATE chunks SET deleted_at = NULL WHERE id = ?').run(Number(id));
    }
    if (table === 'notes') {
      if (s.fts.notes) {
        try { prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(Number(id), row.text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'note', Number(id), row.text);
      upsertVector(s, 'note', Number(id), row.text);
    } else if (table === 'facts') {
      const text = String(row.text ?? `${row.subject} ${row.relation} ${row.object}`);
      if (s.fts.facts) {
        try { prepareCached(s.db, 'INSERT INTO facts_fts(rowid, text) VALUES (?, ?)').run(Number(id), text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'fact', Number(id), text);
      upsertVector(s, 'fact', Number(id), text);
      const edge = prepareCached(s.db, `
        SELECT id FROM edges WHERE src = ? AND rel = ? AND dst = ?
          AND (scope = ? OR scope IS NULL)
      `).get(row.subject, row.relation, String(row.object ?? ''), row.scope ?? SCOPE_GLOBAL);
      if (edge) {
        prepareCached(s.db, 'UPDATE edges SET valid_to = NULL WHERE id = ?').run(Number(edge.id));
      } else {
        prepareCached(s.db, 'INSERT INTO edges(src, rel, dst, valid_from, scope, source) VALUES (?, ?, ?, ?, ?, ?)')
          .run(row.subject, row.relation, String(row.object ?? ''), Number(row.valid_from ?? now()), row.scope ?? SCOPE_GLOBAL, row.source ?? null);
      }
    } else {
      if (s.fts.chunks) {
        try { prepareCached(s.db, 'INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(Number(id), row.text); } catch { /* already indexed */ }
      }
      indexBigrams(s.db, 'chunk', Number(id), row.text);
      upsertVector(s, 'chunk', Number(id), row.text);
    }
    return { restored: true };
  });
  if (result.restored) invalidateProfile();
  return result;
}

function insertChunk(s, input) {
  const { db, ftsMode } = s;
  const text = String(input.text ?? '').trim();
  if (!text) return null;
  const digest = hash(text);
  const scope = input.scope ?? null;
  return transaction(db, () => {
    // Inside the write lock: two hosts writing the same transcript line would
    // otherwise both pass the check and insert a duplicate chunk.
    const existing = prepareCached(db, `
      SELECT id FROM chunks
      WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global') AND deleted_at IS NULL
    `).get(digest, scope);
    if (existing) return { id: Number(existing.id), deduped: true };
    const ts = Number(input.ts ?? now());
    const info = prepareCached(db,
      'INSERT INTO chunks(ts, session_id, role, text, hash, source, importance, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      ts,
      input.sessionId ?? null,
      input.role ?? 'note',
      text,
      digest,
      input.source ?? null,
      Number(input.importance ?? 0.5),
      scope,
    );
    const id = Number(info.lastInsertRowid);
    if (ftsMode !== 'like') {
      try {
        prepareCached(db, 'INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(id, text);
      } catch { /* index write is best effort */ }
    }
    indexBigrams(db, 'chunk', id, text);
    upsertVector(s, 'chunk', id, text);
    return { id, deduped: false };
  });
}


const CANDIDATE_ROLES = new Set(['user', 'assistant', 'system', 'tool', 'note']);
function resolveTranscriptScope(input, toolContext, db = openStore().db) {
  const requested = normalizeScopeInput(input.scope);
  if (requested === 'all') throw new Error('transcripts cannot be written to scope=all');
  if (requested === 'project') return currentProject(toolContext) ?? SCOPE_GLOBAL;
  if (requested) return requested;
  const cwd = String(input.cwd ?? '').trim();
  if (cwd) return resolveProjectKey(db, cwd);
  return currentProject(toolContext) ?? SCOPE_GLOBAL;
}

function insertNoteCandidate(s, input) {
  const scope = String(input.scope ?? SCOPE_GLOBAL);
  const text = String(input.text ?? '').trim();
  if (!text) return null;
  const digest = hash(`${scope}\n${text}`);
  const existing = prepareCached(s.db, `
    SELECT id FROM note_candidates
    WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global') AND status = 'pending'
  `).get(digest, scope);
  if (existing) return { id: Number(existing.id), deduped: true };
  const info = prepareCached(s.db, `
    INSERT INTO note_candidates(ts, scope, text, hash, source, chunk_id, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(input.ts ?? now()), scope, text, digest,
    input.source ?? null, input.chunkId ?? null, Number(input.confidence ?? 0.5),
  );
  return { id: Number(info.lastInsertRowid), deduped: false };
}

/**
 * Ingest one transcript turn from any host. This is the non-DSH counterpart of
 * `captureEvent`: it never creates a note directly, only chunks and pending
 * candidates. Callers can disable extraction with extract=false.
 */
export function ingestTranscript(input = {}, toolContext = {}) {
  const s = openStore();
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('text is required');
  const role = String(input.role ?? 'user').trim().toLowerCase();
  if (!CANDIDATE_ROLES.has(role)) throw new Error('role must be user, assistant, system, tool or note');
  let importance = role === 'user' ? 0.6 : role === 'assistant' ? 0.4 : 0.5;
  if (input.importance != null) {
    importance = Number(input.importance);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new Error('importance must be a number between 0 and 1');
    }
  }
  const sessionId = String(input.sessionId ?? toolContext?.session?.id ?? '').trim() || null;
  const scope = resolveTranscriptScope(input, toolContext, s.db);
  const truncated = text.length > MAX_CAPTURE_CHARS;
  const storedText = truncated ? text.slice(0, MAX_CAPTURE_CHARS) : text;
  if (sessionId && scope !== SCOPE_GLOBAL) {
    try { metaSet(openStore().db, `agent_project:${sessionId}`, scope); } catch { /* best effort */ }
  }
  const chunk = insertChunk(s, {
    text: storedText,
    role,
    sessionId,
    source: input.source ?? `ingest:${sessionId ?? 'anonymous'}`,
    importance,
    scope,
    ts: input.ts,
  });
  if (!chunk) throw new Error('text is required');
  const candidates = [];
  const extract = input.extract !== false && input.extract !== '0';
  if (!chunk.deduped && extract) {
    for (const item of extractCandidateTexts(storedText, role)) {
      const candidate = insertNoteCandidate(s, {
        text: item.text,
        confidence: item.confidence,
        scope,
        source: `chunk:${chunk.id}`,
        chunkId: chunk.id,
      });
      if (candidate) candidates.push({ ...candidate, text: item.text, confidence: item.confidence });
    }
  }
  return {
    id: Number(chunk.id),
    deduped: Boolean(chunk.deduped),
    scope,
    sessionId,
    chars: storedText.length,
    truncated,
    candidates,
  };
}

function candidateScope(options = {}, toolContext = {}, db = openStore().db) {
  const requested = normalizeScopeInput(options.scope);
  if (requested === 'all') return null;
  if (requested === 'project') return 'project';
  if (requested) return requested;
  const cwd = String(options.cwd ?? '').trim();
  if (cwd) return resolveProjectKey(db, cwd);
  return currentProject(toolContext) || SCOPE_GLOBAL;
}

/** List pending candidates. Default visibility is current project + global. */
export function listNoteCandidates(options = {}, toolContext = {}) {
  const s = openStore();
  const status = String(options.status ?? 'pending').trim().toLowerCase();
  if (!['pending', 'accepted', 'rejected', 'all'].includes(status)) {
    throw new Error('status must be pending, accepted, rejected or all');
  }
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? 20) || 20));
  const scope = candidateScope(options, toolContext, s.db);
  const clause = scopeClause('scope', scope, true);
  const parts = [];
  if (status !== 'all') parts.push('status = ?');
  if (clause.sql) parts.push(clause.sql.replace(/^AND\s*/, ''));
  const where = parts.join(' AND ') || '1=1';
  const params = status === 'all' ? [] : [status];
  const total = Number(prepareCached(s.db, `SELECT COUNT(*) AS n FROM note_candidates WHERE ${where}`)
    .get(...params, ...clause.params)?.n ?? 0);
  const rows = prepareCached(s.db, `
    SELECT id, ts, scope, text, source, chunk_id, confidence, status, reviewed_at, note_id, reason
    FROM note_candidates
    WHERE ${where}
    ORDER BY ts DESC, id DESC LIMIT ?
  `).all(...params, ...clause.params, limit);
  return {
    action: 'list',
    status,
    scope: scope ?? 'all',
    total,
    candidates: rows.map(row => ({
      id: Number(row.id),
      ts: Number(row.ts),
      scope: row.scope ?? SCOPE_GLOBAL,
      text: String(row.text),
      source: row.source ?? null,
      chunkId: row.chunk_id == null ? null : Number(row.chunk_id),
      confidence: Number(row.confidence ?? 0.5),
      status: String(row.status ?? 'pending'),
      reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
      noteId: row.note_id == null ? null : Number(row.note_id),
      reason: row.reason ?? null,
    })),
  };
}

function writeCandidateNoteInTransaction(s, row) {
  const text = String(row.text ?? '').trim();
  const scope = String(row.scope ?? SCOPE_GLOBAL);
  if (!text) throw new Error('candidate text is empty');
  const existing = prepareCached(s.db, `
    SELECT id FROM notes
    WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL
  `).get(scope, text);
  if (existing) return { id: Number(existing.id), deduped: true };
  const candidateTs = Number(row.ts);
  const ts = Number.isFinite(candidateTs) && candidateTs > 0 ? candidateTs : now();
  const confidence = Number(row.confidence);
  const importance = Number.isFinite(confidence)
    ? Number(Math.min(0.9, Math.max(0.3, 0.4 + confidence * 0.4)).toFixed(3))
    : 0.55;
  const source = row.source ? `${row.source} · candidate:${row.id}` : `candidate:${row.id}`;
  const raced = prepareCached(s.db, `
    SELECT id FROM notes
    WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL
  `).get(scope, text);
  if (raced) return { id: Number(raced.id), deduped: true };
  const info = prepareCached(s.db, `
    INSERT INTO notes(ts, scope, text, importance, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(ts, scope, text, importance, source);
  const noteId = Number(info.lastInsertRowid);
  if (s.fts.notes) {
    try { prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(noteId, text); } catch { /* index best effort */ }
  }
  indexBigrams(s.db, 'note', noteId, text);
  upsertVector(s, 'note', noteId, text);
  return { id: noteId, deduped: false };
}

/** Accept or reject one pending candidate. Cross-project review requires scope=all. */export function reviewNoteCandidate(id, action, options = {}, toolContext = {}) {
  const s = openStore();
  const candidateId = Number(id);
  if (!Number.isFinite(candidateId) || candidateId <= 0) throw new Error('id must be a positive number');
  const normalized = String(action ?? '').trim().toLowerCase();
  if (!['accept', 'reject'].includes(normalized)) throw new Error('action must be accept or reject');
  const scope = candidateScope(options, toolContext, s.db);
  const clause = scopeClause('scope', scope, true);
  const row = prepareCached(s.db, `
    SELECT * FROM note_candidates WHERE id = ? ${clause.sql}
  `).get(candidateId, ...clause.params);
  if (!row) throw new Error('candidate not found or outside the current project');
  if (String(row.status) !== 'pending') throw new Error(`candidate is already ${row.status}`);
  const ts = now();
  if (normalized === 'reject') {
    transaction(s.db, () => {
      prepareCached(s.db, `
        UPDATE note_candidates SET status = 'rejected', reviewed_at = ?, reason = ? WHERE id = ?
      `).run(ts, String(options.reason ?? '').trim().slice(0, 500) || null, candidateId);
    });
    return { action: 'reject', id: candidateId, status: 'rejected' };
  }
  let accepted = row;
  const note = transaction(s.db, () => {
    const current = prepareCached(s.db, `
      SELECT * FROM note_candidates WHERE id = ? ${clause.sql}
    `).get(candidateId, ...clause.params);
    if (!current) throw new Error('candidate not found or outside the current project');
    if (String(current.status) !== 'pending') throw new Error(`candidate is already ${current.status}`);
    accepted = current;
    const written = writeCandidateNoteInTransaction(s, current);
    prepareCached(s.db, `
      UPDATE note_candidates SET status = 'accepted', reviewed_at = ?, note_id = ? WHERE id = ?
    `).run(now(), Number(written.id), candidateId);
    return written;
  });
  invalidateProfile();
  return {
    action: 'accept', id: candidateId, status: 'accepted',
    noteId: Number(note.id), deduped: Boolean(note.deduped), scope: accepted.scope ?? SCOPE_GLOBAL,
  };
}

/**
 * Consolidate active notes that share one problemKey into a source-linked
 * summary. Dry-run is the default; apply=true supersedes the inputs, never
 * deletes them. The summary carries the summed feedback counters so ranking
 * quality survives the merge.
 */
export function consolidateProblemNotes(problemKey, options = {}, toolContext = {}) {
  const s = openStore();
  const key = normalizeProblemKey(problemKey);
  if (!key) throw new Error('problemKey is required');
  const requested = normalizeScopeInput(options.scope);
  if (requested === 'all' || requested === 'project') {
    throw new Error('consolidation needs one exact scope; all/project would mix layers');
  }
  const scope = requested || currentProject(toolContext) || SCOPE_GLOBAL;
  const minNotes = Math.min(10, Math.max(2, Number(options.minNotes ?? 2) || 2));
  const rows = prepareCached(s.db, `
    SELECT * FROM notes
    WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
      AND problem_key = ? AND scope = ?
    ORDER BY ts ASC, id ASC
  `).all(key, scope);
  if (rows.length < minNotes) {
    return { problemKey: key, scope, applied: false, reason: 'not enough active notes', notes: rows.length };
  }
  const ids = rows.map(row => Number(row.id));
  const summary = summarizeProblemNotes(key, rows);
  if (options.apply !== true) {
    return { problemKey: key, scope, applied: false, notes: rows.length, sourceIds: ids, summary };
  }
  const result = transaction(s.db, () => {
    const active = prepareCached(s.db, `
      SELECT * FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
        AND problem_key = ? AND scope = ?
      ORDER BY ts ASC, id ASC
    `).all(key, scope);
    if (active.length < minNotes) return { applied: false, reason: 'not enough active notes' };
    const activeIds = active.map(row => Number(row.id));
    const summaryText = summarizeProblemNotes(key, active);
    const hasVerified = active.some(row => String(row.solution_status ?? '') === 'verified');
    const allFailed = active.every(row => ['failed', 'expired'].includes(String(row.solution_status ?? '')));
    const ts = now();
    const importance = Math.min(1, Math.max(...active.map(row => Number(row.importance ?? 0.35))) + 0.1);
    const info = prepareCached(s.db, `
      INSERT INTO notes(
        ts, scope, text, importance, source, problem_key, solution_status,
        solution_verified_at, reuse_count, last_used_at, evidence,
        recall_count, last_recall_at, useful_count, misleading_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts, scope, summaryText, importance,
      `consolidate:${activeIds.join(',')}`, key,
      hasVerified ? 'verified' : allFailed ? 'failed' : 'unverified',
      hasVerified ? ts : null,
      active.reduce((sum, row) => sum + Number(row.reuse_count ?? 0), 0),
      Math.max(...active.map(row => Number(row.last_used_at ?? 0))) || null,
      `sources: ${activeIds.map(id => `n:${id}`).join(', ')}`,
      active.reduce((sum, row) => sum + Number(row.recall_count ?? 0), 0),
      Math.max(...active.map(row => Number(row.last_recall_at ?? 0))) || null,
      active.reduce((sum, row) => sum + Number(row.useful_count ?? 0), 0),
      active.reduce((sum, row) => sum + Number(row.misleading_count ?? 0), 0),
    );
    const summaryId = Number(info.lastInsertRowid);
    if (s.fts.notes) {
      try { prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(summaryId, summaryText); } catch { /* index best effort */ }
    }
    indexBigrams(s.db, 'note', summaryId, summaryText);
    upsertVector(s, 'note', summaryId, summaryText);
    const update = prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?');
    for (const id of activeIds) {
      update.run(summaryId, id);
      dropDerivedIndexes(s, 'note', id);
    }
    return { applied: true, noteId: summaryId, sourceIds: activeIds, summary: summaryText };
  });
  if (result.applied) invalidateProfile();
  return { problemKey: key, scope, ...result, notes: result.sourceIds?.length ?? rows.length };
}

function summarizeProblemNotes(problemKey, rows) {
  const groups = [
    ['verified', '已验证'],
    ['unverified', '未验证'],
    ['failed', '失败尝试'],
    ['expired', '已过期'],
  ];
  const lines = [`问题 ${problemKey}`];
  for (const [status, label] of groups) {
    const items = rows.filter(row => String(row.solution_status ?? 'unverified') === status);
    if (!items.length) continue;
    lines.push(`[${label}]`);
    for (const row of items) {
      lines.push(`- ${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  return lines.join('\n').slice(0, 4000);
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
const SEARCH_WINDOW = Math.max(1000, Number(process.env.OMNI_SEARCH_WINDOW ?? 20000));
const FTS_SAMPLE = 120;
const BIGRAM_SAMPLE = 200;

/** Recent-window substring scan: bounded by window size, recency biased. */
function recentWindowRows(db, table, terms, columns, filter, limit, extra = '') {
  const clause = likeClause(columns, terms);
  try {
    const max = Number(prepareCached(db, `SELECT MAX(id) AS n FROM ${table}`).get()?.n ?? 0);
    if (!max) return [];
    return prepareCached(db, `
      SELECT * FROM ${table}
      WHERE id > ? AND deleted_at IS NULL ${extra} AND ${clause.sql} ${filter.sql}
      ORDER BY id DESC LIMIT ?
    `).all(max - SEARCH_WINDOW, ...clause.params, ...filter.params, Math.max(limit * 4, 16));
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
  entityCache = { names: [], at: 0 };
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
      text: String(row.text).slice(0, 400),
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
      text: String(row.text).slice(0, 400),
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
        text: String(row.text).slice(0, 400),
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
      text: String(row.text).slice(0, 400),
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
            'INSERT INTO notes(ts, scope, text, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(now(), note.scope, replacementText, 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
          const replacementId = Number(info.lastInsertRowid);
          prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?').run(replacementId, Number(note.id));
          dropDerivedIndexes(s, 'note', note.id);
          if (s.fts.notes) {
            try {
              prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)')
                .run(replacementId, replacementText);
            } catch { /* best effort */ }
          }
          indexBigrams(s.db, 'note', replacementId, replacementText);
          upsertVector(s, 'note', replacementId, replacementText);
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
      'INSERT INTO notes(ts, scope, text, importance, source, revision) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(now(), note.scope, replacementText, 0.5, `dream:${note.id}`, Number(note.revision ?? 1) + 1);
    const replacementId = Number(info.lastInsertRowid);
    prepareCached(s.db, 'UPDATE notes SET superseded_by = ?, contested = 1 WHERE id = ?').run(replacementId, Number(note.id));
    dropDerivedIndexes(s, 'note', note.id);
    if (s.fts.notes) {
      try { prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(replacementId, replacementText); } catch { /* best effort */ }
    }
    indexBigrams(s.db, 'note', replacementId, replacementText);
    upsertVector(s, 'note', replacementId, replacementText);
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
    // The original vector was removed when the note was superseded; restore it
    // so a rollback does not leave a live note without a semantic entry.
    if (note.text) upsertVector(s, 'note', note.id, note.text);
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
// candidates. A real ANN index is the next step, not a requirement for bounded
// latency.
const VECTOR_SAMPLE = Math.max(1000, Number(process.env.OMNI_VECTOR_SAMPLE ?? 5000));

async function semanticSearch(s, queryText, limit, scope, candidates = []) {
  const config = semanticConfig();
  if (!config.enabled) return [];
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
  for (const spec of specList) {
    const sampleIds = [];
    try {
      for (const row of prepareCached(s.db, `
        SELECT owner_id FROM semantic_vectors
        WHERE model = ? AND kind = ? AND dim = ?
        ORDER BY owner_id DESC LIMIT ?
      `).all(config.signature, spec.kind, config.dim, VECTOR_SAMPLE)) sampleIds.push(Number(row.owner_id));
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
            text: String(row.text ?? '').slice(0, 400),
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
  for (const spec of specs) {
    // Sample owner ids first: a JOIN with a scope filter does not stop at LIMIT
    // when the filter rejects the first rows, so a project-scoped search used to
    // read every vector in the table.
    const sampleIds = [];
    try {
      for (const row of prepareCached(s.db, `
        SELECT owner_id FROM vectors WHERE kind = ? AND dim = ?
        ORDER BY owner_id DESC LIMIT ?
      `).all(spec.kind, dim, VECTOR_SAMPLE)) sampleIds.push(Number(row.owner_id));
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
        text: String(row.text ?? '').slice(0, 400),
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

/** Drop duplicate sentences across layers, keeping the best-scoring copy. */
function finalizeHits(ranked, limit) {
  const seen = new Set();
  const hits = [];
  // A transcript chunk is evidence, not the conclusion. When an accepted note
  // and its source chunk collapse to the same text, keep the note visible in
  // search instead of letting the raw chunk shadow it. Do not stop at `limit`:
  // a higher-priority duplicate may appear later in the ranked list.
  const kindPriority = hit => hit.kind === 'note' ? 3 : hit.kind === 'fact' ? 2 : 1;
  const textKey = hit => String(hit.text).replace(/\s+/g, '').slice(0, 120);
  for (const hit of ranked) {
    const key = textKey(hit);
    const existing = hits.findIndex(item => textKey(item) === key);
    if (existing >= 0) {
      if (kindPriority(hit) > kindPriority(hits[existing])) hits[existing] = hit;
      continue;
    }
    if (hits.length < limit) {
      seen.add(key);
      hits.push(hit);
    }
  }
  return { total: hits.length, hits: hits.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0)) };
}

/** Reciprocal rank fusion of the lexical and vector routes. */
const CONTRADICTION_COSINE = 0.9;const GRAPH_HOPS = 2;
const GRAPH_DECAY = 0.5;
const GRAPH_MAX_SEEDS = 6;
let entityCache = { names: [], at: 0 };
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
  entityCache = { names, at: now() };
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
  // Diagnostic switch: OMNI_DISABLE_VECTOR=1 measures the lexical route alone.
  const useVector = process.env.OMNI_DISABLE_VECTOR !== '1';
  if (useVector) await flushPendingVectors(s);
  const vector = useVector ? (await timed('vector', () => vectorSearch(s, query, limit, scope, lexical))).filter(hitAllowed) : [];
  const semantic = useVector ? (await timed('semantic', () => semanticSearch(s, query, limit, scope, [...lexical, ...vector]))).filter(hitAllowed) : [];
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
function profileFactLines(db, scopeKey, budget) {
  const filter = scopeKey === null || scopeKey === undefined
    ? ''
    : scopeKey === SCOPE_GLOBAL
      ? "AND (scope = 'global' OR scope IS NULL)"
      : "AND (scope = ? OR scope = 'global' OR scope IS NULL)";
  let rows;
  try {
    rows = prepareCached(db, `
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL AND contested = 0 ${filter}
      ORDER BY confidence DESC, valid_from DESC LIMIT 40
    `).all(...(scopeKey && scopeKey !== SCOPE_GLOBAL ? [scopeKey] : []));
  } catch {
    return [];
  }
  if (!rows.length) return [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.subject}·${row.relation}`;
    const values = groups.get(key) ?? [];
    if (values.length < 3) values.push(String(row.object ?? ''));
    groups.set(key, values);
  }
  const lines = ['相关事实：'];
  let used = lines[0].length;
  for (const [key, values] of groups) {
    const [subject, relation] = key.split('·');
    const line = `${subject} · ${relation}：${values.join(' / ')}`;
    if (used + line.length > budget) break;
    used += line.length;
    lines.push(line);
  }
  return lines.length > 1 ? lines : [];
}

const PERSONA_MAX_VALUE = 1200;
const PERSONA_MAX_TOTAL = 4000;

function personaGet(db) {
  try {
    const rows = prepareCached(db, 'SELECT key, value FROM persona ORDER BY key').all();
    const out = {};
    for (const row of rows) out[String(row.key)] = String(row.value);
    return out;
  } catch {
    return {};
  }
}

/** Validate one persona map; arbitrary keys are allowed, values are plain text. */
function personaNormalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('values must be an object');
  const values = {};
  let total = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).trim();
    const value = String(rawValue ?? '').trim();
    if (!key) continue;
    if (key.length > 40) throw new Error('persona key is too long');
    if (value.length > PERSONA_MAX_VALUE) throw new Error(`persona value for "${key}" is too long`);
    if (!value) continue;
    total += value.length;
    values[key] = value;
  }
  if (total > PERSONA_MAX_TOTAL) throw new Error('persona settings are too long');
  return values;
}

function personaSet(db, input, options = {}) {
  const values = personaNormalize(input);
  transaction(db, () => {
    if (options.replace !== false) db.exec('DELETE FROM persona');
    const insert = prepareCached(db, `
      INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (const [key, value] of Object.entries(values)) insert.run(key, value, now());
  });
  return personaGet(db);
}

/** Evidence for persona synthesis: recent high-signal notes and active facts. */
function personaEvidence(db) {
  const notes = [];
  const facts = [];
  const technical = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP)/i;
  try {
    const rows = prepareCached(db, `
      SELECT text FROM notes
      WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY importance DESC, ts DESC LIMIT 40
    `).all();
    for (const row of rows) {
      const text = String(row.text);
      if (!technical.test(text)) notes.push(text);
    }
  } catch { /* ignore */ }
  try {
    const rows = prepareCached(db, `
      SELECT subject, relation, object FROM facts
      WHERE deleted_at IS NULL AND valid_to IS NULL AND contested = 0
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY confidence DESC, valid_from DESC LIMIT 80
    `).all();
    for (const row of rows) facts.push(`${row.subject} ${row.relation} ${row.object}`);
  } catch { /* ignore */ }
  const utterances = [];
  try {
    const rows = prepareCached(db, `
      SELECT text FROM chunks
      WHERE role = 'user' AND deleted_at IS NULL
        AND (scope = 'global' OR scope IS NULL)
      ORDER BY ts DESC LIMIT 100
    `).all();
    for (const row of rows) {
      const text = String(row.text);
      if (!technical.test(text) && text.length <= 600) utterances.push(text);
    }
  } catch { /* ignore */ }
  return { notes, facts, utterances };
}

const PERSONA_RELATIONS = {
  称呼: /^(称呼|名字|昵称|name)$/i,
  偏好: /(喜欢|偏好|讨厌|常用|习惯用|prefer)/i,
  习惯: /(习惯|每天|通常|定期|固定)/i,
  性格: /(性格|风格|说话)/i,
};

/** Rule extraction: works offline; the model only refines these results. */
function personaFromRules(evidence) {
  const out = {};
  const add = (key, value) => {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!personaValueOk(text)) return;
    out[key] = out[key] ? `${out[key]}；${text}` : text;
  };
  const userSubject = /^(用户|我|user|me)$/i;
  for (const line of evidence.facts) {
    const parts = String(line).split(' ');
    if (parts.length < 3) continue;
    const subject = parts[0];
    if (!userSubject.test(subject)) continue;
    const object = parts.slice(2).join(' ');
    const relation = parts[1];
    if (PERSONA_RELATIONS.称呼.test(relation)) add('称呼', object);
    else if (PERSONA_RELATIONS.偏好.test(relation)) add('偏好', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.习惯.test(relation)) add('习惯', `${relation} ${object}`);
    else if (PERSONA_RELATIONS.性格.test(relation)) add('性格', `${relation} ${object}`);
  }
  for (const note of [...evidence.utterances, ...evidence.notes]) {
    const patterns = [
      ['称呼', /(?:叫我|称呼我|可以叫我|我的名字是)[：:\s]*(?:是)?\s*([^\n。；，,]{1,20})/],
      ['性格', /(?:我的性格|回答风格|说话方式)[：:\s是为]+([^\n。；]{1,50})/],
      ['偏好', /我(?:更|最)?(?:喜欢|偏好|讨厌|不要)[^\n。；]{0,40}/],
      ['偏好', /(?:以后|今后)[^。；\n]{2,30}(?:都|统一|用|说)[^。；\n]{0,20}/],
      ['偏好', /(?:不要|别)[^。；\n]{4,30}/],
      ['习惯', /我(?:习惯|每天|通常|定期)[^\n。；]{0,40}/],
    ];
    for (const pair of patterns) {
      const key = pair[0];
      const match = String(note).match(pair[1]);
      if (match) add(key, match[1] ?? match[0]);
    }
  }
  return out;
}

const PERSONA_BAD_VALUE = /(插件|面板|schema|ADR|memory_|测试|路由|接口|迁移|数据库|函数|字段|版本|用例|构建|HTTP|JSON|body|sessionQuery|conversation|chat|flow|API|token|\/)/i;

function personaValueOk(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length < 2 || text.length > 200) return false;
  if (PERSONA_BAD_VALUE.test(text)) return false;
  // Reject heading residues and note fragments: markdown marks, em dashes,
  // blockquote/table syntax, or more than one clause separator. Those are
  // section titles copied out of a document, not a stable user setting.
  if (/[\]\[{}|*#`>]|——/.test(text)) return false;
  if ((text.match(/[。；;]/g) ?? []).length > 1) return false;
  if (/^(?:即|参见|详见|见第|第[一二三四五六七八九十\d]+[章节])/.test(text)) return false;
  return true;
}

function parsePersonaJson(text) {
  try {
    const match = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const out = {};
    for (const key of ['称呼', '性格', '习惯', '偏好', '其他']) {
      const value = String(parsed[key] ?? '').trim();
      if (personaValueOk(value)) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function personaFromModel(ctx, evidence) {
  try {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
    if (!llm || typeof llm.stream !== 'function') return null;
    const route = await pickJudgeRoute(llm);
    if (!route) return null;
    const evidenceText = [...evidence.utterances, ...evidence.facts, ...evidence.notes]
      .map(item => `- ${String(item).replace(/\s+/g, ' ').slice(0, 160)}`)
      .join('\n')
      .slice(0, 6000);
    if (!evidenceText) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let out = '';
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'Extract the long-lived settings of the user from their memory records. Fields: 称呼 (how to address them), 性格 (communication style), 习惯 (recurring routines), 偏好 (likes/dislikes), 其他. Only use facts present in the records; empty fields are allowed. Reply with a single JSON object using those keys.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `records:\n${evidenceText}\nJSON:` }] }],
        maxTokens: 400,
        temperature: 0,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text ?? '';
        else if (chunk?.type === 'finish') break;
      }
    } finally {
      clearTimeout(timer);
    }
    return parsePersonaJson(out);
  } catch {
    return null;
  }
}

/** Synthesize settings from everyday memory; rules first, model refinement second. */
/** Automatic persona synthesis must be explicitly opted in before it calls the host model. */
function personaModelEnabled() {
  const value = String(process.env.OMNI_PERSONA_MODEL ?? 'off').toLowerCase();
  return value === 'auto' || value === 'on' || value === '1';
}

async function personaRefresh(ctx, options = {}) {
  const s = openStore();
  const evidence = personaEvidence(s.db);
  const rules = personaFromRules(evidence);
  const model = options.model === true ? await personaFromModel(ctx ?? hostCtx, evidence) : null;
  const existing = personaGet(s.db);
  const merged = { ...existing, ...rules, ...model };
  const source = model ? 'model' : 'rules';
  const applied = options.apply === true && Object.keys(merged).length > 0;
  if (applied) {
    // Merge instead of replacing: a refresh that only found a preference must not
    // erase the user's hand-written name or custom fields.
    personaSet(s.db, merged, { replace: false });
    metaSet(s.db, 'persona_updated_at', now());
    metaSet(s.db, 'persona_source', source);
  }
  return {
    persona: options.apply === true ? personaGet(s.db) : merged,
    source,
    applied,
    modelUsed: Boolean(model),
    evidence: evidence.utterances.length + evidence.notes.length + evidence.facts.length,
  };
}

/** Occasionally re-derive persona from everyday memory (never blocks a write). */
function maybeRefreshPersona(ctx) {
  try {
    if (typeof ctx?.get !== 'function' || !ctx.get('llm')) return;
    const s = openStore();
    const pending = Number(metaGet(s.db, 'persona_pending') ?? 0) + 1;
    const last = Number(metaGet(s.db, 'persona_updated_at') ?? 0);
    if (pending < 20 || now() - last < 3_600_000) {
      metaSet(s.db, 'persona_pending', pending);
      return;
    }
    metaSet(s.db, 'persona_pending', 0);
    setTimeout(() => {
      void personaRefresh(ctx, { apply: true, model: personaModelEnabled() }).catch(() => {});
    }, 0);
  } catch { /* best effort */ }
}

/** Prompt lines for the always-injected persona block, kept short and explicit. */

function personaLines(db) {
  const values = personaGet(db);
  const keys = Object.keys(values);
  if (!keys.length) return [];
  const lines = ['用户长期设定（来自面板，高于临时指令）：'];
  for (const key of keys) {
    const line = `- ${key}：${String(values[key]).replace(/\s+/g, ' ').slice(0, 300)}`;
    lines.push(line);
  }
  return lines;
}

/** Join profile lines and enforce the budget on the final string, separators included. */
function capProfileLines(lines) {
  let text = lines.join('\n');
  while (text.length > PROFILE_BUDGET && lines.length) {
    lines.pop();
    text = lines.join('\n');
  }
  // Budget pressure must not leave a section heading with no rows beneath it.
  while (lines.length && /^##\s/.test(lines[lines.length - 1])) {
    lines.pop();
    text = lines.join('\n');
  }
  return text;
}

/** Read the highest-importance notes that fit the always-injected budget. */
function buildProfileText(projectKey, options = {}) {
  const s = openStore();
  const includeAll = options.includeAll === true;
  // Filter the layer in SQL instead of taking 60 rows from every project and
  // discarding most of them in JS: a busy foreign project could otherwise crowd
  // the global notes out of the profile budget.
  const noteScope = includeAll
    ? ''
    : projectKey
      ? "AND (scope = 'global' OR scope IS NULL OR scope = ?)"
      : "AND (scope = 'global' OR scope IS NULL)";
  const rows = prepareCached(s.db,
    `SELECT id, text, importance, scope FROM notes
     WHERE deleted_at IS NULL AND superseded_by IS NULL AND contested = 0
       AND COALESCE(solution_status, 'unverified') NOT IN ('failed', 'expired') ${noteScope}
     ORDER BY importance DESC, ts DESC LIMIT 60`
  ).all(...(projectKey ? [projectKey] : []));
  // Global notes follow the model everywhere; project notes only in their own
  // project. Unknown project => global only, so one project cannot leak into
  // another through the always-injected block.
  const visible = includeAll ? rows : rows.filter(row => {
    const scope = String(row.scope ?? 'global');
    if (scope === 'global' || scope === '') return true;
    return projectKey ? scope === projectKey : false;
  });
  const lines = [];
  let used = 0;
  const addLine = line => {
    if (used + line.length > PROFILE_BUDGET) return false;
    used += line.length;
    lines.push(line);
    return true;
  };
  // Layered profile: global rules first, then the current project's rules.
  // The headings make the budget boundary visible instead of silently mixing
  // two layers into one undifferentiated bullet list.
  const globalRows = visible.filter(row => String(row.scope ?? SCOPE_GLOBAL) === SCOPE_GLOBAL);
  const projectRows = projectKey
    ? visible.filter(row => String(row.scope ?? SCOPE_GLOBAL) === projectKey)
    : [];
  const addSection = (title, items) => {
    if (!items.length) return;
    // Don't spend budget on a heading unless at least one row can follow it.
    if (used + title.length + `- ${items[0].text}`.length > PROFILE_BUDGET) return;
    addLine(title);
    for (const row of items) {
      if (addLine(`- ${row.text}`) === false) break;
    }
  };
  addSection('## 全局', globalRows);
  addSection('## 当前项目', projectRows);
  if (includeAll) {
    const otherRows = visible.filter(row => {
      const scope = String(row.scope ?? SCOPE_GLOBAL);
      return scope !== SCOPE_GLOBAL && scope !== projectKey;
    });
    addSection('## 其他项目', otherRows);
  }

  for (const line of profileFactLines(s.db, projectKey || SCOPE_GLOBAL, PROFILE_BUDGET - used)) {
    const withBullet = line === '相关事实：' ? line : `- ${line}`;
    if (addLine(withBullet) === false) break;
  }
  return capProfileLines(lines);
}

const PACKET_BUDGET = 1800;

/**
 * Build the text a host with no prompt hook can splice in before a turn.
 *
 * This is deliberately transport-neutral: `memory_context` (MCP/CLI) and
 * `GET /omni-memory/packet` (browser/sidecar) return the same shape, while
 * `POST /omni-memory/tool` exposes the callable half to OpenAPI clients.
 */
async function buildMemoryPacket(scope, query, options = {}) {
  const limit = Math.min(10, Math.max(1, Number(options.limit ?? 5) || 5));
  const budget = Math.min(4000, Math.max(400, Number(options.budget ?? PACKET_BUDGET) || PACKET_BUDGET));
  const s = openStore();
  const persona = personaLines(s.db);
  const personaBody = persona.length ? persona.slice(1).join('\n').trim() : '';
  // `project` means "all project layers" for search, but the profile has no
  // single project to prefer, so it falls back to the global profile.
  const profileScope = scope && scope !== 'project' && scope !== 'all' ? scope : null;
  const profile = buildProfileText(profileScope).trim();
  const search = query ? await runSearch(s, query, limit, scope) : { hits: [] };
  const hits = (search.hits ?? [])
    .filter(hit => hit.kind !== 'note' || !['failed', 'expired'].includes(String(hit.solutionStatus ?? 'unverified')))
    .slice(0, limit);
  const sections = [];
  if (personaBody) sections.push('## 用户设定\n' + personaBody);
  if (profile && profile !== 'memory is empty') sections.push('## 常驻画像\n' + profile);
  if (hits.length) {
    sections.push('## 与当前任务相关\n' + hits.map(hit => {
      const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
      const flag = hit.contested ? ' · contested' : '';
      const status = hit.solutionStatus && hit.solutionStatus !== 'unverified' ? ` · ${hit.solutionStatus}` : '';
      return `- [${hit.kind}#${hit.id}] ${String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 220)}${layer}${status}${flag}`;
    }).join('\n'));
  }
  if (!sections.length) {
    return { text: '', chars: 0, hits: 0, truncated: false, memories: [] };
  }
  sections.push('以上内容可能过时。涉及删除、覆盖、外部发送等不可逆动作前，先 memory_search 复核。');
  const full = sections.join('\n\n');
  const text = full.length > budget ? full.slice(0, budget) : full;
  return {
    text,
    chars: text.length,
    hits: hits.length,
    truncated: text.length < full.length,
    memories: hits.map(hit => ({
      kind: hit.kind, id: hit.id, scope: hit.scope ?? null,
      solutionStatus: hit.solutionStatus ?? null, contested: Boolean(hit.contested),
      text: String(hit.text ?? '').slice(0, 220),
    })),
  };
}

/** OpenAPI document for the plain-HTTP host adapter. */
const HOST_OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'Omni Memory host adapter',
    version: '1.0.0',
    description: 'Loopback-only REST adapter for hosts without MCP. GET /packet returns prompt-ready context; POST /tool exposes the non-destructive memory tool subset. Writes require x-omni-csrf: 1.',
  },
  servers: [{ url: 'http://127.0.0.1:7788' }],
  paths: {
    '/omni-memory/packet': {
      get: {
        summary: 'Prompt-ready memory packet',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Current task text; omit for profile only.' },
          { name: 'scope', in: 'query', schema: { type: 'string' }, description: 'all, project, global, or one exact project key.' },
          { name: 'cwd', in: 'query', schema: { type: 'string' }, description: 'Derive the project layer from a working directory when scope is omitted.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10, default: 5 } },
          { name: 'budget', in: 'query', schema: { type: 'integer', minimum: 400, maximum: 4000, default: 1800 } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'text'], default: 'json' } },
        ],
        responses: { 200: { description: 'Packet JSON, or plain text when format=text' } },
      },
    },
    '/omni-memory/search': {
      get: {
        summary: 'Hybrid memory search',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 60, default: 30 } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Ranked hits' } },
      },
    },
    '/omni-memory/list': {
      get: { summary: 'Browse memories', parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 40 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        { name: 'scope', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: { description: 'Memory list and stats' } } },
    },
    '/omni-memory/node': {
      get: { summary: 'One entity or note detail', parameters: [
        { name: 'node', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'scope', in: 'query', schema: { type: 'string' } },
      ], responses: { 200: { description: 'Node detail' } } },
    },
    '/omni-memory/status': {
      get: { summary: 'Runtime status', responses: { 200: { description: 'Status' } } },
    },
    '/omni-memory/consolidate': {
      post: {
        summary: 'Consolidate notes sharing one problemKey',
        description: 'Requires x-omni-csrf: 1. Dry-run unless apply=1; applying supersedes the source notes, never deletes them.',
        parameters: [
          { name: 'problemKey', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' }, description: 'One exact global/project key; all and project are rejected.' },
          { name: 'minNotes', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 10, default: 2 } },
          { name: 'apply', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { 200: { description: 'Dry-run or applied summary' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/ingest': {
      post: {
        summary: 'Ingest one transcript turn from any host',
        description: 'Requires x-omni-csrf: 1. Writes a chunk and parks at most three candidates; never writes a note directly.',
        parameters: [
          { name: 'text', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['user', 'assistant', 'system', 'tool', 'note'], default: 'user' } },
          { name: 'sessionId', in: 'query', schema: { type: 'string' } },
          { name: 'source', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'importance', in: 'query', schema: { type: 'number', minimum: 0, maximum: 1 } },
          { name: 'extract', in: 'query', schema: { type: 'boolean', default: true } },
        ],
        responses: { 200: { description: 'Chunk id, scope and pending candidates' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/candidates': {
      get: {
        summary: 'List extracted note candidates',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'all'], default: 'pending' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { 200: { description: 'Candidate queue' } },
      },
    },
    '/omni-memory/candidate': {
      post: {
        summary: 'Accept or reject one candidate',
        description: 'Requires x-omni-csrf: 1. Accepting writes a normal note with the chunk source; review is scoped by default.',
        parameters: [
          { name: 'id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'action', in: 'query', required: true, schema: { type: 'string', enum: ['accept', 'reject'] } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'reason', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Review result' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
    '/omni-memory/tool': {
      post: {
        summary: 'Call one allowlisted memory tool',
        description: 'Requires header x-omni-csrf: 1. Names: memory_write, memory_search, memory_solution_report, memory_feedback, memory_get, memory_amend, memory_profile, memory_timeline.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['name'], additionalProperties: false,
            properties: {
              name: { type: 'string', enum: [...HTTP_TOOL_ALLOWLIST] },
              arguments: { type: 'object', additionalProperties: true },
            },
          } } },
        },
        responses: { 200: { description: 'Tool value and rendered text' }, 403: { description: 'Missing CSRF header or non-loopback caller' } },
      },
    },
  },
};

const profileCache = new Map();

function cachedProfile(projectKey) {
  const key = projectKey || 'global';
  const cached = profileCache.get(key);
  const nowMs = now();
  if (cached && nowMs - cached.at < PROFILE_CACHE_MS) return cached.text;
  let text = '';
  try {
    text = buildProfileText(projectKey);
  } catch {
    text = '';
  }
  profileCache.set(key, { text, at: nowMs });
  return text;
}

function invalidateProfile() {
  profileCache.clear();
}

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

function defineTools(ctx) {
  const disposers = [];

  const registerLocalTool = definition => {
    localToolDefinitions.set(definition.name, definition);
    const dispose = ctx.tools.register(definition);
    return () => {
      if (localToolDefinitions.get(definition.name) === definition) localToolDefinitions.delete(definition.name);
      if (typeof dispose === 'function') dispose();
    };
  };

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
      const kind = String(args.kind ?? 'note');
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
            const info = prepareCached(s.db, `
              INSERT INTO facts(subject, relation, object, text, valid_from, valid_to, recorded_at, confidence, source, scope, cardinality)
              VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
            `).run(
              subject, relation, object, text || `${subject} ${relation} ${object}`,
              ts, ts, 0.7, args.source ?? null, factScope, cardinality,
            );
            const factId = Number(info.lastInsertRowid);
            if (s.fts.facts) {
              try {
                prepareCached(s.db, 'INSERT INTO facts_fts(rowid, text) VALUES (?, ?)')
                  .run(factId, text || `${subject} ${relation} ${object}`);
              } catch { /* index write is best effort */ }
            }
            indexBigrams(s.db, 'fact', factId, text || `${subject} ${relation} ${object}`);
            upsertVector(s, 'fact', factId, text || `${subject} ${relation} ${object}`);
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
      const prev = prepareCached(s.db,
        'SELECT id, problem_key, solution_status, evidence FROM notes WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL'
      ).get(scope, text);
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
        const raced = prepareCached(s.db,
          'SELECT id FROM notes WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL'
        ).get(scope, text);
        if (raced) return { noteId: Number(raced.id), raced: true, contestedWith: [] };
        const info = prepareCached(s.db, `
          INSERT INTO notes(
            ts, scope, text, importance, source, problem_key, solution_status,
            solution_verified_at, reuse_count, last_used_at, evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `).run(
          ts, scope, text, importance, args.source ?? null,
          problemKey || null, requestedStatus,
          requestedStatus === 'verified' ? ts : null,
          evidence || null,
        );
        const noteId = Number(info.lastInsertRowid);
        if (s.fts.notes) {
          try {
            prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)')
              .run(noteId, text);
          } catch { /* index write is best effort */ }
        }
        indexBigrams(s.db, 'note', noteId, text);
        upsertVector(s, 'note', noteId, text);
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
        limit: { type: 'number', description: 'Maximum hits, default 8, max 30.' },
        rerank: { type: 'boolean', description: 'Set false to skip the optional cross-encoder reranker (OMNI_RERANK_*); defaults to the configured provider.' },
        scope: {
          type: 'string',
          description: "Optional layer filter: a project scope (returns that project plus global), 'global', or 'all'. Omit to use the current project when one is known.",
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { total: { type: 'number' }, scope: { type: 'string' }, problemKey: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value.hits.length) return textBlock(`no memory matched (scope ${value.scope ?? 'all'})`);
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
          return `${index + 1}. [${hit.kind}#${hit.id}${layer}${flag}${solution}${problem}${feedback}] ${hit.text.replace(/\s+/g, ' ')}${pointer}`;
        });
        return textBlock(`matched ${value.total} (scope ${value.scope ?? 'all'})\n${lines.join('\n')}`);
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
      const scope = requested === 'all' ? null : (requested || currentProject(toolContext) || SCOPE_GLOBAL);
      if (!queryTerms(query).length && !problemKey) {
        return { total: 0, scope: scope ?? 'all', hits: [] };
      }
      const exact = problemKey && (requestedKind === 'all' || requestedKind === 'note')
        ? searchProblemKey(s, problemKey, limit, scope, { status: requestedStatus })
        : [];
      const result = queryTerms(query).length
        ? await runSearch(s, query, limit, scope, { status: requestedStatus, kind: requestedKind, rerank: args.rerank })
        : { hits: [] };
      const merged = [];
      const seen = new Set();
      for (const hit of [...exact, ...result.hits]) {
        const key = `${hit.kind}:${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(hit);
        if (merged.length >= limit) break;
      }
      return {
        total: merged.length,
        scope: scope ?? 'all',
        ...(problemKey ? { problemKey } : {}),
        hits: merged,
      };
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
      const duplicate = prepareCached(s.db, `
        SELECT id FROM notes
        WHERE scope = ? AND text = ? AND deleted_at IS NULL AND superseded_by IS NULL AND id <> ?
      `).get(old.scope, text, id);
      if (duplicate) throw new Error(`an active note with the same text already exists: #${duplicate.id}`);
      const reason = String(args.reason ?? '').trim();
      const evidence = reason
        ? `${old.evidence ? `${old.evidence}\n` : ''}[amend] ${reason}`
        : (old.evidence ?? null);
      const ts = now();
      const result = transaction(s.db, () => {
        const info = prepareCached(s.db, `
          INSERT INTO notes(
            ts, scope, text, importance, source, revision, contested,
            problem_key, solution_status, solution_verified_at, reuse_count, last_used_at, evidence,
            verification, verified_at, recall_count, last_recall_at, useful_count, misleading_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ts, old.scope, text, Number(old.importance ?? 0.5), old.source ?? null,
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
        if (s.fts.notes) {
          try {
            prepareCached(s.db, 'INSERT INTO notes_fts(rowid, text) VALUES (?, ?)').run(newId, text);
          } catch { /* index write is best effort */ }
        }
        indexBigrams(s.db, 'note', newId, text);
        upsertVector(s, 'note', newId, text);
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
        return personaRefresh(hostCtx, {
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

export const inject = ['tools'];

/** Whether the optional HTTP route surface has been attached yet. */
let routeState = { status: 'pending', count: 0, at: 0, error: null };

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

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Host names a local service may answer for.
 *
 * A browser request is not authenticated by the socket alone: a DNS-rebinding
 * page also reaches 127.0.0.1. The Host header is the one field the page cannot
 * choose, so it must be one of the loopback names, an explicitly configured
 * bind address, or an operator-supplied allowlist.
 */
function trustedHostNames() {
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  const add = raw => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value || value === '0.0.0.0' || value === '::' || value === '*') return;
    const hostname = value.startsWith('[')
      ? value.slice(1, value.indexOf(']'))
      : value.split(':')[0];
    if (hostname) names.add(hostname);
  };
  for (const item of String(process.env.OMNI_TRUSTED_HOSTS ?? '').split(',')) add(item);
  add(process.env.OMNI_HTTP_BIND);
  return names;
}

function requestHostName(req) {
  const raw = String(req.headers?.host ?? '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function hostHeaderAllowed(req) {
  const name = requestHostName(req);
  return Boolean(name && trustedHostNames().has(name));
}

/**
 * Request-forgery guard for mutating routes.
 *
 * A browser sends Origin on cross-site POSTs; a local non-browser client may
 * omit it. An Origin is accepted only when its host is both the request Host
 * and a trusted local host name. The old check compared Origin with Host alone,
 * which let `Host: attacker.example` authenticate `Origin: attacker.example`
 * after DNS rebinding. The explicit CSRF header remains necessary because a
 * malicious page cannot send it without a CORS preflight this server never
 * grants.
 */
function sameOrigin(req) {
  if (String(req.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return true;
  if (!hostHeaderAllowed(req)) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const requestHost = String(req.headers?.host ?? '').trim().toLowerCase();
  return parsed.host.toLowerCase() === requestHost;
}

function mutationAllowed(req) {
  if (!sameOrigin(req)) return false;
  return String(req.headers?.['x-omni-csrf'] ?? '') === '1';
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

function readJsonBody(req, limit = 8192, options = {}) {
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

function registerRoutes(ctx) {
  const web = (ctx && typeof ctx.register === 'function' && typeof ctx.get !== 'function')
    ? ctx
    : serviceFrom(ctx, 'webServer');
  if (!web || typeof web.register !== 'function') {
    routeState = { status: 'pending', count: 0, at: now(), error: 'webServer not available' };
    return undefined;
  }

  const disposers = [];
  const add = route => {
    try {
      const dispose = web.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch { /* a missing route is not fatal */ }
  };

  add({
    kind: 'exact',
    path: '/omni-memory/packet',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
    path: '/omni-memory/ingest',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'ingest requires POST' });
      }
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'consolidate requires POST' });
      }
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
    path: '/omni-memory/candidates',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
    path: '/omni-memory/candidate',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'candidate requires POST' });
      }
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
    path: '/omni-memory/openapi.json',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        return json(res, 405, { ok: false, error: 'openapi.json requires GET' });
      }
      return json(res, 200, HOST_OPENAPI);
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/tool',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
        return json(res, 405, { ok: false, error: 'tool requires POST' });
      }
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      try {
        const value = await definition.execute(args, {});
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

  add({
    kind: 'exact',
    path: '/omni-memory/list',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
      const noteTimes = prepareCached(s.db, `SELECT ts FROM notes WHERE ${noteActive}`).all(...noteScope.params);
      const factTimes = prepareCached(s.db, `SELECT valid_from AS ts FROM facts WHERE ${factActive}`).all(...factScope.params);
      const chunkTimes = prepareCached(s.db, `SELECT ts FROM chunks WHERE ${chunkActive}`).all(...chunkScope.params);
      const bucketize = rows => {
        const out = Array(buckets).fill(0);
        let base = 0;
        for (const row of rows) {
          const ts = Number(row.ts);
          if (!Number.isFinite(ts)) continue;
          if (ts < startMs) { base += 1; continue; }
          const index = Math.floor((ts - startMs) / weekMs);
          if (index >= 0 && index < buckets) out[index] += 1;
        }
        return { values: out, base };
      };
      const noteSeries = bucketize(noteTimes);
      const factSeries = bucketize(factTimes);
      const chunkSeries = bucketize(chunkTimes);
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
      const dailyCounts = new Map();
      for (const row of [...noteTimes, ...factTimes]) {
        const ts = Number(row.ts);
        if (!Number.isFinite(ts) || ts < dayStart.getTime()) continue;
        const key = keyOf(ts);
        dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1);
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

      return json(res, 200, {
        ok: true,
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
          supersededNotes,
          expiredFacts,
          recallTotal,
          usefulCount,
          misleadingCount,
          usefulRate: recallTotal ? Math.round(usefulCount / recallTotal * 1000) / 10 : null,
          entities: graphNodes.size,
          relations: graphLinks.length + edgeCount,
          connections: graphLinks.length + edgeCount,
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const node = String(url.searchParams.get('node') ?? '').trim();
      const requestedScope = normalizeScopeInput(url.searchParams.get('scope'));
      const scope = requestedScope === 'all' ? null : (requestedScope || SCOPE_GLOBAL);
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

  add({
    kind: 'exact',
    path: '/omni-memory/persona',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'GET') return json(res, 200, { ok: true, persona: personaGet(s.db) });
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'persona requires GET or POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'refresh requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const apply = String(url.searchParams.get('dryRun') ?? '') !== '1';
      const useModel = String(url.searchParams.get('model') ?? '') === '1';
      try {
        return json(res, 200, { ok: true, ...await personaRefresh(hostCtx, { apply, model: useModel }) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/proposals',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return json(res, 200, { ok: true, proposals: dreamProposals(openStore(), url.searchParams.get('limit')) });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/dream/replace',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'replace requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      const scope = rawScope === 'all' ? null : (rawScope || SCOPE_GLOBAL);
      try {
        if (rawScope === 'all') auditCrossScope(s.db, 'http:dream/replace', noteId);
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'rollback requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      const scope = rawScope === 'all' ? null : (rawScope || SCOPE_GLOBAL);
      if (rawScope === 'all') auditCrossScope(s.db, 'http:dream/rollback', noteId);
      return json(res, 200, { ok: true, ...dreamRollback(s, noteId, scope) });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/export',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
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
    path: '/omni-memory/restore',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'restore requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      const scope = rawScope === 'all' ? null : (rawScope || SCOPE_GLOBAL);
      try {
        if (rawScope === 'all') auditCrossScope(s.db, 'http:restore', id);
        return json(res, 200, { ok: true, ...restoreMemory(s, String(kind), id, scope) });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const count = table => Number(prepareCached(s.db, `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get().n);
      return json(res, 200, {
        ok: true,
        autoRecall: autoRecallEnabled(),
        lastInjection,
        routes: routeState,
        aliasRepair: s.aliasRepair,
        aliasMigration: s.aliasMigration,
        lastSearch: lastSearchProfile,
        lastJudge,
        embedding: {
          kind: backendConfig().kind,
          dim: activeVectorDim(),
          pending: pendingVectors.size,
          dropped: vectorDropped,
          lastDropAt: vectorLastDropAt || null,
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
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const query = url.searchParams.get('q') ?? '';
      if (!queryTerms(query).length) return json(res, 200, { ok: true, hits: [] });
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') ?? 30)));
      const requestedScope = normalizeScopeInput(url.searchParams.get('scope'));
      // A bare HTTP request gets global only. "all" is an explicit audit choice;
      // project keys include that project plus global.
      const scope = requestedScope === 'all' ? null : (requestedScope || SCOPE_GLOBAL);
      const rerank = url.searchParams.get('rerank') === '0' ? false : undefined;
      const result = await runSearch(s, query, limit, scope, { rerank });
      return json(res, 200, { ok: true, scope: requestedScope || SCOPE_GLOBAL, hits: result.hits });
    },
  });

  add({
    kind: 'exact',
    path: '/omni-memory/forget',
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false });
      const s = openStore();
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'forget requires POST' });
      if (!mutationAllowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
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
      const scope = rawScope === 'all' ? null : (rawScope || SCOPE_GLOBAL);
      if (rawScope === 'all') auditCrossScope(s.db, 'http:forget', id);
      const forgotten = forgetMemory(s, kind, id, scope);
      invalidateProfile();
      return json(res, 200, { ok: true, forgotten, scope: rawScope || SCOPE_GLOBAL });
    },
  });

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

export function apply(ctx) {
  hostCtx = ctx;
  ctx.effect(() => {
    const disposers = defineTools(ctx);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  }, 'omni-memory: tools');

  ctx.effect(() => {
    return registerWhenAvailable(ctx, 'webServer', inner => registerRoutes(inner));
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
        lastInjection = {
          at: now(),
          chars: text.length,
          recall: safeHits.length,
          auto: autoRecallEnabled(),
          project: project ?? SCOPE_GLOBAL,
          // Diagnostics: whether the optional HTTP route surface was attached.
          routes: routeState.status,
          // Diagnostics: whether the assembly handed us a usable scope id at all.
          scopeId: assemblyContext?.scope?.id ? String(assemblyContext.scope.id).slice(0, 12) : null,
        };
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
    try { store?.db?.close(); } catch { /* ignore */ }
    store = undefined;
  }, 'omni-memory: store');
}

