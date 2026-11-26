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
import { DIM, embedText, dot, toBlob, fromBlob, tokenize } from './embed.mjs';
import { backendConfig, embedRemote } from './embed-provider.mjs';
import { extractCandidateTexts } from './capture-rules.mjs';
import { rerankConfig, rerankRemote } from './rerank-provider.mjs';
import { semanticConfig, embedSemantic } from './semantic-embed.mjs';
import { createBaseSchema, createFtsTables } from './schema.mjs';
import { createProjectIndexSchema, hasProjectIndexSchema } from './project-schema.mjs';
import { checkForUpdate, formatUpdateNotice, readLocalVersion } from './version-check.mjs';

/**
 * Core store: SQLite lifecycle, migrations, vector queues, backup and candidate
 * ingestion. Later layers bind the few helpers that live above this module
 * through bindStoreRuntime(), which keeps the module graph acyclic.
 */
let scopeClause, relationCardinality, normalizeProblemKey, projectForScope, invalidateProfile;

export function bindStoreRuntime(deps) {
  ({ scopeClause, relationCardinality, normalizeProblemKey, projectForScope, invalidateProfile } = deps);
}


// Data home resolution, in priority order:
//   1. OMNI_HOME   — set by non-DSH adapters (MCP, CLI, HTTP) to point at a shared store
//   2. DSH_HOME    — kept for existing DSH installs, so their memory carries over untouched
//   3. ~/.dsh      — historical default
// The store file itself stays `memory/omni.db` under that home, so a DSH install and a
// standalone adapter that resolve to the same home share one database instead of forking.
let DSH_HOME = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
const PKG_VERSION = readLocalVersion() ?? '0.0.0';
/** Read the checkout's current version on demand; a long-lived HTTP process must
 * not keep reporting the version frozen at module load after an update. */
function currentPackageVersion() {
  return readLocalVersion() ?? PKG_VERSION;
}
let DB_DIR = path.join(DSH_HOME, 'memory');
let DB_FILE = path.join(DB_DIR, 'omni.db');
let DB_TAG = createHash('sha256').update(path.resolve(DB_FILE)).digest('hex').slice(0, 8);
// Backups are the one place a model-facing tool is allowed to touch the disk.
// Keeping that directory fixed turns export/import from an arbitrary read/write
// primitive into a narrow, auditable file exchange.
let BACKUP_DIR = path.resolve(process.env.OMNI_BACKUP_DIR || path.join(DB_DIR, 'backups'));
const BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const PROFILE_BUDGET = 1200;
const PROFILE_CACHE_MS = 30_000;
const MAX_CAPTURE_CHARS = 4000;
// How long a write waits for the file lock before giving up. Every host shares
// one SQLite file, so concurrent writers are normal, not exceptional.
let BUSY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OMNI_BUSY_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(raw) || raw < 0) return 5000;
  return Math.min(raw, 60_000);
})();
// A second process opening the same store must outlive the first process's
// 1M-row migration (measured at 73–80s), not just a normal write lock. The old
// fixed 25 × 200ms window failed at ~5.2s and looked like corruption to the
// caller. This is a wait budget, not a lease TTL: an active owner releases at
// the end of migration, and a crashed owner's lease still expires on its own.
let OPEN_LEASE_WAIT_MS = (() => {
  const raw = Number(process.env.OMNI_OPEN_LEASE_WAIT_MS ?? 150_000);
  if (!Number.isFinite(raw) || raw < 0) return 150_000;
  return Math.min(raw, 300_000);
})();

let store;
export let entityCache = { names: [], at: 0 };

export function resetEntityCache() {
  entityCache = { names: [], at: 0 };
}

export function setEntityCache(value) {
  entityCache = value;
}

/** Close the process-wide handle and clear the singleton so the next host can reopen. */
export function closeStore() {
  if (store?.db) {
    try { store.db.close(); } catch { /* already closed */ }
  }
  store = null;
}

/**
 * Rebind the module to one data home and drop every in-memory singleton.
 * Tests (and multi-home hosts) re-evaluate index.js with a new OMNI_HOME; the
 * ESM cache keeps this module alive, so the reset has to be explicit.
 */
export function configureStore(home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh')) {
  const next = path.resolve(home);
  DSH_HOME = next;
  DB_DIR = path.join(DSH_HOME, 'memory');
  DB_FILE = path.join(DB_DIR, 'omni.db');
  DB_TAG = createHash('sha256').update(path.resolve(DB_FILE)).digest('hex').slice(0, 8);
  BACKUP_DIR = path.resolve(process.env.OMNI_BACKUP_DIR || path.join(DB_DIR, 'backups'));
  WORKSPACES_DIR = path.join(DSH_HOME, 'sessions');
  workspaceCache = { at: 0, list: [] };
  const busyRaw = Number(process.env.OMNI_BUSY_TIMEOUT_MS ?? 5000);
  BUSY_TIMEOUT_MS = Number.isFinite(busyRaw) && busyRaw >= 0 ? Math.min(busyRaw, 60_000) : 5000;
  const leaseRaw = Number(process.env.OMNI_OPEN_LEASE_WAIT_MS ?? 150_000);
  OPEN_LEASE_WAIT_MS = Number.isFinite(leaseRaw) && leaseRaw >= 0 ? Math.min(leaseRaw, 300_000) : 150_000;
  if (store?.db) {
    try { store.db.close(); } catch { /* old process state */ }
  }
  store = null;
  resetEntityCache();
  localToolDefinitions.clear();
  try { cwdBySession.clear(); projectByAgent.clear(); } catch { /* declarations below */ }
  try { lastUserByAgent.clear(); recallByAgent.clear(); } catch { /* declarations below */ }
  try { lastJudge = null; lastInjection = { at: 0, chars: 0, recall: 0, auto: false }; } catch { /* declarations below */ }
  try { pendingVectors.clear(); vectorDropped = 0; vectorLastDropAt = 0; } catch { /* declarations below */ }
  try { judgeQueue.length = 0; PROJECT_IDENTITY_CACHE.clear(); } catch { /* declarations below */ }
  try { remoteDim = 0; } catch { /* declaration below */ }
}

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

const PROJECT_IDENTITY_FILE_NAMES = ['.omni-project', '.omni/project.json'];
const PROJECT_IDENTITY_CACHE_MS = 60_000;
const PROJECT_IDENTITY_CACHE = new Map();

function readProjectIdentityFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* plain text is also allowed */ }

  let key = '';
  let id = '';
  let name = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    key = String(parsed.key ?? '').trim();
    id = String(parsed.id ?? '').trim();
    name = String(parsed.name ?? '').trim();
  } else {
    // A one-line file is enough: either an explicit key or a stable project id.
    const first = raw.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
    if (first.startsWith('proj:')) key = first.split(/\s+/)[0];
    else id = first.split(/\s+/)[0];
  }

  if (/^proj:[^#\s]+#[a-z0-9]{6,}$/i.test(key)) return { key, name, file };
  const seed = id || raw;
  if (!seed) return null;
  const label = (name || path.basename(path.dirname(file)) || 'project')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
  return {
    key: `proj:${label}#${fnv1a(seed).toString(16).padStart(8, '0').slice(0, 6)}`,
    name: name || label,
    file,
  };
}

/**
 * A repo-local `.omni-project` is the stable identity. It is deliberately read
 * before the path hash so two checkouts on different drives (or a moved folder)
 * resolve to one project layer. The file is only a hint: an invalid or missing
 * file falls back to the historical path-derived key.
 */
function projectIdentityFromCwd(cwd) {
  const resolved = path.resolve(String(cwd ?? '').trim() || '.');
  const cached = PROJECT_IDENTITY_CACHE.get(resolved);
  if (cached && Date.now() - cached.at < PROJECT_IDENTITY_CACHE_MS) return cached.value;

  let dir = resolved;
  for (let depth = 0; depth < 12; depth += 1) {
    for (const name of PROJECT_IDENTITY_FILE_NAMES) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      const identity = readProjectIdentityFile(file);
      if (identity) {
        const value = { ...identity, root: dir, source: 'file' };
        PROJECT_IDENTITY_CACHE.set(resolved, { at: Date.now(), value });
        return value;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  PROJECT_IDENTITY_CACHE.set(resolved, { at: Date.now(), value: null });
  return null;
}

function projectKeyFromCwd(cwd, platform = process.platform) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return SCOPE_GLOBAL;
  const projectIdentity = projectIdentityFromCwd(raw);
  if (projectIdentity?.key) return projectIdentity.key;
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

export { projectKeyFromCwd, legacyProjectKeyFromCwd, projectIdentityFromCwd };
export { openStore, migrateScopeAlias, scopeHasRows, migrateKnowledgeNotes };

let WORKSPACES_DIR = path.join(DSH_HOME, 'sessions');

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
// These are strong enough to outrank a project name inside the same sentence.
// "用户偏好：涉及全息记忆的工作……" is global; "全息记忆 4.1.1 的 CLI 作用域"
// is project knowledge even though it mentions a preferred project.
const GLOBAL_STRONG_HINTS = [
  '用户偏好', '跨项目', '所有项目', '以后所有', '今后所有', '一律', '永远', '铁律', '禁止', '不要再', '宁可不',
];
const PROJECT_HINTS = [
  '本项目', '这个项目', '当前项目', '本仓库', '本工程', '这个插件', '本插件',
  '项目', '仓库', '代码', '目录', '路径', '本机', '工作目录', '当前目录',
  '全息记忆', 'CLI', 'search', 'write', 'context', 'scope', 'proj:', 'note#',
  'src/', 'docs/', 'hosts/', 'index.js', 'package.json', '.mjs', '.ts', '.js',
  '构建', '部署', '迁移', '表结构', '字段', '版本', '审计', '修复', '优化',
  'D:\\', 'C:\\',
];

function classifyScope(text, project) {
  const value = String(text ?? '');
  const globalScore = GLOBAL_HINTS.filter(hint => value.includes(hint)).length;
  const strongGlobalScore = GLOBAL_STRONG_HINTS.filter(hint => value.includes(hint)).length;
  const projectScore = PROJECT_HINTS.filter(hint => value.includes(hint)).length;
  if (!project) return { scope: SCOPE_GLOBAL, reason: 'no-project', confidence: 1 };
  if (strongGlobalScore > 0 && (strongGlobalScore > 1 || /^(?:用户偏好|跨项目|所有项目|以后所有|今后所有|一律|永远|铁律|禁止|不要再|宁可不)/.test(value))) {
    return { scope: SCOPE_GLOBAL, reason: 'cross-project wording', confidence: 0.85 };
  }
  if (projectScore > 0) return { scope: project, reason: 'project-specific wording', confidence: 0.85 };
  if (globalScore > 0) return { scope: SCOPE_GLOBAL, reason: 'cross-project wording', confidence: 0.8 };
  return { scope: project, reason: 'default-to-project', confidence: 0.55 };
}

function normalizeScopeInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return lower === 'all' || lower === 'project' || lower === 'global' ? lower : raw;
}

/** Parse an HTTP scope request once; `all` is the read-only cross-layer view. */
function httpScope(value, fallback = SCOPE_GLOBAL) {
  const requested = normalizeScopeInput(value);
  return {
    requested,
    scope: requested === 'all' ? null : (requested || fallback),
  };
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
 * Move imported domain knowledge out of the global layer without touching the
 * user's rules. The source prefix is the same convention used by the knowledge
 * importer (`专业知识/<path>#<section>`), so the migration is auditable and can
 * be dry-run before it writes.
 */
function migrateKnowledgeNotes(db, options = {}) {
  const fromScope = String(options.fromScope ?? SCOPE_GLOBAL).trim();
  const targetScope = String(options.target ?? 'proj:专业知识#967a81').trim();
  const sourcePrefix = String(options.sourcePrefix ?? '专业知识/').trim();
  if (!sourcePrefix) throw new Error('sourcePrefix is required');
  if (!targetScope.startsWith('proj:')) throw new Error('target must be a proj:<name>#<hash> scope');
  if (targetScope === SCOPE_GLOBAL) throw new Error('target must not be global');

  const where = "deleted_at IS NULL AND superseded_by IS NULL AND scope = ? AND source LIKE ?";
  const params = [fromScope, `${sourcePrefix}%`];
  const candidates = prepareCached(db, `
    SELECT id, scope, source, substr(text, 1, 120) AS sample
    FROM notes WHERE ${where} ORDER BY id
  `).all(...params);
  const total = candidates.length;
  const targetExisting = Number(prepareCached(db,
    'SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL AND scope = ?'
  ).get(targetScope).n ?? 0);
  const preview = {
    fromScope,
    targetScope,
    sourcePrefix,
    total,
    targetExisting,
    sample: candidates.slice(0, 5),
    applied: options.apply === true,
  };
  if (!total || options.apply !== true) {
    return {
      ...preview,
      moved: 0,
      ...(total ? { hint: '加 --apply 执行迁移；默认只预览' } : { hint: '没有匹配的知识库笔记' }),
    };
  }
  const moved = Number(transaction(db, () => prepareCached(db, `
    UPDATE notes SET scope = ?, revision = revision + 1
    WHERE ${where}
  `).run(targetScope, ...params).changes));
  invalidateProfile();
  return { ...preview, moved, remaining: Math.max(0, total - moved) };
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

/**
 * Dedupe lookup through the (scope, text_hash) index. Matching text is part of
 * the predicate, not just the hash: a collision between two different texts can
 * never be reported as a duplicate.
 */
function findNoteByTextIndex(db, scope, text, extraSql = '', extraParams = []) {
  return prepareCached(db, `
    SELECT id, problem_key, solution_status, evidence FROM notes
    WHERE scope = ? AND text_hash = ? AND text = ? ${extraSql}
  `).get(scope, hash(text), text, ...extraParams);
}

function schemaVersionOnDisk(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = Number(row?.value ?? 0);
    return Number.isFinite(version) && version >= 0 ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * A migration is the one startup operation that can destroy a store. Take a
 * verified SQLite backup before the first write, then keep the newest few so a
 * failed upgrade is recoverable without relying on the user having a copy.
 * Fresh databases have no rows to protect and skip the copy.
 */
function backupBeforeMigration(db, fromVersion) {
  if (process.env.OMNI_MIGRATION_BACKUP === '0') {
    return { skipped: true, reason: 'OMNI_MIGRATION_BACKUP=0' };
  }
  const backupDir = BACKUP_DIR;
  mkdirSync(backupDir, { recursive: true });
  // The filename must be unique across processes, not merely across calls in
  // one process. A millisecond stamp collides when several hosts open the same
  // store at once; pid + UUID makes each VACUUM INTO target private.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = `${stamp}-p${process.pid}-${randomUUID().slice(0, 8)}`;
  const file = path.join(backupDir, `pre-migrate-v${fromVersion}-to-v${SCHEMA_VERSION}-${DB_TAG}-${unique}.db`);
  const temporary = `${file}.tmp`;
  // VACUUM INTO refuses to overwrite; write to this call's private temp file,
  // verify it, then rename it into place so retention never sees a half copy.
  let existedBefore = false;
  try {
    existedBefore = existsSync(temporary);
    db.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
  } catch (error) {
    // Only remove the private temp path. Never unlink a final path that another
    // process may have created.
    if (!existedBefore) {
      try { unlinkSync(temporary); } catch { /* the failed VACUUM may not have created it */ }
    }
    throw error;
  }
  let size = 0;
  try {
    size = statSync(temporary).size;
  } catch {
    size = 0;
  }
  if (size <= 0) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw new Error(`migration backup is empty: ${temporary}`);
  }
  let check;
  try {
    check = new DatabaseSync(temporary, { readOnly: true });
    const row = check.prepare('PRAGMA integrity_check').get();
    const verdict = row ? Object.values(row)[0] : null;
    if (verdict !== 'ok') throw new Error(`migration backup failed integrity_check: ${verdict}`);
  } catch (error) {
    try { check?.close(); } catch { /* already closed */ }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  } finally {
    try { check?.close(); } catch { /* already closed */ }
  }
  renameSync(temporary, file);
  // The backup contains the entire memory database. Keep it private even when
  // the platform's default umask would otherwise widen it.
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are managed separately */ }
  const configuredKeep = Number(process.env.OMNI_MIGRATION_BACKUP_KEEP ?? 5);
  const keep = Number.isInteger(configuredKeep) && configuredKeep > 0 ? configuredKeep : 5;
  try {
    const backups = readdirSync(backupDir)
      .filter(name => new RegExp(`^pre-migrate-v\\d+-to-v\\d+-${DB_TAG}-.*\\.db$`).test(name))
      .map(name => {
        const absolute = path.join(backupDir, name);
        return { absolute, mtime: statSync(absolute).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of backups.slice(keep)) unlinkSync(stale.absolute);
  } catch { /* pruning is best effort; the new backup already exists */ }
  return { file, bytes: size, fromVersion, toVersion: SCHEMA_VERSION };
}

function openStore() {
  if (store) return store;
  mkdirSync(DB_DIR, { recursive: true });
  const existed = existsSync(DB_FILE);
  const sizeBefore = existed ? statSync(DB_FILE).size : 0;
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
  // The lease table must exist before the cross-process lock can be taken. Do
  // not create the rest of the base schema yet: the pre-migration backup must
  // capture the store before any DDL that this process adds.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // Schema migrations. A fresh database and an upgraded one must converge on the
  // same structure, so every structural change is a numbered migration.
  // One process migrates and rebuilds; the rest wait for the lease to clear so
  // two hosts opening at the same moment never run DDL against each other.
  const MAINTENANCE = 'open-maintenance';
  let lease = acquireLease(db, MAINTENANCE, 120_000);
  const waitStarted = Date.now();
  while (!lease && Date.now() - waitStarted < OPEN_LEASE_WAIT_MS) {
    const remaining = OPEN_LEASE_WAIT_MS - (Date.now() - waitStarted);
    sleepSync(Math.min(200, Math.max(1, remaining)));
    lease = acquireLease(db, MAINTENANCE, 120_000);
  }
  if (!lease) {
    throw new Error(`database maintenance lease unavailable after ${Date.now() - waitStarted}ms; refusing to read an unmigrated store`);
  }

  let migrationBackup = null;
  let schemaVersion = SCHEMA_VERSION;
  let semanticGcReport = null;
  let aliasRepair = null;
  let chunksMode;
  let notesMode;
  let factsMode;
  let ftsMode;
  let externalNotes = false;
  try {
    // Re-read under the lease. A competing process may have completed the
    // migration while this one waited; in that case there is nothing to back
    // up, and a second backup would be pure noise.
    const versionAtLease = sizeBefore > 0 ? schemaVersionOnDisk(db) : 0;
    if (sizeBefore > 0 && versionAtLease < SCHEMA_VERSION) {
      try {
        migrationBackup = backupBeforeMigration(db, versionAtLease);
      } catch (error) {
        const warning = String(error?.message ?? error);
        migrationBackup = { skipped: true, error: warning, fromVersion: versionAtLease, toVersion: SCHEMA_VERSION };
        // A missing rollback point is a data-safety failure, not a routine
        // degradation. Operators who accept the risk can opt in explicitly.
        const allowDegrade = process.env.OMNI_MIGRATION_BACKUP_DEGRADE === '1'
          || process.env.OMNI_MIGRATION_BACKUP_STRICT === '0';
        if (!allowDegrade) throw new Error(`migration backup failed: ${warning}`, { cause: error });
        try { process.stderr.write(`[omni] migration backup skipped by explicit opt-in: ${warning}\n`); } catch { /* stderr unavailable */ }
      }
    }
    createBaseSchema(db);
    ({ chunksMode, notesMode, factsMode, ftsMode } = createFtsTables(db));

    // Migration and derived-index maintenance are one owner-only unit. Running
    // migrate() outside the lease let a second process replay destructive DDL
    // (for example the v4 vector reset) after the first process already set the
    // backfill marker, silently breaking vector recall.
    schemaVersion = migrate(db);
    externalNotes = notesFtsIsExternal(db);
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
    // One-time hashed-vector sweep: drop rows for owners that were deleted or
    // superseded by older builds. Active rows remain as the zero-config fallback.
    if (metaGet(db, 'hashed_gc_version') !== String(SCHEMA_VERSION)) {
      const report = pruneHashedVectors(db);
      if (report.ok) {
        metaSet(db, 'hashed_gc_version', SCHEMA_VERSION);
        metaSet(db, 'hashed_gc_deleted', report.deleted);
      } else {
        metaSet(db, 'hashed_gc_last_error', report.error);
      }
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
      if (notesMode) ftsOk = (externalNotes || backfillFts(db, 'notes_fts', 'notes')) && ftsOk;
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
    migrationBackup,
    semanticGc: semanticGcReport,
    aliasRepair,
    fts: { chunks: Boolean(chunksMode), notes: Boolean(notesMode), facts: Boolean(factsMode), externalNotes },
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

export const SCHEMA_VERSION = 20;
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

/** Whether notes_fts is an external-content index (schema v19+). */
function notesFtsIsExternal(db) {
  if (!tableExists(db, 'notes_fts')) return false;
  try {
    const sql = prepareCached(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'").get()?.sql ?? '';
    return /content\s*=\s*'notes'/i.test(sql);
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
 * v17: hash note text so write dedupe and restore/import prechecks can use the
 * `(scope, text_hash)` index instead of scanning every row in the scope. The
 * hash is only a filter; every hit is still compared against the original text.
 *
 * The partial index makes the steady-state "anything missing?" probe O(1) even
 * on a 1M-row store, while the backfill is batched so an old library never loads
 * every text into memory or holds one giant write transaction.
 */
const NOTE_HASH_MIGRATION_BATCH = 1000;
function ensureNoteTextHash(db) {
  addColumn(db, 'notes', 'text_hash', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS notes_scope_text_hash
      ON notes(scope, text_hash);
    CREATE INDEX IF NOT EXISTS notes_text_hash_missing
      ON notes(id) WHERE text_hash IS NULL;
  `);
  const select = prepareCached(db, `
    SELECT id, text FROM notes WHERE text_hash IS NULL ORDER BY id LIMIT ?
  `);
  const update = prepareCached(db, 'UPDATE notes SET text_hash = ? WHERE id = ?');
  let migrated = 0;
  while (true) {
    const missing = select.all(NOTE_HASH_MIGRATION_BATCH);
    if (!missing.length) break;
    transaction(db, () => {
      for (const row of missing) update.run(hash(row.text), Number(row.id));
    });
    migrated += missing.length;
  }
  return migrated;
}

/**
 * v18: rewrite the CJK bigram index as a WITHOUT ROWID table. The old table
 * stored a hidden rowid, a composite primary-key btree, and a second
 * (gram, layer, owner_id) index, so each gram was effectively stored three
 * times. The primary key now starts with gram, which is exactly the lookup
 * order searchBigrams uses; one covering owner index remains for deletes.
 *
 * The table is derived data, so rebuilding it is safe. VACUUM cannot run inside
 * the migration transaction; SQLite reuses the freed pages, and an operator can
 * reclaim the file with a separate VACUUM after the migration commits.
 */
function createCompactBigrams(db, name = 'bigrams') {
  db.exec(`
    CREATE TABLE ${name} (
      layer TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      gram TEXT NOT NULL,
      PRIMARY KEY (gram, layer, owner_id)
    ) WITHOUT ROWID;
    CREATE INDEX ${name}_owner ON ${name}(layer, owner_id, gram);
  `);
}

function ensureCompactBigrams(db) {
  if (!tableExists(db, 'bigrams')) {
    createCompactBigrams(db);
    return false;
  }
  const sql = prepareCached(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bigrams'").get()?.sql ?? '';
  if (/without\s+rowid/i.test(sql) && /primary\s+key\s*\(\s*gram/i.test(sql)) {
    db.exec('CREATE INDEX IF NOT EXISTS bigrams_owner ON bigrams(layer, owner_id, gram)');
    return false;
  }
  db.exec('DROP TABLE IF EXISTS bigrams_v18');
  createCompactBigrams(db, 'bigrams_v18');
  db.exec(`
    INSERT INTO bigrams_v18(layer, owner_id, gram)
    SELECT layer, owner_id, gram FROM bigrams;
    DROP TABLE bigrams;
    ALTER TABLE bigrams_v18 RENAME TO bigrams;
  `);
  db.exec(`
    DROP INDEX IF EXISTS bigrams_v18_owner;
    CREATE INDEX IF NOT EXISTS bigrams_owner ON bigrams(layer, owner_id, gram);
  `);
  return true;
}

/**
 * v19: convert notes_fts to an external-content index and let triggers keep it
 * in sync. A normal FTS5 table stores a second copy of every note body; with
 * content='notes' the index reads notes.text directly. Manual row writes would
 * be unsafe here (an external-content delete needs the old text), so all note
 * FTS maintenance moves to triggers and the generic row helpers skip this one
 * table. The migration rebuilds the index from notes before installing triggers,
 * so a crash cannot leave rows pointing at a half-populated index.
 */
function notesFtsTriggers(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notes_fts_ai
    AFTER INSERT ON notes
    BEGIN
      INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_ad
    AFTER DELETE ON notes
    WHEN old.superseded_by IS NULL AND old.deleted_at IS NULL
    BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_au
    AFTER UPDATE OF text ON notes
    WHEN old.superseded_by IS NULL AND old.deleted_at IS NULL AND old.text IS NOT new.text
    BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO notes_fts(rowid, text)
        SELECT new.id, new.text
        WHERE new.superseded_by IS NULL AND new.deleted_at IS NULL;
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_a_supersede
    AFTER UPDATE OF superseded_by ON notes
    WHEN old.superseded_by IS NULL AND old.deleted_at IS NULL AND new.superseded_by IS NOT NULL
    BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_a_forget
    AFTER UPDATE OF deleted_at ON notes
    WHEN old.deleted_at IS NULL AND old.superseded_by IS NULL AND new.deleted_at IS NOT NULL
    BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_a_restore
    AFTER UPDATE OF superseded_by, deleted_at ON notes
    WHEN (old.superseded_by IS NOT NULL OR old.deleted_at IS NOT NULL)
      AND new.superseded_by IS NULL AND new.deleted_at IS NULL
    BEGIN
      INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);
}

function ensureExternalNotesFts(db) {
  if (!tableExists(db, 'notes_fts') || !tableExists(db, 'notes')) return false;
  if (notesFtsIsExternal(db)) {
    notesFtsTriggers(db);
    return false;
  }
  const sql = prepareCached(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'").get()?.sql ?? '';
  const trigram = /tokenize\s*=\s*'trigram'/i.test(sql);
  db.exec('DROP TABLE IF EXISTS notes_fts_v19');
  db.exec(`
    CREATE VIRTUAL TABLE notes_fts_v19 USING fts5(
      text,
      content='notes',
      content_rowid='id'${trigram ? ", tokenize='trigram'" : ''}
    );
    INSERT INTO notes_fts_v19(rowid, text)
      SELECT id, text FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL;
    DROP TABLE notes_fts;
    ALTER TABLE notes_fts_v19 RENAME TO notes_fts;
  `);
  notesFtsTriggers(db);
  return true;
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
  // v17: notes.text_hash + (scope, text_hash) index. Dedupe still compares the
  // original text after the indexed candidate lookup, so a hash collision can
  // never merge two different notes.
  db => ensureNoteTextHash(db),
  // v18: compact the CJK bigram index. See createCompactBigrams().
  db => ensureCompactBigrams(db),
  // v19: external-content notes FTS kept in sync by triggers. See ensureExternalNotesFts().
  db => ensureExternalNotesFts(db),
  // v20: derived project-code index. Six tables, never source bodies. See
  // lib/project-schema.mjs and docs/PROJECT-INDEX.md.
  db => createProjectIndexSchema(db),
];

function migrate(db) {
  if (MIGRATIONS.length !== SCHEMA_VERSION + 1) {
    throw new Error(`migration table has ${MIGRATIONS.length - 1} steps, expected ${SCHEMA_VERSION}`);
  }
  const row = prepareCached(db, "SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  if (!Number.isFinite(version) || version < 1) {
    // Unversioned database: treat as v1 and apply the remaining steps.
    version = 1;
  }
  // DDL and the version marker commit together. A crash mid-migration leaves
  // the previous schema intact instead of a half-applied store.
  db.exec('BEGIN IMMEDIATE');
  transactionDepth.set(db, 1);
  try {
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
  // Repair path for a marker that is already 17 but the backfill stopped early.
  if (SCHEMA_VERSION >= 17) ensureNoteTextHash(db);
  // Repair path for a marker that is already 20 but DDL was interrupted.
  if (SCHEMA_VERSION >= 20 && !hasProjectIndexSchema(db)) createProjectIndexSchema(db);
  prepareCached(db, "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)")
    .run(String(SCHEMA_VERSION));
  db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the failing statement may already have closed it */ }
    throw error;
  } finally {
    transactionDepth.delete(db);
  }
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
    // External-content notes_fts is maintained by triggers. A manual DELETE with
    // rowid alone would corrupt it because the old text is required.
    if (!(table === 'notes' && notesFtsIsExternal(db))) {
      prepareCached(db, `DELETE FROM ${table}_fts WHERE rowid = ?`).run(Number(id));
    }
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

/** Rebuild the FTS, bigram and vector views for one source row. */
function reindexRow(s, kind, id, text) {
  const fts = { note: ['notes_fts', s.fts?.notes], fact: ['facts_fts', s.fts?.facts], chunk: ['chunks_fts', s.fts?.chunks] }[String(kind)];
  if (!fts) throw new Error(`unknown row kind: ${kind}`);
  if (fts[1] && !(String(kind) === 'note' && s.fts?.externalNotes)) {
    try {
      // Delete first: amend/dream can change the text of an existing rowid, and
      // INSERT alone would silently keep the stale FTS document.
      prepareCached(s.db, `DELETE FROM ${fts[0]} WHERE rowid = ?`).run(Number(id));
      prepareCached(s.db, `INSERT INTO ${fts[0]}(rowid, text) VALUES (?, ?)`).run(Number(id), String(text));
    } catch { /* index write is best effort */ }
  }
  indexBigrams(s.db, String(kind), Number(id), String(text));
  upsertVector(s, String(kind), Number(id), String(text));
}

/**
 * Drop semantic rows whose source row is tombstoned, superseded or expired.
 * Derived data has no audit value; a stale vector only costs disk and can make
 * a deleted note compete in ranking if a future query bypasses the JOIN.
 */
/**
 * Remove hashed vectors whose owner row is gone, tombstoned or superseded.
 * Active rows stay: they are the zero-config fallback when local semantic
 * assets are unavailable.
 */
export function pruneHashedVectors(db) {
  const report = { ok: true, deleted: 0, error: '' };
  try {
    if (!tableExists(db, 'vectors')) return report;
    transaction(db, () => {
      for (const [kind, table, extra] of [
        ['note', 'notes', 'AND t.superseded_by IS NULL'],
        ['fact', 'facts', 'AND t.valid_to IS NULL'],
        ['chunk', 'chunks', ''],
      ]) {
        const info = prepareCached(db, `
          DELETE FROM vectors
          WHERE kind = ?
            AND NOT EXISTS (
              SELECT 1 FROM ${table} t
              WHERE t.id = vectors.owner_id
                AND t.deleted_at IS NULL ${extra}
            )
        `).run(kind);
        report.deleted += Number(info.changes ?? 0);
      }
    });
  } catch (error) {
    report.ok = false;
    report.error = String(error?.message ?? error);
  }
  return report;
}

function pruneSemanticVectors(db) {  const report = { ok: true, deleted: 0, error: '' };
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

/** Run a multi-step write atomically. Nested calls use SQLite savepoints. */
const transactionDepth = new WeakMap();
let savepointCounter = 0;
function transaction(db, fn) {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    const savepoint = `omni_sp_${depth}_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch { /* ignore rollback failure */ }
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  transactionDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw error;
  } finally {
    transactionDepth.delete(db);
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

/** Keep lineage pointers positive; unresolved ids become null. */
function positiveIdOrNull(value) {
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

/** Plan note rows from a snapshot; validation stays in the import path. */
function planImportNotes(db, snapshot, stats) {
  const rows = Array.isArray(snapshot.notes) ? snapshot.notes : [];
  const noteExists = prepareCached(db, `
    SELECT id FROM notes WHERE scope = ? AND text_hash = ? AND text = ? AND superseded_by IS NULL
  `);
  const plan = [];
  for (const note of rows) {
    if (!note?.text) { stats.skipped += 1; continue; }
    if (noteExists.get(note.scope ?? SCOPE_GLOBAL, hash(String(note.text)), String(note.text))) { stats.skipped += 1; continue; }
    const verification = IMPORT_VERDICTS.has(String(note.verification ?? '')) ? String(note.verification) : null;
    const solutionStatus = IMPORT_SOLUTION_STATUSES.has(String(note.solution_status ?? note.solutionStatus ?? ''))
      ? String(note.solution_status ?? note.solutionStatus) : null;
    plan.push({
      ...note,
      ts: importNumber(note.ts, now(), 0, Number.MAX_SAFE_INTEGER),
      scope: String(note.scope ?? SCOPE_GLOBAL),
      text: String(note.text),
      importance: importNumber(note.importance, 0.5, 0, 1),
      revision: Math.floor(importNumber(note.revision, 1, 1, 1_000_000)),
      contested: importNumber(note.contested, 0, 0, 1) ? 1 : 0,
      superseded_by: positiveIdOrNull(note.superseded_by),
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
  return plan;
}

/** Plan fact rows from a snapshot, including cardinality and validity bounds. */
function planImportFacts(db, snapshot, stats) {
  const rows = Array.isArray(snapshot.facts) ? snapshot.facts : [];
  const factExists = prepareCached(db, 'SELECT id FROM facts WHERE subject = ? AND relation = ? AND object = ? AND scope = ?');
  const plan = [];
  for (const fact of rows) {
    if (!fact?.subject || !fact?.relation) { stats.skipped += 1; continue; }
    if (factExists.get(fact.subject, fact.relation, String(fact.object ?? ''), fact.scope ?? SCOPE_GLOBAL)) {
      stats.skipped += 1;
      continue;
    }
    plan.push({
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
  return plan;
}

/** Plan transcript chunks, deduplicated by content hash and scope. */
function planImportChunks(db, snapshot, stats) {
  const rows = Array.isArray(snapshot.chunks) ? snapshot.chunks : [];
  const chunkExists = prepareCached(db, "SELECT id FROM chunks WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");
  const plan = [];
  for (const chunk of rows) {
    if (!chunk?.text) { stats.skipped += 1; continue; }
    const digest = hash(String(chunk.text));
    if (chunkExists.get(digest, chunk.scope ?? 'global')) { stats.skipped += 1; continue; }
    plan.push({
      ...chunk,
      text: String(chunk.text),
      ts: importNumber(chunk.ts, now(), 0, Number.MAX_SAFE_INTEGER),
      importance: importNumber(chunk.importance, 0.5, 0, 1),
      scope: chunk.scope == null ? null : String(chunk.scope),
      deleted_at: chunk.deleted_at == null ? null : importNumber(chunk.deleted_at, now(), 0, Number.MAX_SAFE_INTEGER),
    });
  }
  return plan;
}

/** Plan graph edges, deduplicated by triple and scope. */
function planImportEdges(db, snapshot, stats) {
  const rows = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  const edgeExists = prepareCached(db, "SELECT id FROM edges WHERE src = ? AND rel = ? AND dst = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')");
  const plan = [];
  for (const edge of rows) {
    if (!edge?.src || !edge?.rel || !edge?.dst) { stats.skipped += 1; continue; }
    if (edgeExists.get(edge.src, edge.rel, edge.dst, edge.scope ?? SCOPE_GLOBAL)) { stats.skipped += 1; continue; }
    plan.push({
      ...edge,
      src: String(edge.src), rel: String(edge.rel), dst: String(edge.dst),
      valid_from: importNumber(edge.valid_from, now(), 0, Number.MAX_SAFE_INTEGER),
      valid_to: edge.valid_to == null ? null : importNumber(edge.valid_to, now(), 0, Number.MAX_SAFE_INTEGER),
    });
  }
  return plan;
}

/** Plan pending candidates; accepted/rejected audit rows are not re-queued. */
function planImportCandidates(db, snapshot, stats) {
  const rows = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  const candidateExists = prepareCached(db, `
    SELECT id FROM note_candidates
    WHERE hash = ? AND IFNULL(scope, 'global') = IFNULL(?, 'global')
  `);
  const plan = [];
  for (const candidate of rows) {
    const text = String(candidate?.text ?? '').trim();
    if (!text || (candidate.status && candidate.status !== 'pending')) { stats.skipped += 1; continue; }
    const scope = candidate.scope ?? SCOPE_GLOBAL;
    const digest = hash(`${scope}\n${text}`);
    if (candidateExists.get(digest, scope)) { stats.skipped += 1; continue; }
    plan.push({ ...candidate, text, scope, hash: digest });
  }
  return plan;
}

/** Plan entity, relation, alias and persona metadata. */
function planImportMeta(snapshot, stats) {
  const entities = [];
  const relations = [];
  const entityAliases = [];
  const persona = [];
  for (const name of Array.isArray(snapshot.entities) ? snapshot.entities : []) {
    if (!name) { stats.skipped += 1; continue; }
    entities.push(String(name));
  }
  for (const relation of Array.isArray(snapshot.relations) ? snapshot.relations : []) {
    const name = String(relation?.name ?? '').trim();
    if (!name) { stats.skipped += 1; continue; }
    relations.push({ ...relation, name });
  }
  for (const alias of Array.isArray(snapshot.entityAliases) ? snapshot.entityAliases : (Array.isArray(snapshot.aliases) ? snapshot.aliases : [])) {
    const name = String(alias?.alias ?? '').trim();
    const canonical = String(alias?.canonical ?? '').trim();
    if (!name || !canonical) { stats.skipped += 1; continue; }
    entityAliases.push({ ...alias, alias: name, canonical });
  }
  const personaRows = Array.isArray(snapshot.persona)
    ? snapshot.persona
    : Object.entries(snapshot.persona ?? {}).map(([key, value]) => ({ key, value }));
  for (const item of personaRows) {
    const key = String(item?.key ?? '').trim();
    const value = String(item?.value ?? '').trim();
    if (!key || !value) { stats.skipped += 1; continue; }
    persona.push({ ...item, key, value });
  }
  return { entities, relations, entityAliases, persona };
}

/** Insert planned notes and remap lineage pointers to local ids. */
function insertSnapshotNotes(s, notes) {
  const idMap = new Map();
  for (const note of notes) {
    const info = prepareCached(s.db, `
      INSERT INTO notes(
        ts, scope, text, text_hash, importance, source, revision, superseded_by, contested, deleted_at,
        verification, verified_at, evidence, problem_key, solution_status,
        solution_verified_at, reuse_count, last_used_at,
        recall_count, last_recall_at, useful_count, misleading_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(note.ts ?? now()), note.scope ?? SCOPE_GLOBAL, String(note.text), hash(String(note.text)),
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
    reindexRow(s, 'note', newId, note.text);
  }
  // Remap note lineage pointers to the ids assigned in this database. A pointer
  // outside the imported snapshot must become null; falling back to the source
  // id would point at an unrelated local note with that id.
  for (const note of notes) {
    const replacement = Number(note.superseded_by ?? 0);
    if (!replacement) continue;
    const newId = idMap.get(Number(note.id));
    const target = idMap.get(replacement);
    if (newId) {
      prepareCached(s.db, 'UPDATE notes SET superseded_by = ? WHERE id = ?')
        .run(target ?? null, newId);
    }
  }
}

/** Insert facts, closing older single-valued rows in valid_from order. */
function insertSnapshotFacts(s, facts) {
  const activeFactRows = prepareCached(s.db, `
    SELECT id, object, valid_from, scope FROM facts
    WHERE subject = ? AND relation = ? AND valid_to IS NULL AND deleted_at IS NULL
      AND (scope = ? OR (scope IS NULL AND ? = 'global'))
  `);
  facts.sort((a, b) => Number(a.valid_from ?? 0) - Number(b.valid_from ?? 0));
  for (const fact of facts) {
    const factScope = fact.scope ?? SCOPE_GLOBAL;
    const factFrom = Number(fact.valid_from ?? now());
    const cardinality = fact.cardinality === 'multi' ? 'multi' : relationCardinality(s.db, String(fact.relation));
    const factActive = fact.valid_to === null || fact.valid_to === undefined;
    let validTo = fact.valid_to ?? null;
    // Importing a snapshot used to bypass the write path's single-value rule:
    // local and imported values both stayed valid_to=NULL. Sort by valid_from
    // and close the rows this imported value actually replaces; if a newer
    // local fact already exists, keep the imported one historical.
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
    reindexRow(s, 'fact', newId, String(fact.text ?? `${fact.subject} ${fact.relation} ${fact.object ?? ''}`));
  }
}

/** Insert transcript chunks and their derived indexes. */
function insertSnapshotChunks(s, chunks) {
  for (const chunk of chunks) {
    const text = String(chunk.text);
    const info = prepareCached(s.db, `
      INSERT INTO chunks(ts, session_id, role, text, hash, source, importance, scope, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(chunk.ts ?? now()), chunk.session_id ?? null, chunk.role ?? 'note', text,
      hash(text), chunk.source ?? null, Number(chunk.importance ?? 0.5), chunk.scope ?? null,
      chunk.deleted_at ?? null,
    );
    reindexRow(s, 'chunk', Number(info.lastInsertRowid), text);
  }
}

/** Insert pending candidates. */
function insertSnapshotCandidates(s, candidates) {
  for (const candidate of candidates) {
    prepareCached(s.db, `
      INSERT INTO note_candidates(ts, scope, text, hash, source, chunk_id, confidence, status)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending')
    `).run(
      Number(candidate.ts ?? now()), candidate.scope ?? SCOPE_GLOBAL, String(candidate.text),
      String(candidate.hash), candidate.source ?? null, Number(candidate.confidence ?? 0.5),
    );
  }
}

/** Insert graph edges. */
function insertSnapshotEdges(s, edges) {
  for (const edge of edges) {
    prepareCached(s.db, `
      INSERT INTO edges(src, rel, dst, valid_from, valid_to, scope, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(edge.src), String(edge.rel), String(edge.dst),
      Number(edge.valid_from ?? now()), edge.valid_to ?? null,
      edge.scope ?? null, edge.source ?? null,
    );
  }
}

/** Insert entity, relation, alias and persona metadata. */
function insertSnapshotMeta(s, meta) {
  for (const name of meta.entities) prepareCached(s.db, 'INSERT OR IGNORE INTO entities(name) VALUES (?)').run(name);
  for (const relation of meta.relations) {
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
  for (const alias of meta.entityAliases) {
    prepareCached(s.db, `
      INSERT INTO entity_aliases(alias, canonical, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        canonical = excluded.canonical,
        updated_at = excluded.updated_at
    `).run(String(alias.alias), String(alias.canonical), Number(alias.updated_at ?? now()));
  }
  for (const setting of meta.persona) {
    prepareCached(s.db, `
      INSERT INTO persona(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(String(setting.key), String(setting.value), Number(setting.updated_at ?? now()));
  }
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
  const meta = planImportMeta(snapshot, stats);
  const plan = {
    notes: planImportNotes(s.db, snapshot, stats),
    facts: planImportFacts(s.db, snapshot, stats),
    chunks: planImportChunks(s.db, snapshot, stats),
    edges: planImportEdges(s.db, snapshot, stats),
    candidates: planImportCandidates(s.db, snapshot, stats),
    ...meta,
  };

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

  transaction(s.db, () => {
    insertSnapshotNotes(s, plan.notes);
    insertSnapshotFacts(s, plan.facts);
    insertSnapshotChunks(s, plan.chunks);
    insertSnapshotCandidates(s, plan.candidates);
    insertSnapshotEdges(s, plan.edges);
    insertSnapshotMeta(s, plan);
  });
  resetEntityCache();
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
        WHERE IFNULL(scope, 'global') = ? AND text_hash = ? AND text = ?
          AND deleted_at IS NULL AND superseded_by IS NULL AND id <> ?
      `).get(row.scope ?? SCOPE_GLOBAL, hash(row.text), row.text, Number(id));
      if (activeText) return { restored: false, reason: 'active duplicate', activeId: Number(activeText.id) };
      // A tombstoned note may also have been superseded by a newer conclusion.
      // Restoring it must clear both states, otherwise the row is visible in the
      // audit list but still excluded from active search.
      prepareCached(s.db, 'UPDATE notes SET deleted_at = NULL, superseded_by = NULL, text_hash = ? WHERE id = ?')
        .run(hash(row.text), Number(id));
    } else if (table === 'facts') {
      prepareCached(s.db, 'UPDATE facts SET deleted_at = NULL, valid_to = NULL WHERE id = ?').run(Number(id));
    } else {
      prepareCached(s.db, 'UPDATE chunks SET deleted_at = NULL WHERE id = ?').run(Number(id));
    }
    if (table === 'notes') {
      reindexRow(s, 'note', Number(id), row.text);
    } else if (table === 'facts') {
      const text = String(row.text ?? `${row.subject} ${row.relation} ${row.object}`);
      reindexRow(s, 'fact', Number(id), text);
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
      reindexRow(s, 'chunk', Number(id), row.text);
    }
    return { restored: true };
  });
  if (result.restored) invalidateProfile();
  return result;
}

function insertChunk(s, input) {
  const { db } = s;
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
    reindexRow(s, 'chunk', id, text);
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
  const existing = findNoteByTextIndex(s.db, scope, text, 'AND deleted_at IS NULL AND superseded_by IS NULL');
  if (existing) return { id: Number(existing.id), deduped: true };
  const candidateTs = Number(row.ts);
  const ts = Number.isFinite(candidateTs) && candidateTs > 0 ? candidateTs : now();
  const confidence = Number(row.confidence);
  const importance = Number.isFinite(confidence)
    ? Number(Math.min(0.9, Math.max(0.3, 0.4 + confidence * 0.4)).toFixed(3))
    : 0.55;
  const source = row.source ? `${row.source} · candidate:${row.id}` : `candidate:${row.id}`;
  const raced = findNoteByTextIndex(s.db, scope, text, 'AND deleted_at IS NULL AND superseded_by IS NULL');
  if (raced) return { id: Number(raced.id), deduped: true };
  const info = prepareCached(s.db, `
    INSERT INTO notes(ts, scope, text, text_hash, importance, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ts, scope, text, hash(text), importance, source);
  const noteId = Number(info.lastInsertRowid);
  reindexRow(s, 'note', noteId, text);
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
        ts, scope, text, text_hash, importance, source, problem_key, solution_status,
        solution_verified_at, reuse_count, last_used_at, evidence,
        recall_count, last_recall_at, useful_count, misleading_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts, scope, summaryText, hash(summaryText), importance,
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
    reindexRow(s, 'note', summaryId, summaryText);
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
/** Late-bound helper for the host session context. */
export function setHostCtx(value) {
  hostCtx = value;
}

/** Late-bound helper for the injected-profile counter. */
export function setLastInjection(value) {
  lastInjection = value;
}

export { DSH_HOME, PKG_VERSION, currentPackageVersion, DB_DIR, DB_FILE, DB_TAG, BACKUP_DIR, BACKUP_MAX_BYTES, PROFILE_BUDGET, PROFILE_CACHE_MS, MAX_CAPTURE_CHARS, BUSY_TIMEOUT_MS, OPEN_LEASE_WAIT_MS, store, localToolDefinitions, HTTP_TOOL_ALLOWLIST, statementCache, STATEMENT_CACHE_MAX, prepareCached, SCOPE_GLOBAL, cwdBySession, projectByAgent, MAX_PENDING_VECTORS, REMOTE_PROBE_TEXT, fnv1a, PROJECT_IDENTITY_FILE_NAMES, PROJECT_IDENTITY_CACHE_MS, PROJECT_IDENTITY_CACHE, readProjectIdentityFile, projectKeyFromPath, WORKSPACES_DIR, workspaceLabelFromDirName, normalizeWorkspaceLabel, workspaceCache, WORKSPACE_CACHE_MS, discoverWorkspaces, GLOBAL_HINTS, GLOBAL_STRONG_HINTS, PROJECT_HINTS, classifyScope, normalizeScopeInput, httpScope, decideScope, newScopeFlag, normalizeProjectPath, projectPathsEqual, resolveScopeAlias, resolveProjectKey, upsertScopeAlias, ensureProjectAlias, SCOPE_ALIAS_REPAIR_VERSION, repairScopeAliases, judgeQueue, MAX_JUDGE_QUEUE, judgeBusy, lastJudge, judgeMode, pickJudgeRoute, enqueueJudge, flushJudge, currentProject, AUTO_RECALL_TTL_MS, lastUserByAgent, recallByAgent, lastInjection, autoRecallEnabled, now, hash, findNoteByTextIndex, schemaVersionOnDisk, backupBeforeMigration, hostCtx, columnExists, addColumn, tableExists, notesFtsIsExternal, ensureHotIndexes, NOTE_HASH_MIGRATION_BATCH, ensureNoteTextHash, createCompactBigrams, ensureCompactBigrams, notesFtsTriggers, ensureExternalNotesFts, MIGRATIONS, migrate, backfillFts, CJK_BIGRAM, indexBigrams, BIGRAM_BACKFILL_BATCH, backfillBigrams, reindexBigrams, pendingVectors, remoteDim, remoteSignatureValue, remoteProbeFailedAt, vectorDropped, vectorLastDropAt, REMOTE_PROBE_COOLDOWN_MS, metaGet, metaSet, remoteSignature, restoreRemoteState, ensureRemoteDim, enqueueVector, upsertVector, indexVector, backfillRemoteBatch, flushPendingVectors, activeVectorDim, SEMANTIC_BATCH, SEMANTIC_BACKFILL_SCAN, SEMANTIC_MAX_PENDING, SEMANTIC_MIN_COSINE, SEMANTIC_LEASE_MS, SEMANTIC_RETRY_BASE_MS, SEMANTIC_RETRY_MAX_MS, semanticStates, semanticState, semanticBackoffMs, noteSemanticFailure, clearSemanticFailure, scheduleSemanticWorker, enqueueSemantic, releaseSemanticLease, dropDerivedRows, dropDerivedIndexes, reindexRow, pruneSemanticVectors, semanticHasMissing, scheduleSemanticBackfill, semanticBackfill, writeSemantic, flushSemanticPending, runSemanticWorker, semanticStatus, reindexSemantic, STARTUP_VECTOR_BATCH, backfillVectors, transactionDepth, savepointCounter, transaction, sleepSync, acquireLease, releaseLease, renewLease, forgetMemory, EXPORT_FORMAT, EXPORT_VERSION, IMPORT_VERDICTS, IMPORT_SOLUTION_STATUSES, importNumber, positiveIdOrNull, snapshotStore, backupPath, exportBackup, importBackup, planImportNotes, planImportFacts, planImportChunks, planImportEdges, planImportCandidates, planImportMeta, insertSnapshotNotes, insertSnapshotFacts, insertSnapshotChunks, insertSnapshotCandidates, insertSnapshotEdges, insertSnapshotMeta, mergeSnapshot, restoreMemory, insertChunk, CANDIDATE_ROLES, resolveTranscriptScope, insertNoteCandidate, candidateScope, writeCandidateNoteInTransaction, summarizeProblemNotes };
