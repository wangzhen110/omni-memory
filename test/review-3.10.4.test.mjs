import test from 'node:test';
import assert from 'node:assert/strict';

import { boot, fakePost, fakeReq, fakeRes } from './helpers.mjs';

function postRoute(app, routePath, url, body = {}, headers = { 'x-omni-csrf': '1' }) {
  const req = fakePost(body, '127.0.0.1', url);
  req.headers = headers;
  const { res, json, state } = fakeRes();
  return app.route(routePath).handler(req, res).then(() => ({ status: state.statusCode, body: json() }));
}

function rawPost(url, text) {
  const handlers = new Map();
  const req = {
    method: 'POST', url, headers: { host: '127.0.0.1', 'x-omni-csrf': '1' },
    socket: { remoteAddress: '127.0.0.1' },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return req;
    },
  };
  queueMicrotask(() => {
    for (const handler of handlers.get('data') ?? []) handler(Buffer.from(text));
    for (const handler of handlers.get('end') ?? []) handler();
  });
  return req;
}

test('restoring a fact cannot create two active values for a single-valued relation', async () => {
  const app = await boot();
  const oldFact = await app.call('memory_write', {
    kind: 'fact', scope: 'global', subject: 'R1Subject', relation: 'state', object: 'old-value',
  });
  const newFact = await app.call('memory_write', {
    kind: 'fact', scope: 'global', subject: 'R1Subject', relation: 'state', object: 'new-value',
  });
  assert.notEqual(oldFact.value.id, newFact.value.id);

  const forgotten = await app.call('memory_forget', { kind: 'fact', id: oldFact.value.id, scope: 'global' });
  assert.equal(forgotten.value.forgotten, true);

  const restored = await app.call('memory_restore', { kind: 'fact', id: oldFact.value.id, scope: 'global' });
  assert.equal(restored.value.restored, false);
  assert.match(restored.value.reason, /single-valued relation already has an active value/);
  assert.equal(restored.value.activeId, newFact.value.id);
  assert.equal(restored.value.activeObject, 'new-value');

  const { res, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=all&limit=20'), res);
  const active = json().facts.filter(fact => fact.subject === 'r1subject' && fact.valid_to === null);
  assert.equal(active.length, 1);
  assert.equal(active[0].object, 'new-value');
});

test('restoring an old note refuses when the same text is active again', async () => {
  const app = await boot();
  const first = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'DUP-RESTORE-TEXT' });
  await app.call('memory_forget', { kind: 'note', id: first.value.id, scope: 'global' });
  const second = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'DUP-RESTORE-TEXT' });

  const restored = await app.call('memory_restore', { kind: 'note', id: first.value.id, scope: 'global' });
  assert.equal(restored.value.restored, false);
  assert.equal(restored.value.reason, 'active duplicate');
  assert.equal(restored.value.activeId, second.value.id);
});

test('persona rejects empty and invalid bodies without clearing existing values', async () => {
  const app = await boot();
  await app.call('memory_persona', { action: 'set', values: { 偏好: '保留这条' } });

  const empty = await postRoute(app, '/omni-memory/persona', '/omni-memory/persona', {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /non-empty/);

  const invalid = fakeRes();
  await app.route('/omni-memory/persona').handler(rawPost('/omni-memory/persona', '{bad json'), invalid.res);
  assert.equal(invalid.state.statusCode, 400);

  const current = await app.call('memory_persona', { action: 'get' });
  assert.equal(current.value.persona['偏好'], '保留这条');
});

test('persona rejects an oversized value before touching the stored profile', async () => {
  const app = await boot();
  await app.call('memory_persona', { action: 'set', values: { 偏好: '保留这条' } });

  const huge = await postRoute(app, '/omni-memory/persona', '/omni-memory/persona', {
    values: { 偏好: '中'.repeat(3000) },
  });
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /too long/);

  const current = await app.call('memory_persona', { action: 'get' });
  assert.equal(current.value.persona['偏好'], '保留这条');
});

test('persona clears only when action=clear is explicit', async () => {
  const app = await boot();
  await app.call('memory_persona', { action: 'set', values: { 偏好: '保留这条' } });
  const cleared = await postRoute(app, '/omni-memory/persona', '/omni-memory/persona', { action: 'clear' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.persona, {});
});

test('ingest accepts a long Chinese body and rejects one over the byte cap with 413', async () => {
  const app = await boot();
  const text = '中'.repeat(3000);
  const accepted = await postRoute(app, '/omni-memory/ingest', '/omni-memory/ingest', { text, scope: 'global' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.chars, text.length);

  const tooBig = await postRoute(app, '/omni-memory/ingest', '/omni-memory/ingest', {
    text: '中'.repeat(70_000), scope: 'global',
  });
  assert.equal(tooBig.status, 413);
});
