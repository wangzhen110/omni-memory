// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
/**
 * Base schema and FTS bootstrap.
 *
 * Kept separate from openStore so the store lifecycle reads as policy
 * (pragmas → lease → migrate → backfill) instead of a 90-line DDL blob.
 */

/** Create the tables every store needs before migrations run. */
export function createBaseSchema(db) {
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
}

/**
 * Trigram tokenisation is what makes CJK substring recall work; fall back to
 * the default tokenizer when the bundled SQLite lacks it.
 */
export function createFtsTables(db) {
  const createFts = table => {
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
  return {
    chunksMode,
    notesMode,
    factsMode,
    ftsMode: chunksMode ?? notesMode ?? factsMode ?? 'like',
  };
}
