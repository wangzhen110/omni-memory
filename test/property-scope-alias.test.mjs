// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * scope_alias / project-key invariants. The P1 cross-platform case-split fix
 * (3.9.4) and its 16-hop alias resolver are easy to regress: a wrong platform
 * branch merges same-named folders on different drives, and a cyclic alias
 * chain can hang resolution. These properties hold those edges over arbitrary
 * path spellings and hand-built alias graphs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from './helpers.mjs';

const app = await boot();
const {
  projectKeyFromCwd,
  legacyProjectKeyFromCwd,
  migrateScopeAlias,
  scopeHasRows,
} = app.mod;
const RUNS = 80;

const winDrive = fc.constantFrom('C:', 'D:', 'e:');
const posixRoot = fc.constantFrom('/home', '/Users');
const folder = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{2,14}$/);
const pathArb = fc.record({
  root: winDrive, folder,
  sep: fc.constantFrom('\\', '/'),
  trailing: fc.boolean(),
});
const posixPathArb = fc.record({
  root: posixRoot, folder,
  sep: fc.constant('/'),
  trailing: fc.boolean(),
});
const makePath = ({ root: d, folder: f, sep, trailing }) =>
  `${d}${sep}${f}${trailing ? sep : ''}`;

// ---------------------------------------------------------------------------
// S1. On case-insensitive platforms, any casing of the same path maps to one
//     canonical project key; on Linux, different casing maps to different keys.
//     Guards the platform branch in projectKeyFromCwd. Path spellings must match
//     the platform: a synthetic `C:\...` on Linux resolves inside the checkout
//     and would pick up the repo's real `.omni-project` identity instead.
// ---------------------------------------------------------------------------
test('prop: project key is casing-correct per platform', () => {
  fc.assert(
    fc.property(pathArb, (spec) => {
      const p = makePath(spec);
      const lower = p.toLowerCase();
      for (const platform of ['win32', 'darwin']) {
        assert.equal(projectKeyFromCwd(p, platform), projectKeyFromCwd(lower, platform),
          `${platform}: casing must not split a project layer`);
      }
      assert.equal(projectKeyFromCwd(p, 'win32'), projectKeyFromCwd(p.replaceAll('\\', '/'), 'win32'),
        'separator spelling is normalized');
    }),
    { numRuns: RUNS },
  );
  fc.assert(
    fc.property(posixPathArb, (spec) => {
      const p = makePath(spec);
      const lower = p.toLowerCase();
      if (p !== lower) {
        assert.notEqual(projectKeyFromCwd(p, 'linux'), projectKeyFromCwd(lower, 'linux'),
          'linux keeps casing significant');
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// S2. The legacy (pre-3.9.4) key preserves casing, and for an all-lowercase
//     path the legacy key equals the canonical one on every platform. Guards
//     that the migration source is derivable only when a path was recorded.
// ---------------------------------------------------------------------------
test('prop: legacy key preserves casing and collapses for lowercase paths', () => {
  fc.assert(
    fc.property(folder, (f) => {
      const win = process.platform === 'win32';
      const mixed = win ? `C:\\Work\\${f}` : `/home/Work/${f}`;
      const lower = win ? `c:/work/${f.toLowerCase()}` : `/home/work/${f.toLowerCase()}`;
      const platform = win ? 'win32' : 'linux';
      assert.match(legacyProjectKeyFromCwd(mixed), /proj:/u);
      assert.equal(legacyProjectKeyFromCwd(lower), projectKeyFromCwd(lower, platform),
        'lowercase path: legacy == canonical');
      if (f !== f.toLowerCase() && process.platform !== 'linux') {
        assert.notEqual(legacyProjectKeyFromCwd(mixed), projectKeyFromCwd(mixed, platform),
          'cased path: legacy key differs from canonical (migration candidate exists)');
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// S3. migrateScopeAlias is idempotent and lossless: moving a populated source
//     into an empty target empties the source, fills the target, then a repeat
//     is a no-op. Different-basename scopes are never merged by this call.
// ---------------------------------------------------------------------------
test('prop: migrateScopeAlias is idempotent and lossless', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uuid(), async (id) => {
      const from = `proj:alias-src-${id}`;
      const to = `proj:alias-dst-${id}`;
      const scope = from;
      await app.call('memory_write', {
        kind: 'note', text: `alias source note ${id}`, scope,
      });
      const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
      try {
        assert.ok(scopeHasRows(db, from), 'source has rows before migration');
        assert.ok(!scopeHasRows(db, to), 'target is empty before migration');
        const first = migrateScopeAlias(db, from, to, { path: `C:/alias/${id}` });
        assert.equal(first.migrated, true, 'first migration is real');
        assert.ok(!scopeHasRows(db, from), 'source emptied after migration');
        assert.ok(scopeHasRows(db, to), 'target populated after migration');
        const second = migrateScopeAlias(db, from, to, { path: `C:/alias/${id}` });
        assert.equal(second.migrated, false, 'repeat migration is a no-op');
        const alias = db.prepare('SELECT canonical FROM scope_aliases WHERE alias = ?').get(from);
        assert.equal(alias?.canonical, to, 'alias records the canonical target');
      } finally {
        db.close();
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// S4. resolveScopeAlias follows at most 16 hops. A cyclic alias graph must
//     terminate (no infinite loop). Built in an isolated home so the real
//     test store is untouched; migrateScopeAlias resolves both endpoints
//     through the ring before deciding, so a cycle exercises the cap.
// ---------------------------------------------------------------------------
test('prop: cyclic alias graphs terminate without hanging', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 2, max: 24 }), fc.uuid(), async (ring, id) => {
      const scratch = await boot();
      // boot() only sets DSH_HOME; the DB file is created on first store use.
      await scratch.call('memory_write', { kind: 'note', text: `scratch seed ${id}`, scope: `proj:seed-${id}` });
      const db = new DatabaseSync(path.join(scratch.home, 'memory', 'omni.db'));
      try {
        const insert = db.prepare('INSERT OR REPLACE INTO scope_aliases(alias, canonical, created_at) VALUES (?, ?, ?)');
        for (let i = 0; i < ring; i += 1) {
          insert.run(`s-${id}-${i}`, `s-${id}-${(i + 1) % ring}`, 0);
        }
        const source = `s-${id}-0`;
        const target = `s-${id}-1`;
        const started = Date.now();
        let result;
        assert.doesNotThrow(() => { result = scratch.mod.migrateScopeAlias(db, source, target); },
          'migration through a cyclic graph must not throw');
        assert.ok(Date.now() - started < 3000, 'resolution terminates well under 3s (16-hop cap)');
        assert.equal(typeof result.migrated, 'boolean', 'returns a well-formed result');
      } finally {
        db.close();
      }
    }),
    { numRuns: 40 },
  );
});
