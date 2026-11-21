import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { boot, backupPathOf, fakeReq, fakeRes, fakePost } from './helpers.mjs';

const PROJECT_CWD = 'C:\\tmp\\omni-review-http-project';

function jsonRoute(app, routePath, url, address = '127.0.0.1') {
  const { res, json, state } = fakeRes();
  return app.route(routePath).handler(fakeReq(url, address), res).then(() => ({ status: state.statusCode, body: json() }));
}

function postRoute(app, routePath, url, body = {}, address = '127.0.0.1') {
  const req = fakePost(body, address, url);
  req.headers = { 'x-omni-csrf': '1' };
  const { res, json, state } = fakeRes();
  return app.route(routePath).handler(req, res).then(() => ({ status: state.statusCode, body: json() }));
}

test('HTTP forget and restore respect the project scope instead of global', async () => {
  const app = await boot();
  app.mod.attachSession('session-test', PROJECT_CWD);
  const written = await app.call('memory_write', { kind: 'note', text: 'HTTP 项目层可见性测试' });
  assert.match(written.value.scope, /^proj:/);
  const id = written.value.id;

  const forgotten = await postRoute(
    app,
    '/omni-memory/forget',
    `/omni-memory/forget?kind=note&id=${id}&scope=${encodeURIComponent(written.value.scope)}`,
  );
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.body.forgotten, true);
  assert.equal(forgotten.body.scope, written.value.scope);

  const hidden = await app.call('memory_search', { query: 'HTTP 项目层可见性测试', scope: 'all' });
  assert.equal(hidden.value.hits.some(hit => hit.id === id), false);

  // Restore through the body fallback: the panel's host may pre-consume the stream.
  const restored = await postRoute(app, '/omni-memory/restore', '/omni-memory/restore', {
    kind: 'note', id, scope: written.value.scope,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored, true);

  const visible = await app.call('memory_search', { query: 'HTTP 项目层可见性测试', scope: 'all' });
  assert.equal(visible.value.hits.some(hit => hit.id === id), true);
});

test('a restored note really becomes visible again after being superseded', async () => {
  const app = await boot();
  const oldText = 'RESTORE-OLD-结论-唯一';
  const first = await app.call('memory_write', { kind: 'note', scope: 'global', text: oldText });
  const amended = await app.call('memory_amend', {
    id: first.value.id, scope: 'global', text: 'RESTORE-NEW-结论-唯一',
  });
  const supersededId = amended.value.supersededId ?? first.value.id;
  assert.equal(supersededId, first.value.id);

  const forgotten = await app.call('memory_forget', { kind: 'note', id: supersededId, scope: 'global' });
  assert.equal(forgotten.value.forgotten, true);

  const restored = await app.call('memory_restore', { kind: 'note', id: supersededId, scope: 'global' });
  assert.equal(restored.value.restored, true);

  const hits = await app.call('memory_search', { query: oldText, scope: 'all' });
  assert.equal(hits.value.hits.some(hit => hit.id === supersededId), true);
});

test('import sanitizes verification, importance and dangling lineage', async () => {
  const app = await boot();
  const target = backupPathOf(app, 'review-import-fields.json');
  writeFileSync(target, JSON.stringify({
    format: 'omni-memory-backup',
    version: 1,
    exportedAt: Date.now(),
    schema: 16,
    notes: [{
      id: 1, ts: 1, scope: 'global', text: 'IMPORTED-FIELD-CHECK',
      importance: 999, verification: 'verified', superseded_by: 77777,
      solution_status: 'definitely-verified', evidence: 'evidence survives',
    }],
    facts: [{
      id: 1, subject: 'ImportSubject', relation: 'state', object: 'ImportObject',
      text: 'ImportSubject state ImportObject', valid_from: 1,
      confidence: 999, scope: 'global',
    }],
    chunks: [], edges: [], entities: [], relations: [], entityAliases: [], persona: [], candidates: [],
  }, null, 2));

  const dry = await app.call('memory_import', { path: path.basename(target) });
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.notes, 1);
  assert.equal(dry.value.facts, 1);

  const imported = await app.call('memory_import', { path: path.basename(target), dryRun: false });
  assert.equal(imported.value.dryRun, false);

  const listed = await jsonRoute(app, '/omni-memory/list', '/omni-memory/list?scope=all&audit=1&limit=50');
  assert.equal(listed.status, 200);
  const note = listed.body.notes.find(row => row.text === 'IMPORTED-FIELD-CHECK');
  assert.ok(note, 'imported note is listed');
  assert.equal(note.importance, 1, 'importance is clamped');
  assert.equal(note.verification, null, 'untrusted verification is not imported');
  assert.equal(note.superseded_by, null, 'dangling lineage is not imported');
  assert.equal(note.solution_status, null, 'untrusted solution status is not imported');
  assert.equal(note.evidence, 'evidence survives');

  const fact = listed.body.facts.find(row => row.subject === 'ImportSubject');
  assert.ok(fact, 'imported fact is listed');
  assert.equal(fact.confidence, 1, 'confidence is clamped');
});

test('link_entity rewrites object facts as well as subject facts', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', subject: 'Docker', relation: 'depends_on', object: 'Container',
  });

  const dry = await app.call('memory_link_entity', { alias: 'Container', canonical: 'Docker' });
  assert.equal(dry.value.applied, false);
  assert.ok(dry.value.affectedObjectFacts >= 1);

  const applied = await app.call('memory_link_entity', { alias: 'Container', canonical: 'Docker', apply: true });
  assert.equal(applied.value.applied, true);
  assert.ok(applied.value.affectedObjectFacts >= 1);

  const listed = await jsonRoute(app, '/omni-memory/list', '/omni-memory/list?scope=all&limit=50');
  const fact = listed.body.facts.find(row => row.relation === 'depends_on');
  assert.equal(fact.object, 'docker');
});

test('readJsonBody preserves UTF-8 split across chunks', async () => {
  const app = await boot();
  const payload = Buffer.from(JSON.stringify({ values: { 性格: '直接、先给结论' } }), 'utf8');
  const cut = payload.indexOf(Buffer.from('直')) + 1;
  const handlers = new Map();
  const req = {
    method: 'POST',
    url: '/omni-memory/persona',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-omni-csrf': '1' },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return req;
    },
  };
  queueMicrotask(() => {
    for (const handler of handlers.get('data') ?? []) handler(payload.subarray(0, cut));
    for (const handler of handlers.get('data') ?? []) handler(payload.subarray(cut));
    for (const handler of handlers.get('end') ?? []) handler();
  });
  const { res, json, state } = fakeRes();
  await app.route('/omni-memory/persona').handler(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().persona['性格'], '直接、先给结论');
});
