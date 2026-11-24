// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * FTS5 is compiled into some Node builds and not others. The product degrades
 * to LIKE recall when it is absent; tests that specifically assert trigram/FTS
 * behaviour must skip instead of failing the whole Linux job.
 */
import { DatabaseSync } from 'node:sqlite';

let cached;

export function supportsFts5() {
  if (cached !== undefined) return cached;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text)");
    cached = true;
  } catch {
    cached = false;
  } finally {
    db.close();
  }
  return cached;
}

export function hasFtsTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
