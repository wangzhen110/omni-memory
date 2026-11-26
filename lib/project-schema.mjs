// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Derived project-code index (schema v20).
 *
 * This is a cache, not a source of truth. It stores locations, signatures and
 * short summaries; never source bodies. Everything here can be dropped and
 * rebuilt from the working tree.
 */
export const PROJECT_INDEX_TABLES = [
  'code_files',
  'code_symbols',
  'code_apis',
  'code_modules',
  'code_edges',
];

export function createProjectIndexSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_files (
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      module_key TEXT NOT NULL,
      lang TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      loc INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL,
      git_commit TEXT,
      PRIMARY KEY (scope, path)
    );
    CREATE INDEX IF NOT EXISTS code_files_scope_module
      ON code_files(scope, module_key, path);
    CREATE INDEX IF NOT EXISTS code_files_scope_lang
      ON code_files(scope, lang);

    CREATE TABLE IF NOT EXISTS code_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      path TEXT NOT NULL,
      module_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      signature TEXT,
      start_line INTEGER NOT NULL DEFAULT 0,
      end_line INTEGER NOT NULL DEFAULT 0,
      exported INTEGER NOT NULL DEFAULT 0,
      doc TEXT,
      source_ref TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(scope, source_ref)
    );
    CREATE INDEX IF NOT EXISTS code_symbols_scope_name
      ON code_symbols(scope, name);
    CREATE INDEX IF NOT EXISTS code_symbols_scope_qname
      ON code_symbols(scope, qualified_name);
    CREATE INDEX IF NOT EXISTS code_symbols_scope_path
      ON code_symbols(scope, path, start_line);
    CREATE INDEX IF NOT EXISTS code_symbols_scope_module
      ON code_symbols(scope, module_key, exported);

    CREATE TABLE IF NOT EXISTS code_apis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      module_key TEXT,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      route TEXT NOT NULL,
      handler TEXT,
      source_path TEXT,
      line INTEGER NOT NULL DEFAULT 0,
      auth TEXT,
      summary TEXT,
      request TEXT,
      response TEXT,
      errors TEXT,
      tags TEXT,
      source_ref TEXT NOT NULL,
      spec_ref TEXT,
      sha256 TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(scope, kind, method, route, source_ref)
    );
    CREATE INDEX IF NOT EXISTS code_apis_scope_method_route
      ON code_apis(scope, method, route);
    CREATE INDEX IF NOT EXISTS code_apis_scope_route
      ON code_apis(scope, route);
    CREATE INDEX IF NOT EXISTS code_apis_scope_path
      ON code_apis(scope, source_path, line);
    CREATE INDEX IF NOT EXISTS code_apis_scope_module
      ON code_apis(scope, module_key);

    CREATE TABLE IF NOT EXISTS code_modules (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      root_path TEXT,
      kind TEXT,
      manifest TEXT,
      description TEXT,
      public_surface TEXT,
      source_ref TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX IF NOT EXISTS code_modules_scope_name
      ON code_modules(scope, name);

    CREATE TABLE IF NOT EXISTS code_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_ref TEXT,
      line INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope, src, dst, kind)
    );
    CREATE INDEX IF NOT EXISTS code_edges_scope_src
      ON code_edges(scope, src, kind);
    CREATE INDEX IF NOT EXISTS code_edges_scope_dst
      ON code_edges(scope, dst, kind);
  `);
  return PROJECT_INDEX_TABLES;
}

export function hasProjectIndexSchema(db) {
  try {
    for (const table of PROJECT_INDEX_TABLES) {
      const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!row) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Drop only this scope's derived rows. Used by --full and by tests. */
export function clearProjectScope(db, scope) {
  for (const table of PROJECT_INDEX_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE scope = ?`).run(scope);
  }
}
