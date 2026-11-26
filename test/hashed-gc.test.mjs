import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';
import { pruneHashedVectors } from '../lib/store.mjs';

test('hashed-vector sweep deletes orphan rows and keeps the live fallback', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note',
    text: 'Hashed GC 保留活跃向量 中文内容',
  });
  const liveId = Number(written.value.id);
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    const orphanId = liveId + 100_000;
    db.prepare('INSERT OR REPLACE INTO vectors(kind, owner_id, dim, vec) VALUES (?, ?, ?, ?)')
      .run('note', orphanId, 512, new Uint8Array(4096));

    const report = pruneHashedVectors(db);
    assert.equal(report.ok, true);
    assert.ok(report.deleted >= 1, `expected orphan deletion, got ${report.deleted}`);

    const count = id => Number(db.prepare(
      'SELECT COUNT(*) n FROM vectors WHERE kind = ? AND owner_id = ?',
    ).get('note', id).n);
    assert.equal(count(orphanId), 0, 'orphan vector must be gone');
    assert.equal(count(liveId), 1, 'active vector must remain for hashed fallback');
  } finally {
    db.close();
  }
});
