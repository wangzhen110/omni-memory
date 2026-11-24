import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep the threshold low enough for a fast fixture, and disable the live-count
// cache so the assertion follows the rows just inserted.
process.env.OMNI_LARGE_STORE_ROWS = '10000';
process.env.OMNI_ACTIVE_COUNT_TTL_MS = '0';
const { boot } = await import('./helpers.mjs');

test('a churn store is sized by live rows, not the MAX(id) tombstone gap', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note',
    scope: 'global',
    text: '龘 是活行里的单字检索标记',
    importance: 0.9,
  });

  // Simulate a long-lived store after write/forget churn: ids 2..16001 are
  // tombstones, while id 1 is the only live note. MAX(id) is 16001, which is
  // above the 10,000 threshold, but the live count is 1. The old code used the
  // high-water mark, selected the 5,000-row window and lost id 1.
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  try {
    const insert = db.prepare(`
      INSERT INTO notes(ts, scope, text, importance, deleted_at)
      VALUES (?, 'global', ?, 0.1, ?)
    `);
    db.exec('BEGIN');
    for (let i = 0; i < 16_000; i += 1) {
      insert.run(Date.now(), `tombstone ${i}`, Date.now());
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const hits = (await app.call('memory_search', {
    query: '龘',
    scope: 'global',
    limit: 8,
  })).value.hits;
  assert.ok(
    hits.some(hit => hit.kind === 'note' && String(hit.text).includes('龘')),
    'the live note below the tombstone gap was silently dropped',
  );
});
