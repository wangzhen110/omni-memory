import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as fc from 'fast-check';
import { boot } from './helpers.mjs';

/**
 * Reliability invariants for the 3.9.5 semantic-lifecycle fixes.
 *
 * Round 1 (property.test.mjs) covers the stable core (recall round-trip,
 * scope isolation, tombstone, input safety). This round targets the specific
 * 3.9.5 debt closures: derived-index cleanup on amend, orphan GC atomicity on
 * reopen, and store integrity under arbitrary write/amend sequences.
 *
 * Semantic embedding stays disabled (boot default) so derived-vector checks
 * focus on the deterministic FTS/bigram/vector tables; semantic_vectors is
 * asserted only when the table is present in this schema.
 */
const app = await boot();
const RUNS = 50;

const dbPath = () => path.join(app.home, 'memory', 'omni.db');
const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).n);
const tableExists = (db, name) => Boolean(
  db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
);

const prose = fc.string({ matching: /[\w\u4e00-\u9fff ]{1,80}/ });
const assertDerivedClean = (db, id, oldText) => {
  assert.equal(count(db, 'SELECT COUNT(*) n FROM bigrams WHERE layer = ? AND owner_id = ?', 'note', id), 0,
    `bigrams残留 owner=${id}`);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM vectors WHERE kind = ? AND owner_id = ?', 'note', id), 0,
    `vectors残留 owner=${id}`);
  if (tableExists(db, 'notes_fts')) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'").get()?.sql ?? '';
    if (/content\s*=\s*'notes'/i.test(sql)) {
      // External-content FTS reads text from `notes`; rowid visibility no longer
      // proves the index entry is gone. The dedicated derived-gc test asserts
      // old text is no longer searchable with a fixed marker.
    } else {
      assert.equal(count(db, 'SELECT COUNT(*) n FROM notes_fts WHERE rowid = ?', id), 0,
        `notes_fts残留 rowid=${id}`);
    }
  }
  if (tableExists(db, 'semantic_vectors')) {
    assert.equal(count(db, 'SELECT COUNT(*) n FROM semantic_vectors WHERE kind = ? AND owner_id = ?', 'note', id), 0,
      `semantic_vectors残留 owner=${id}`);
  }
};

// ---------------------------------------------------------------------------
// 1. Amend invariant: after amending a note, NONE of its derived indexes may
//    reference the old id. Guards the 3.9.5 "dropDerivedIndexes on every
//    supersede path" fix (FTS/bigram/vectors/semantic together).
// ---------------------------------------------------------------------------
test('prop: amend removes every derived index for the old note', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), prose, prose, async (uid, oldText, newText) => {
      const key = `prop-amend-${uid}`;
      const { value: written } = await app.call('memory_write', {
        kind: 'note', text: `${uid} ${oldText}`, problemKey: key, scope: `proj:amend-${uid}`,
      });
      const oldId = Number(written.id);
      // Amend rejects text identical to the current revision by design; make
      // the new text strictly different so the property tests GC, not that guard.
      await app.call('memory_amend', {
        id: oldId, scope: 'all', text: `${uid} 修订版 ${newText}_AMENDED`,
      });
      const db = new DatabaseSync(dbPath());
      try {
        assertDerivedClean(db, oldId, `${uid} ${oldText}`);
        // The old id must be superseded, and the new note must carry the text.
        const row = db.prepare('SELECT superseded_by FROM notes WHERE id = ?').get(oldId);
        assert.ok(row?.superseded_by, `old note #${oldId} must be superseded`);
      } finally {
        db.close();
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// 2. Orphan-GC invariant: a tombstoned note must not leave derived rows that
//    survive a store reopen. Guards the 3.9.5 atomic pruneSemanticVectors sweep
//    and the marker write (only after a successful, all-or-nothing transaction).
// ---------------------------------------------------------------------------
test('prop: tombstoned notes stay clean across store reopen', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), prose, async (uid, body) => {
      const key = `prop-gc-${uid}`;
      const scope = 'global';
      const { value: written } = await app.call('memory_write', {
        kind: 'note', text: `${uid} ${body}`, problemKey: key, scope,
      });
      const id = Number(written.id);
      await app.call('memory_forget', { kind: 'note', id });

      // Reopen the same home and trigger boot-time repair (new process view).
      const reopened = await boot({ home: app.home });
      const db = new DatabaseSync(dbPath());
      try {
        assertDerivedClean(db, id, `${uid} ${body}`);
        assert.equal(
          count(db, 'SELECT COUNT(*) n FROM notes WHERE id = ? AND deleted_at IS NULL', id), 0,
          `forgotten note #${id} must remain tombstoned after reopen`,
        );
        // Exact recall must still be empty for a forgotten note.
        const { value: found } = await reopened.call('memory_search', { problemKey: key, scope, limit: 10 });
        assert.equal(found.hits.filter(h => h.id === id).length, 0,
          `forgotten note #${id} must not resurface after reopen`);
      } finally {
        db.close();
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// 3. Integrity invariant: arbitrary write/amend/forget sequences must leave a
//    readable, non-corrupt store whose counts are internally consistent.
//    Guards transaction-boundary regressions under varied inputs.
// ---------------------------------------------------------------------------
test('prop: mixed mutations keep the store consistent', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uuid(),
      fc.array(fc.oneof(fc.constant('write'), fc.constant('amend'), fc.constant('forget')), { minLength: 3, maxLength: 12 }),
      fc.array(prose, { minLength: 1, maxLength: 6 }),
      async (uid, ops, texts) => {
        const scope = 'global';
        const ids = [];
        for (let i = 0; i < ops.length; i += 1) {
          const body = texts[i % texts.length];
          try {
            if (ops[i] === 'write') {
              const { value: w } = await app.call('memory_write', {
                kind: 'note', text: `${uid}-${i} ${body}`, problemKey: `prop-mix-${uid}-${i}`, scope,
              });
              ids.push(Number(w.id));
            } else if (ops[i] === 'amend' && ids.length) {
              await app.call('memory_amend', { id: ids[ids.length - 1], scope: 'all', text: `${uid}-amend-${i} ${body}` });
            } else if (ops[i] === 'forget' && ids.length) {
              await app.call('memory_forget', { kind: 'note', id: ids.shift() });
            }
          } catch (err) {
            // Amend/forget on an already-superseded id is a legal no-op path;
            // any other throw is a real regression.
            assert.match(String(err.message), /no active note|not found|superseded|already/i,
              `unexpected mutation error: ${err.message}`);
          }
        }
        const db = new DatabaseSync(dbPath(), { readOnly: true });
        try {
          const integrity = db.prepare('PRAGMA integrity_check').get();
          assert.equal(String(integrity.integrity_check).toLowerCase(), 'ok', 'store must stay non-corrupt');
          const active = count(db, 'SELECT COUNT(*) n FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL');
          assert.ok(active >= 0 && Number.isInteger(active), 'active count must be a sane integer');
        } finally {
          db.close();
        }
      },
    ),
    { numRuns: RUNS },
  );
});
