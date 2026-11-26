// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Project code index — scan, parse, store, query.
 *
 * Design boundary:
 *  - source files are the authority; this module only keeps locators;
 *  - `code_*` tables are a rebuildable cache, not notes;
 *  - exact lookup (path/symbol/route) stays SQL-first;
 *  - summaries are truncated, never source bodies.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseJavaScript } from './project-adapters/js.mjs';
import { parseGeneric, parseCtagsJson } from './project-adapters/generic.mjs';
import { parseOpenApi, parseGraphQL } from './project-adapters/api.mjs';
import { clearProjectScope, createProjectIndexSchema } from './project-schema.mjs';

const CODE_LANGS = new Map(Object.entries({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'csharp', '.php': 'php', '.rb': 'ruby', '.swift': 'swift', '.dart': 'dart',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.sh': 'shell', '.ps1': 'powershell', '.lua': 'lua', '.gd': 'gdscript',
  '.vue': 'vue', '.svelte': 'svelte',
}));
const SPEC_LANGS = new Map(Object.entries({ '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml' }));
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);
const MANIFESTS = new Set(['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'build.gradle', 'pubspec.yaml']);
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'target', 'vendor', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.workbuddy', '.idea', '.vscode']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_SYMBOLS_PER_FILE = 400;
const STALE_SAMPLE_LIMIT = 200;

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function langOf(rel, buffer) {
  const ext = path.extname(rel).toLowerCase();
  if (CODE_LANGS.has(ext)) return { lang: CODE_LANGS.get(ext), kind: 'code' };
  if (DOC_EXT.has(ext)) return { lang: ext.slice(1), kind: 'doc' };
  if (MANIFESTS.has(path.basename(rel))) return { lang: path.basename(rel), kind: 'manifest' };
  if (SPEC_LANGS.has(ext) && looksLikeSpec(buffer)) return { lang: 'openapi', kind: 'spec' };
  if (SPEC_LANGS.has(ext)) return { lang: ext.slice(1), kind: 'data' };
  if (['.graphql', '.gql'].includes(ext)) return { lang: 'graphql', kind: 'spec' };
  return { lang: ext.slice(1) || 'text', kind: 'other' };
}

function looksLikeSpec(buffer) {
  const head = buffer.slice(0, Math.min(buffer.length, 400)).toString('utf8').trim();
  return /^openapi\s*:/im.test(head) || /"openapi"\s*:/i.test(head) || /"swagger"\s*:/i.test(head);
}

function isText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.slice(0, Math.min(buffer.length, 8000));
  return !sample.includes(0);
}

function countLines(text) {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;
  return count;
}

function relative(root, file) {
  return toPosix(path.relative(root, file));
}

function walkFiles(root, options = {}) {
  const out = [];
  const missing = [];
  const visit = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= (options.maxFiles ?? MAX_FILES)) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      if (stat.size > (options.maxFileBytes ?? MAX_FILE_BYTES)) continue;
      let buffer;
      try { buffer = readFileSync(full); } catch { missing.push(full); continue; }
      if (!isText(buffer)) continue;
      const rel = relative(root, full);
      const meta = langOf(rel, buffer);
      const file = {
        path: rel,
        abs: full,
        bytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sha256: sha256(buffer),
        lang: meta.lang,
        kind: meta.kind,
        text: '',
        loc: 0,
      };
      if (['code', 'spec', 'manifest', 'doc'].includes(meta.kind)) {
        try {
          file.text = buffer.toString('utf8').replace(/^\uFEFF/, '');
          file.loc = countLines(file.text);
        } catch { /* keep inventory without text */ }
      }
      out.push(file);
    }
  };
  visit(root);
  return { files: out, missing };
}

function readManifest(root, file) {
  try {
    if (path.basename(file.path) === 'package.json') {
      const pkg = JSON.parse(file.text);
      return { kind: 'node', name: String((pkg.name ?? path.basename(path.dirname(file.path))) || 'root'), description: String(pkg.description ?? '') };
    }
    if (path.basename(file.path) === 'go.mod') {
      const name = file.text.match(/^module\s+([^\s]+)/m)?.[1] ?? '';
      return { kind: 'go', name, description: '' };
    }
    if (path.basename(file.path) === 'Cargo.toml') {
      const name = file.text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? '';
      return { kind: 'rust', name, description: '' };
    }
    if (path.basename(file.path) === 'pyproject.toml') {
      const name = file.text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? '';
      return { kind: 'python', name, description: '' };
    }
    if (path.basename(file.path) === 'pom.xml') {
      const name = file.text.match(/<artifactId>([^<]+)</)?.[1] ?? '';
      return { kind: 'java', name, description: '' };
    }
    if (path.basename(file.path) === 'build.gradle') return { kind: 'gradle', name: path.basename(path.dirname(file.path)) || 'root', description: '' };
    if (path.basename(file.path) === 'pubspec.yaml') {
      const name = file.text.match(/^name:\s*([^\s#]+)/m)?.[1] ?? '';
      return { kind: 'dart', name, description: '' };
    }
    if (path.extname(file.path).toLowerCase() === '.csproj') {
      const name = path.basename(file.path, '.csproj');
      return { kind: 'dotnet', name, description: '' };
    }
  } catch { /* invalid manifest still marks a module root */ }
  return { kind: 'generic', name: path.basename(path.dirname(file.path)) || 'root', description: '' };
}

function readmeDescription(root, module) {
  const candidates = ['README.md', 'README.txt', 'readme.md'];
  for (const name of candidates) {
    const full = path.join(root, module.rootPath === '.' ? '' : module.rootPath, name);
    if (!existsSync(full)) continue;
    try {
      const text = readFileSync(full, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
      const prose = lines.find(line => !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('['));
      if (prose) return prose.replace(/[*_`>]/g, '').slice(0, 260);
    } catch { /* ignore */ }
  }
  return '';
}

function discoverModules(root, files) {
  const roots = new Map();
  const add = (rootPath, manifest, extra = {}) => {
    const posix = toPosix(rootPath || '.');
    if (!roots.has(posix)) {
      roots.set(posix, {
        rootPath: posix,
        key: `module:${posix === '.' ? 'root' : posix}`,
        name: extra.name || (posix === '.' ? 'root' : path.basename(posix)),
        kind: extra.kind || 'generic',
        manifest: manifest || '',
        description: extra.description || '',
      });
    }
  };
  for (const file of files) {
    const base = path.basename(file.path);
    const isManifest = MANIFESTS.has(base) || base.endsWith('.csproj');
    if (!isManifest) continue;
    const dir = path.dirname(file.path);
    const meta = readManifest(root, file);
    add(dir === '.' ? '.' : dir, file.path, meta);
  }
  // Every top-level source directory becomes a module when no manifest exists;
  // this keeps a plain folder tree searchable without pretending it is a package.
  if (!roots.size) {
    for (const file of files) {
      if (file.kind !== 'code') continue;
      const first = file.path.split('/')[0];
      if (first && !file.path.startsWith(`${first}/`)) add('.', '', { name: 'root', kind: 'generic' });
      else if (first) add(first, '', { name: first, kind: 'generic' });
    }
    if (!roots.size) add('.', '', { name: 'root', kind: 'generic' });
  }
  for (const module of roots.values()) {
    if (!module.description) module.description = readmeDescription(root, module);
  }
  const ordered = [...roots.values()].sort((a, b) => b.rootPath.length - a.rootPath.length);
  for (const file of files) {
    const owner = ordered.find(module => module.rootPath === '.' || file.path === module.rootPath || file.path.startsWith(`${module.rootPath}/`));
    file.moduleKey = owner?.key ?? 'module:root';
  }
  // Root fallback module for files outside every package.
  if (!roots.has('.')) {
    const hasUnassigned = files.some(file => file.moduleKey === 'module:root' && !ordered.some(module => module.rootPath === '.' && file.path.startsWith('.')));
    if (hasUnassigned || files.some(file => file.path.split('/').length === 1)) {
      add('.', '', { name: 'root', kind: 'generic' });
      for (const file of files) if (file.moduleKey === 'module:root') file.moduleKey = 'module:root';
    }
  }
  return [...roots.values()];
}

function parseFile(file) {
  if (!file.text) return { symbols: [], imports: [], apis: [], schemas: [] };
  if (['javascript', 'typescript'].includes(file.lang)) {
    return parseJavaScript(file.text, file.path);
  }
  if (file.kind === 'spec' && file.lang === 'openapi') {
    const value = parseOpenApi(file.text, file.path);
    return { symbols: value.schemas ?? [], imports: [], apis: value.apis ?? [], schemas: value.schemas ?? [] };
  }
  if (file.kind === 'spec' && file.lang === 'graphql') {
    const value = parseGraphQL(file.text, file.path);
    return { symbols: value.symbols ?? [], imports: [], apis: value.apis ?? [], schemas: [] };
  }
  if (file.kind === 'code') {
    return { ...parseGeneric(file.text, file.path, file.lang), schemas: [] };
  }
  return { symbols: [], imports: [], apis: [], schemas: [] };
}

function extVariants(base) {
  return [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    `${base}.py`, `${base}.go`, `${base}.rs`, `${base}.java`, `${base}.cs`, `${base}.php`, `${base}.rb`,
    `${base}.gd`, `${base}.lua`,
  ];
}

function resolveImport(fromPath, specifier, filePaths) {
  const spec = String(specifier ?? '').trim();
  if (!spec || /^(?:node:|https?:|data:)/.test(spec)) return '';
  let base;
  if (spec.startsWith('.')) {
    base = toPosix(path.join(path.dirname(fromPath), spec));
  } else if (spec.startsWith('@/')) {
    base = toPosix(path.join('src', spec.slice(2)));
  } else {
    return `pkg:${spec}`;
  }
  for (const candidate of [...extVariants(base), `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (filePaths.has(candidate)) return `code:${candidate}`;
  }
  return `pkg:${spec}`;
}

function routeRef(rel, line, method, route) {
  return `code:${rel}#L${line}:api:${String(method).toUpperCase()}:${route}`;
}

function specRef(rel, specRefValue) {
  return specRefValue || `spec:${rel}`;
}

function symbolRowsForApi(api, file) {
  if (!api) return null;
  return api;
}

function metaKey(scope, key) {
  return `project_index:${scope}:${key}`;
}

function readMeta(db, key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? '';
  } catch { return ''; }
}

function writeMeta(db, key, value) {
  try { db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value)); } catch { /* best effort */ }
}

function fileStamp(root, row) {
  try {
    const full = path.join(root, row.path);
    const stat = statSync(full);
    if (!stat.isFile()) return { stale: true, missing: true };
    let stale = Math.trunc(stat.mtimeMs) !== Number(row.mtime_ms) || stat.size !== Number(row.bytes);
    // mtime+size can be preserved by a checkout or a tool; when a sha is known,
    // compare content too so a silent code change never looks fresh.
    if (!stale && row.sha256) {
      try { stale = sha256(readFileSync(full)) !== row.sha256; } catch { stale = true; }
    }
    return { stale, missing: false };
  } catch {
    return { stale: true, missing: true };
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

function staleForPath(db, scope, root, pathValue, cache) {
  if (!pathValue) return false;
  if (cache.has(pathValue)) return cache.get(pathValue);
  let file = null;
  try { file = db.prepare('SELECT mtime_ms, bytes, sha256 FROM code_files WHERE scope = ? AND path = ?').get(scope, pathValue); } catch { /* no store */ }
  const value = fileStamp(root, { path: pathValue, mtime_ms: file?.mtime_ms ?? 0, bytes: file?.bytes ?? 0, sha256: file?.sha256 }).stale;
  cache.set(pathValue, value);
  return value;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* statement may have closed it */ }
    throw error;
  }
}

function deleteFileRows(db, scope, pathValue, includeIncoming = false) {
  db.prepare('DELETE FROM code_symbols WHERE scope = ? AND path = ?').run(scope, pathValue);
  db.prepare('DELETE FROM code_apis WHERE scope = ? AND source_path = ?').run(scope, pathValue);
  const incoming = includeIncoming ? ' OR dst = ?' : '';
  const args = [scope, `code:${pathValue}`, `code:${pathValue}#%`];
  if (includeIncoming) args.push(`code:${pathValue}`);
  args.push(`code:${pathValue}#%`);
  db.prepare(`DELETE FROM code_edges WHERE scope = ? AND
    (src = ? OR src LIKE ?${incoming} OR source_ref LIKE ?)`).run(...args);
}

function insertCtagsIfAvailable(db, root, scope, files, report) {
  const explicit = process.env.OMNI_CTAGS_BIN;
  const command = explicit || 'ctags';
  try {
    const output = execFileSync(command, ['--output-format=json', '--fields=+n', '-R', '-f', '-', '.'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    const symbols = parseCtagsJson(output, '.');
    let added = 0;
    for (const symbol of symbols) {
      const rel = toPosix(symbol.path ?? '');
      if (!rel || !files.some(file => file.path === rel)) continue;
      const file = files.find(item => item.path === rel);
      if (['javascript', 'typescript', 'openapi', 'graphql'].includes(file.lang)) continue;
      db.prepare(`INSERT OR IGNORE INTO code_symbols
        (scope, path, module_key, kind, name, qualified_name, signature, start_line, end_line, exported, doc, source_ref, sha256, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope, rel, file.moduleKey, symbol.kind, symbol.name, symbol.qualifiedName, symbol.signature, symbol.startLine, symbol.endLine, symbol.exported ? 1 : 0, symbol.doc, symbol.sourceRef, file.sha256, Date.now());
      added += 1;
    }
    report.ctags = { available: true, added };
  } catch (error) {
    report.ctags = { available: false, error: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * Scan and upsert one project. Returns a compact report; `scope` is supplied by
 * the caller so the same checkout can be visible as a project or global layer.
 */
export function indexProject(db, root, options = {}) {
  const started = Date.now();
  const absolute = path.resolve(String(root ?? '.'));
  const scope = String(options.scope ?? 'global');
  const full = options.full === true;
  createProjectIndexSchema(db);
  const scan = walkFiles(absolute, options);
  const files = scan.files;
  const modules = discoverModules(absolute, files);
  const filePaths = new Set(files.map(file => file.path));
  const existing = new Map(db.prepare('SELECT path, sha256, mtime_ms, bytes, module_key FROM code_files WHERE scope = ?').all(scope).map(row => [row.path, row]));
  const report = {
    ok: true, scope, root: absolute, files: files.length, parsed: 0, unchanged: 0,
    removed: 0, symbols: 0, apis: 0, modules: modules.length, edges: 0,
    ctags: null, durationMs: 0,
  };
  if (full) clearProjectScope(db, scope);

  const parsedFiles = [];
  for (const file of files) {
    const prior = existing.get(file.path);
    const unchanged = !full && prior && prior.sha256 === file.sha256 && prior.module_key === file.moduleKey;
    if (unchanged) {
      report.unchanged += 1;
      continue;
    }
    report.parsed += 1;
    const parsed = parseFile(file);
    file.parsed = parsed;
    parsedFiles.push(file);
  }

  transaction(db, () => {
    const now = Date.now();
    for (const file of parsedFiles) {
      deleteFileRows(db, scope, file.path);
      db.prepare(`INSERT OR REPLACE INTO code_files
        (scope, path, module_key, lang, bytes, loc, sha256, mtime_ms, indexed_at, git_commit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope, file.path, file.moduleKey, file.lang, file.bytes, file.loc, file.sha256, file.mtimeMs, now, options.gitCommit ?? null);
      const parsed = file.parsed ?? parseFile(file);
      for (const symbol of (parsed.symbols ?? []).slice(0, MAX_SYMBOLS_PER_FILE)) {
        const sourceRef = symbol.sourceRef || `code:${file.path}#L${symbol.startLine ?? 0}:${symbol.kind}:${symbol.name}`;
        db.prepare(`INSERT OR REPLACE INTO code_symbols
          (scope, path, module_key, kind, name, qualified_name, signature, start_line, end_line, exported, doc, source_ref, sha256, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(scope, file.path, file.moduleKey, symbol.kind, symbol.name, symbol.qualifiedName ?? symbol.name,
            symbol.signature ?? '', symbol.startLine ?? 0, symbol.endLine ?? 0, symbol.exported ? 1 : 0,
            symbol.doc ?? '', sourceRef, file.sha256, now);
      }
      for (const api of (parsed.apis ?? []).slice(0, 200)) {
        const sourceRef = api.specRef || routeRef(file.path, api.line ?? 0, api.method, api.route);
        db.prepare(`INSERT OR REPLACE INTO code_apis
          (scope, module_key, kind, method, route, handler, source_path, line, auth, summary, request, response, errors, tags, source_ref, spec_ref, sha256, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(scope, file.moduleKey, api.kind ?? 'route', String(api.method ?? 'GET').toUpperCase(),
            api.route ?? '/', api.handler ?? '', file.path, api.line ?? 0, api.auth ?? '', api.summary ?? '',
            api.request ?? '', api.response ?? '', api.errors ?? '', api.tags ?? '', sourceRef, api.specRef ?? '', file.sha256, now);
      }
      for (const spec of parsed.imports ?? []) {
        const dst = resolveImport(file.path, spec.specifier, filePaths);
        if (!dst) continue;
        db.prepare(`INSERT OR IGNORE INTO code_edges (scope, src, dst, kind, source_ref, line)
          VALUES (?, ?, ?, 'imports', ?, ?)`)
          .run(scope, `code:${file.path}`, dst, `code:${file.path}#L${spec.line}:import`, spec.line);
      }
      if (isTestFile(file.path)) {
        db.prepare(`INSERT OR IGNORE INTO code_edges (scope, src, dst, kind, source_ref, line)
          VALUES (?, ?, ?, 'tests', ?, 1)`)
          .run(scope, `code:${file.path}`, file.moduleKey, `code:${file.path}#L1:test`);
      }
    }

    // Remove rows for files that disappeared since the previous scan.
    for (const [pathValue] of existing) {
      if (filePaths.has(pathValue)) continue;
      deleteFileRows(db, scope, pathValue, true);
      db.prepare('DELETE FROM code_files WHERE scope = ? AND path = ?').run(scope, pathValue);
      report.removed += 1;
    }

    // Module table is a snapshot. Contains edges are rebuilt each sync so the
    // impact query can walk file -> module -> tests without a call graph.
    db.prepare('DELETE FROM code_modules WHERE scope = ?').run(scope);
    db.prepare("DELETE FROM code_edges WHERE scope = ? AND kind IN ('contains', 'tests')").run(scope);
    for (const module of modules) {
      const publicSurface = db.prepare(`SELECT name FROM code_symbols WHERE scope = ? AND module_key = ? AND exported = 1 ORDER BY name LIMIT 12`).all(scope, module.key).map(row => row.name).join(', ');
      db.prepare(`INSERT OR REPLACE INTO code_modules
        (scope, key, name, root_path, kind, manifest, description, public_surface, source_ref, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scope, module.key, module.name, module.rootPath, module.kind, module.manifest,
          module.description || `${db.prepare('SELECT COUNT(*) AS n FROM code_files WHERE scope = ? AND module_key = ?').get(scope, module.key).n} files`,
          publicSurface, module.key, now);
    }
    for (const file of files) {
      db.prepare(`INSERT OR IGNORE INTO code_edges (scope, src, dst, kind, source_ref, line)
        VALUES (?, ?, ?, 'contains', ?, 1)`)
        .run(scope, file.moduleKey, `code:${file.path}`, `code:${file.path}#L1:contains`);
    }
    for (const module of modules) {
      for (const file of files.filter(item => item.moduleKey === module.key && isTestFile(item.path))) {
        db.prepare(`INSERT OR IGNORE INTO code_edges (scope, src, dst, kind, source_ref, line)
          VALUES (?, ?, ?, 'tests', ?, 1)`)
          .run(scope, `code:${file.path}`, module.key, `code:${file.path}#L1:test`);
      }
    }
  });

  // ctags is optional and runs outside the write transaction; its rows are
  // locators just like the built-in readers.
  if (options.ctags !== false) insertCtagsIfAvailable(db, absolute, scope, files, report);

  report.symbols = db.prepare('SELECT COUNT(*) AS n FROM code_symbols WHERE scope = ?').get(scope).n;
  report.apis = db.prepare('SELECT COUNT(*) AS n FROM code_apis WHERE scope = ?').get(scope).n;
  report.edges = db.prepare('SELECT COUNT(*) AS n FROM code_edges WHERE scope = ?').get(scope).n;
  report.durationMs = Date.now() - started;
  writeMeta(db, metaKey(scope, 'last_at'), Date.now());
  writeMeta(db, metaKey(scope, 'root'), absolute);
  writeMeta(db, metaKey(scope, 'last_commit'), options.gitCommit ?? '');
  writeMeta(db, metaKey(scope, 'version'), '1');
  return report;
}

function isTestFile(rel) {
  const lower = toPosix(rel).toLowerCase();
  const base = path.basename(lower);
  return /\/test\//.test(lower) || /\/tests\//.test(lower) || /\.(test|spec)\./.test(base)
    || /^test_/.test(base) || /_test\.([a-z]+)$/.test(base);
}

export function projectStatus(db, root, options = {}) {
  const scope = String(options.scope ?? 'global');
  const storedRoot = String(root || readMeta(db, metaKey(scope, 'root')) || '').trim();
  const files = db.prepare('SELECT path, mtime_ms, bytes, sha256 FROM code_files WHERE scope = ?').all(scope);
  let stale = 0;
  let missing = 0;
  for (const row of files) {
    const stamp = fileStamp(storedRoot, row);
    if (stamp.stale) stale += 1;
    if (stamp.missing) missing += 1;
  }
  return {
    ok: true,
    scope,
    root: storedRoot,
    indexedAt: Number(readMeta(db, metaKey(scope, 'last_at')) || 0) || null,
    version: readMeta(db, metaKey(scope, 'version')) || null,
    counts: {
      files: files.length,
      modules: db.prepare('SELECT COUNT(*) AS n FROM code_modules WHERE scope = ?').get(scope).n,
      symbols: db.prepare('SELECT COUNT(*) AS n FROM code_symbols WHERE scope = ?').get(scope).n,
      apis: db.prepare('SELECT COUNT(*) AS n FROM code_apis WHERE scope = ?').get(scope).n,
      edges: db.prepare('SELECT COUNT(*) AS n FROM code_edges WHERE scope = ?').get(scope).n,
    },
    stale,
    missing,
  };
}

function indexedRoot(db, scope) {
  return readMeta(db, metaKey(scope, 'root')) || '';
}

function score(value, query) {
  const text = String(value ?? '').toLowerCase();
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) return 0;
  if (text === q) return 100;
  if (text.startsWith(q)) return 82;
  if (text.includes(q)) return 62;
  const tokens = q.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (!tokens.length) return 0;
  const hit = tokens.filter(token => text.includes(token)).length;
  return hit ? 30 + hit * 4 : 0;
}

function boundedLimit(value, fallback, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function searchSymbols(db, scope, query, options) {
  const limit = boundedLimit(options.limit, 20, 80);
  const where = ['scope = ?'];
  const params = [scope];
  if (query) {
    where.push("(name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR doc LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(query)}%`;
    params.push(like, like, like, like);
  }
  if (options.kind && !['*', 'all', 'api', 'route', 'module', 'file'].includes(options.kind)) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options.path) { where.push("path LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.path)}%`); }
  if (options.module) { where.push("module_key LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.module)}%`); }
  const rows = db.prepare(`SELECT path, module_key, kind, name, qualified_name, signature, start_line, end_line, exported, doc, source_ref, sha256
    FROM code_symbols WHERE ${where.join(' AND ')} ORDER BY name LIMIT ${limit * 4}`).all(...params);
  return rows
    .map(row => ({
      kind: row.kind, name: row.name, qualifiedName: row.qualified_name,
      signature: row.signature, path: row.path, module: row.module_key,
      line: row.start_line, endLine: row.end_line, exported: Boolean(row.exported),
      doc: row.doc, sourceRef: row.source_ref, sha: row.sha256,
      score: score(row.qualified_name, query) + score(row.name, query) + (row.exported ? 5 : 0),
    }))
    .filter(row => !query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function searchApis(db, scope, query, options) {
  const limit = boundedLimit(options.limit, 15, 60);
  const where = ['scope = ?'];
  const params = [scope];
  if (query) {
    where.push("(route LIKE ? ESCAPE '\\' OR handler LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR request LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(query)}%`;
    params.push(like, like, like, like, like);
  }
  if (options.method) { where.push('method = ?'); params.push(String(options.method).toUpperCase()); }
  if (options.path) { where.push("source_path LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.path)}%`); }
  if (options.module) { where.push("module_key LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.module)}%`); }
  const rows = db.prepare(`SELECT kind, module_key, method, route, handler, source_path, line, auth, summary, request, response, errors, tags, source_ref, spec_ref, sha256
    FROM code_apis WHERE ${where.join(' AND ')} ORDER BY route LIMIT ${limit * 4}`).all(...params);
  return rows
    .map(row => ({
      kind: row.kind, method: row.method, route: row.route, handler: row.handler,
      path: row.source_path, module: row.module_key ?? '', line: row.line, auth: row.auth,
      summary: row.summary, request: row.request, response: row.response, errors: row.errors,
      tags: row.tags, sourceRef: row.source_ref, specRef: row.spec_ref, sha: row.sha256,
      score: score(row.route, query) + score(row.handler, query) + score(row.summary, query),
    }))
    .filter(row => !query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))
    .slice(0, limit);
}

function searchModules(db, scope, query, options) {
  const limit = boundedLimit(options.limit, 12, 48);
  const where = ['scope = ?'];
  const params = [scope];
  if (query) {
    where.push("(key LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR public_surface LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(query)}%`;
    params.push(like, like, like, like);
  }
  if (options.module) { where.push("(key LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"); const like = `%${escapeLike(options.module)}%`; params.push(like, like); }
  const rows = db.prepare(`SELECT key, name, root_path, kind, manifest, description, public_surface, source_ref
    FROM code_modules WHERE ${where.join(' AND ')} ORDER BY key LIMIT ${limit * 4}`).all(...params);
  return rows.map(row => ({
    key: row.key, name: row.name, root: row.root_path, kind: row.kind, manifest: row.manifest,
    description: row.description, publicSurface: row.public_surface, sourceRef: row.source_ref,
    score: score(row.name, query) + score(row.description, query) + score(row.key, query),
  })).filter(row => !query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function searchFiles(db, scope, query, options) {
  const limit = boundedLimit(options.limit, 12, 48);
  const where = ['scope = ?'];
  const params = [scope];
  if (query) { where.push("path LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(query)}%`); }
  if (options.path) { where.push("path LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.path)}%`); }
  if (options.module) { where.push("module_key LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(options.module)}%`); }
  const rows = db.prepare(`SELECT path, module_key, lang, bytes, loc, sha256, mtime_ms, indexed_at
    FROM code_files WHERE ${where.join(' AND ')} ORDER BY path LIMIT ${limit * 4}`).all(...params);
  return rows.map(row => ({
    path: row.path, module: row.module_key, lang: row.lang, bytes: row.bytes, loc: row.loc,
    sha: row.sha256, indexedAt: row.indexed_at,
    score: score(row.path, query),
  })).filter(row => !query || row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function projectSearch(db, query, options = {}) {
  const started = Date.now();
  const scope = String(options.scope ?? 'global');
  const q = String(query ?? '').trim();
  const root = String(options.root || indexedRoot(db, scope));
  const cache = new Map();
  const want = String(options.kind ?? 'all');
  const result = {
    ok: true, scope, query: q, root, modules: [], symbols: [], apis: [], files: [], stale: 0, elapsedMs: 0,
  };
  if (want === 'all' || want === 'module') result.modules = searchModules(db, scope, q, options);
  if (want === 'all' || want === 'file' || ['module', 'symbol'].includes(want)) result.files = searchFiles(db, scope, q, options);
  if (want === 'all' || want === 'symbol' || CODE_KIND_SET.has(want)) result.symbols = searchSymbols(db, scope, q, options);
  if (want === 'all' || want === 'api' || want === 'route') result.apis = searchApis(db, scope, q, options);
  for (const row of [...result.symbols, ...result.apis, ...result.files]) {
    row.stale = staleForPath(db, scope, root, row.path, cache);
  }
  result.stale = [...result.symbols, ...result.apis, ...result.files].filter(row => row.stale).length;
  result.elapsedMs = Date.now() - started;
  return result;
}

const CODE_KIND_SET = new Set(['function', 'class', 'method', 'constructor', 'interface', 'type', 'enum', 'const', 'field', 'schema', 'struct', 'trait', 'symbol']);

function sourceOf(row) {
  return row.sourceRef || row.source_ref || (row.path ? `code:${row.path}` : '');
}

function moduleFor(db, scope, key) {
  return db.prepare('SELECT * FROM code_modules WHERE scope = ? AND key = ?').get(scope, key)
    ?? db.prepare('SELECT * FROM code_modules WHERE scope = ? AND name = ? LIMIT 1').get(scope, key)
    ?? null;
}

function resolveRefs(db, scope, ref, options = {}) {
  const value = String(ref ?? '').trim();
  if (!value) return [];
  const found = [];
  const add = (type, row) => {
    if (!row) return;
    const key = `${type}:${row.source_ref || row.sourceRef || row.key || row.path}`;
    if (!found.some(item => item.id === key)) found.push({ id: key, type, row });
  };
  const sym = db.prepare('SELECT * FROM code_symbols WHERE scope = ? AND source_ref = ?').get(scope, value);
  if (sym) add('symbol', sym);
  const api = db.prepare('SELECT * FROM code_apis WHERE scope = ? AND (source_ref = ? OR spec_ref = ?)').get(scope, value, value);
  if (api) add('api', api);
  const mod = db.prepare('SELECT * FROM code_modules WHERE scope = ? AND (key = ? OR name = ?)').get(scope, value, value);
  if (mod) add('module', mod);
  const file = db.prepare('SELECT * FROM code_files WHERE scope = ? AND path = ?').get(scope, value);
  if (file) add('file', file);
  if (!found.length && /^code:|^spec:|^module:/i.test(value)) {
    const byRef = db.prepare('SELECT * FROM code_symbols WHERE scope = ? AND source_ref = ? LIMIT 1').get(scope, value);
    if (byRef) add('symbol', byRef);
  }
  if (!found.length) {
    const search = projectSearch(db, value, { ...options, scope, kind: 'all' });
    for (const item of search.modules.slice(0, 2)) add('module', { key: item.key, name: item.name, root_path: item.root, source_ref: item.sourceRef });
    for (const item of search.symbols.slice(0, 3)) {
      add('symbol', {
        name: item.name, qualified_name: item.qualifiedName, kind: item.kind, signature: item.signature,
        path: item.path, module_key: item.module, start_line: item.line, end_line: item.endLine,
        exported: item.exported ? 1 : 0, doc: item.doc, source_ref: item.sourceRef, sha256: item.sha,
      });
    }
    for (const item of search.apis.slice(0, 3)) {
      add('api', {
        kind: item.kind, method: item.method, route: item.route, handler: item.handler, source_path: item.path,
        line: item.line, auth: item.auth, summary: item.summary, request: item.request, response: item.response,
        errors: item.errors, tags: item.tags, source_ref: item.sourceRef, spec_ref: item.specRef, sha256: item.sha,
      });
    }
  }
  return found;
}

function moduleDependencies(db, scope, moduleKey) {
  const imports = db.prepare(`SELECT e.dst, COUNT(*) AS n
    FROM code_edges e JOIN code_files f ON e.src = 'code:' || f.path
    WHERE e.scope = ? AND f.scope = ? AND f.module_key = ? AND e.kind = 'imports'
    GROUP BY e.dst ORDER BY n DESC LIMIT 20`).all(scope, scope, moduleKey);
  const importedBy = db.prepare(`SELECT e.src, COUNT(*) AS n
    FROM code_edges e JOIN code_files f ON e.dst = 'code:' || f.path
    WHERE e.scope = ? AND f.scope = ? AND f.module_key = ? AND e.kind = 'imports'
    GROUP BY e.src ORDER BY n DESC LIMIT 20`).all(scope, scope, moduleKey);
  return { imports, importedBy };
}

function lineOfSymbol(row) {
  return row.source_ref?.match(/#L(\d+)/)?.[1] ?? String(row.start_line ?? row.line ?? 0);
}

function formatSymbol(row, stale) {
  const line = lineOfSymbol(row);
  const exported = row.exported ? ' exported' : '';
  const sig = row.signature ? ` ${row.signature}` : '';
  const sha = row.sha256 ? ` · sha:${String(row.sha256).slice(0, 12)}` : '';
  return `- \`${row.path}:${line}\` ${row.kind} \`${row.qualified_name || row.name}\`${sig}${exported}${sha}${stale ? ' · stale' : ''} · ${sourceOf(row)}`;
}

function formatApi(row, stale) {
  const line = row.line ? `:${row.line}` : '';
  const sha = row.sha256 ? ` · sha:${String(row.sha256).slice(0, 12)}` : '';
  return `- ${row.method} \`${row.route}\`${row.summary ? ` — ${row.summary}` : ''}${row.auth ? ` · auth:${row.auth}` : ''}${sha}${stale ? ' · stale' : ''} · ${row.source_path}${line} · ${sourceOf(row)}`;
}

function pushBudget(lines, value, budget) {
  if (value == null || value === '') return;
  const next = String(value);
  if (lines.join('\n').length + next.length + 1 > budget) return;
  lines.push(next);
}

/**
 * Build a bounded project packet for memory_context. It intentionally contains
 * sourceRef + line + sha + stale so a reader can return to the authoritative
 * file, while never embedding a source body.
 */
export function projectContext(db, ref, options = {}) {
  const started = Date.now();
  const scope = String(options.scope ?? 'global');
  const budget = Math.max(400, Number(options.budget ?? 1800));
  const root = String(options.root || indexedRoot(db, scope));
  const cache = new Map();
  const targets = resolveRefs(db, scope, ref, options);
  const lines = [`## 项目代码索引（derived · source is authoritative）`];
  if (!targets.length) {
    lines.push(`未找到项目引用：${String(ref ?? '')}`, '先运行 `omni index`，或换用模块名、路径、符号名、路由。');
    return { ok: false, scope, root, text: lines.join('\n'), refs: [], stale: 0, chars: lines.join('\n').length, elapsedMs: Date.now() - started };
  }
  const refs = [];
  for (const target of targets) {
    const row = target.row;
    if (target.type === 'module') {
      pushBudget(lines, `\n### 模块 \`${row.key}\` · ${row.name}`, budget);
      pushBudget(lines, `- root: \`${row.root_path}\` · kind: ${row.kind}${row.manifest ? ` · manifest: ${row.manifest}` : ''}`, budget);
      pushBudget(lines, `- 负责: ${row.description || '（无摘要，查看 README 与源码）'}`, budget);
      pushBudget(lines, `- 公开面: ${row.public_surface || '（无导出符号）'}`, budget);
      const deps = moduleDependencies(db, scope, row.key);
      if (deps.imports.length) pushBudget(lines, `- imports: ${deps.imports.map(item => item.dst).slice(0, 6).join(' · ')}`, budget);
      if (deps.importedBy.length) pushBudget(lines, `- imported by: ${deps.importedBy.map(item => item.src).slice(0, 6).join(' · ')}`, budget);
      const symbols = db.prepare(`SELECT * FROM code_symbols WHERE scope = ? AND module_key = ? AND exported = 1 ORDER BY kind, name LIMIT 12`).all(scope, row.key);
      for (const symbol of symbols) pushBudget(lines, formatSymbol(symbol, staleForPath(db, scope, root, symbol.path, cache)), budget);
      refs.push({ type: 'module', key: row.key, sourceRef: row.source_ref || row.key, sha: null, stale: false });
    } else if (target.type === 'file') {
      const stale = fileStamp(root, row).stale;
      pushBudget(lines, `\n### 文件 \`${row.path}\``, budget);
      pushBudget(lines, `- module: ${row.module_key} · ${row.lang} · ${row.loc} loc · sha:${row.sha256}${stale ? ' · stale' : ''}`, budget);
      const symbols = db.prepare('SELECT * FROM code_symbols WHERE scope = ? AND path = ? ORDER BY start_line LIMIT 12').all(scope, row.path);
      for (const symbol of symbols) pushBudget(lines, formatSymbol(symbol, stale), budget);
      refs.push({ type: 'file', path: row.path, sourceRef: `code:${row.path}`, sha: row.sha256, stale });
    } else if (target.type === 'api') {
      const stale = row.source_path ? staleForPath(db, scope, root, row.source_path, cache) : false;
      pushBudget(lines, `\n### API ${row.method} \`${row.route}\``, budget);
      pushBudget(lines, formatApi(row, stale), budget);
      if (row.request) pushBudget(lines, `- request: ${row.request}`, budget);
      if (row.response) pushBudget(lines, `- response: ${row.response}`, budget);
      if (row.errors) pushBudget(lines, `- errors: ${row.errors}`, budget);
      refs.push({ type: 'api', sourceRef: sourceOf(row), sha: row.sha256, stale });
    } else {
      const stale = staleForPath(db, scope, root, row.path, cache);
      pushBudget(lines, `\n### ${row.kind} \`${row.qualified_name || row.name}\``, budget);
      pushBudget(lines, formatSymbol(row, stale), budget);
      if (row.doc) pushBudget(lines, `- doc: ${row.doc}`, budget);
      refs.push({ type: 'symbol', sourceRef: sourceOf(row), sha: row.sha256, stale });
    }
  }
  const text = lines.join('\n');
  return {
    ok: true, scope, root, text,
    refs, stale: refs.filter(item => item.stale).length,
    chars: text.length, elapsedMs: Date.now() - started,
  };
}

function reverseImporters(db, scope, target, maxDepth) {
  const seen = new Set([target]);
  let frontier = [target];
  const rows = [];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const src of frontier) {
      const parents = db.prepare("SELECT src FROM code_edges WHERE scope = ? AND dst = ? AND kind = 'imports'").all(scope, src).map(row => row.src);
      for (const parent of parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        rows.push({ src: parent, depth });
        next.push(parent);
      }
    }
    frontier = next;
  }
  return rows;
}

export function projectImpact(db, ref, options = {}) {
  const started = Date.now();
  const scope = String(options.scope ?? 'global');
  const root = String(options.root || indexedRoot(db, scope));
  const maxDepth = Math.min(Math.max(Number(options.depth ?? 4), 1), 8);
  const targets = resolveRefs(db, scope, ref, options);
  if (!targets.length) {
    return { ok: false, scope, root, ref: String(ref ?? ''), targets: [], importers: [], tests: [], modules: [], stale: 0, elapsedMs: Date.now() - started };
  }
  const files = new Set();
  const modules = new Set();
  for (const target of targets) {
    if (target.type === 'module') modules.add(target.row.key);
    else if (target.type === 'file') { files.add(target.row.path); modules.add(target.row.module_key); }
    else { if (target.row.path || target.row.source_path) files.add(target.row.path || target.row.source_path); if (target.row.module_key) modules.add(target.row.module_key); }
  }
  const importers = [];
  for (const file of files) importers.push(...reverseImporters(db, scope, `code:${file}`, maxDepth));
  const importerPaths = [...new Set(importers.map(row => row.src.replace(/^code:/, '')))];
  const tests = [];
  for (const module of modules) {
    const rows = db.prepare("SELECT src, source_ref FROM code_edges WHERE scope = ? AND dst = ? AND kind = 'tests'").all(scope, module);
    for (const row of rows) tests.push({ path: row.src.replace(/^code:/, ''), sourceRef: row.source_ref, module });
  }
  // A test file commonly imports the changed file directly even when it lives
  // in another module; include those reverse importers as tests too.
  for (const file of files) {
    const rows = db.prepare("SELECT src, source_ref FROM code_edges WHERE scope = ? AND dst = ? AND kind = 'imports'").all(scope, `code:${file}`);
    for (const row of rows) {
      const pathValue = row.src.replace(/^code:/, '');
      if (isTestFile(pathValue) && !tests.some(item => item.path === pathValue)) tests.push({ path: pathValue, sourceRef: row.source_ref, module: '' });
    }
  }
  const staleCache = new Map();
  const stale = [...files].filter(file => staleForPath(db, scope, root, file, staleCache)).length;
  return {
    ok: true, scope, root, ref: String(ref ?? ''),
    targets: targets.map(item => ({
      type: item.type,
      key: item.type === 'module' ? item.row.key : item.type === 'api' ? `${item.row.method} ${item.row.route}` : item.type === 'file' ? item.row.path : (item.row.qualified_name || item.row.name),
      sourceRef: sourceOf(item.row),
    })),
    files: [...files], modules: [...modules],
    importers: importerPaths.sort(),
    importerDepth: importers,
    tests,
    stale, elapsedMs: Date.now() - started,
  };
}

