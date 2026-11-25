import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

function count(db, sql, ...params) {
  return Number(db.prepare(sql).get(...params).n);
}

test('amending a note removes the old note from every derived index', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note',
    text: 'DerivedGC 旧的孤立索引 中文内容',
  });
  const oldId = Number(written.value.id);
  await app.call('memory_amend', {
    id: oldId,
    scope: 'all',
    text: 'DerivedGC 新版本 中文内容',
  });

  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  assert.equal(count(db, 'SELECT COUNT(*) n FROM bigrams WHERE layer = ? AND owner_id = ?', 'note', oldId), 0);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM vectors WHERE kind = ? AND owner_id = ?', 'note', oldId), 0);
  const hasFts = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts'").get();
  if (hasFts) {
    const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'").get()?.sql ?? '';
    if (/content\s*=\s*'notes'/i.test(ftsSql)) {
      // External-content FTS still exposes the source row through the content
      // table, so counting rowid is meaningless. The real invariant is that the
      // old text no longer maps to the old id in the search index.
      const hits = db.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').all('"DerivedGC 旧的孤立索引"');
      assert.equal(hits.some(row => Number(row.rowid) === oldId), false);
    } else {
      assert.equal(count(db, 'SELECT COUNT(*) n FROM notes_fts WHERE rowid = ?', oldId), 0);
    }
  }
  db.close();
});
