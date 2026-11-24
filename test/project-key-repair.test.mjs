// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The startup self-heal is the last line of defence for aliases that were
 * written before their source rows existed. The fix must be idempotent and
 * must leave the alias table intact while moving the rows to the canonical key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

test('startup repair migrates rows behind an already-recorded alias', async () => {
  const app = await boot();
  const legacy = `proj:repair-src-${Date.now()}`;
  const canonical = `proj:repair-dst-${Date.now()}`;
  await app.call('memory_write', {
    kind: 'note',
    text: 'repair source note',
    scope: legacy,
  });

  const dbPath = path.join(app.home, 'memory', 'omni.db');
  let db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO scope_aliases(alias, canonical, created_at) VALUES (?, ?, ?)')
      .run(legacy, canonical, Date.now());
    // Simulate a store written by an older build: the repair marker is absent.
    db.prepare("DELETE FROM meta WHERE key = 'scope_alias_repair_version'").run();
    assert.equal(app.mod.scopeHasRows(db, legacy), true, 'source has rows before repair');
  } finally {
    db.close();
  }

  // Release the seed store so the second module opens the same SQLite file.
  try { app.mod.openStore().db.close(); } catch { /* already closed */ }

  const reopened = await boot({ home: app.home });
  try {
    await reopened.call('memory_search', { query: 'repair source note' });
    db = new DatabaseSync(dbPath);
    try {
      assert.equal(reopened.mod.scopeHasRows(db, legacy), false, 'repair empties the source');
      assert.equal(reopened.mod.scopeHasRows(db, canonical), true, 'repair fills the target');
      const marker = db.prepare("SELECT value FROM meta WHERE key = 'scope_alias_repair_version'").get();
      assert.equal(marker?.value, '1', 'repair marker prevents repeat work');
      const alias = db.prepare('SELECT canonical FROM scope_aliases WHERE alias = ?').get(legacy);
      assert.equal(alias?.canonical, canonical, 'alias is retained after repair');
    } finally {
      db.close();
    }
  } finally {
    try { reopened.mod.openStore().db.close(); } catch { /* already closed */ }
  }
});
