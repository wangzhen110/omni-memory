// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Project-key convergence regressions:
 *  - a literal legacy key can be migrated even when an alias already exists;
 *  - attaching a cased cwd merges the old key instead of returning it;
 *  - /packet?cwd= resolves through the alias table.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

test('literal migration moves rows behind an existing alias', async () => {
  const app = await boot();
  const legacy = `proj:literal-src-${Date.now()}`;
  const canonical = `proj:literal-dst-${Date.now()}`;
  await app.call('memory_write', { kind: 'note', text: `literal source ${legacy}`, scope: legacy });
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    assert.equal(app.mod.scopeHasRows(db, legacy), true, 'source has a row before migration');
    const result = app.mod.migrateScopeAlias(db, legacy, canonical, { literal: true });
    assert.equal(result.migrated, true, 'literal migration must not resolve the source first');
    assert.equal(app.mod.scopeHasRows(db, legacy), false, 'source is empty after migration');
    assert.equal(app.mod.scopeHasRows(db, canonical), true, 'target owns the row');
    const alias = db.prepare('SELECT canonical FROM scope_aliases WHERE alias = ?').get(legacy);
    assert.equal(alias?.canonical, canonical, 'alias points at the literal target');
  } finally {
    db.close();
  }
});

test('attachSession follows an existing alias instead of returning the legacy key', async (t) => {
  if (!CASE_INSENSITIVE) {
    t.skip('case-insensitive path keys only split on Windows/macOS');
    return;
  }
  const app = await boot();
  const cwd = path.join(app.home, 'CaseProject');
  const legacy = app.mod.legacyProjectKeyFromCwd(cwd);
  const canonical = app.mod.projectKeyFromCwd(cwd);
  assert.notEqual(legacy, canonical, 'test path must produce a cased legacy key');
  await app.call('memory_write', { kind: 'note', text: 'legacy cased note', scope: legacy });

  const attached = app.mod.attachSession('case-session', cwd);
  assert.equal(attached, canonical, 'attachSession returns the canonical project');
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    assert.equal(app.mod.scopeHasRows(db, legacy), false, 'legacy rows migrated on attach');
    assert.equal(app.mod.scopeHasRows(db, canonical), true, 'canonical owns the row');
  } finally {
    db.close();
  }

  const route = app.route('/omni-memory/packet');
  const request = fakeReq(`/omni-memory/packet?cwd=${encodeURIComponent(cwd)}&q=legacy`);
  const response = fakeRes();
  await route.handler(request, response.res);
  assert.equal(response.json().scope, canonical, '/packet cwd resolves through alias');
});

test('literal migration is a no-op when source already equals target', async () => {
  const app = await boot();
  const scope = `proj:literal-same-${Date.now()}`;
  await app.call('memory_write', { kind: 'note', text: 'same scope note', scope });
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    const result = app.mod.migrateScopeAlias(db, scope, scope, { literal: true });
    assert.equal(result.migrated, false, 'same source and target is a no-op');
  } finally {
    db.close();
  }
});
