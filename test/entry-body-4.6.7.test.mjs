// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * P0-1: the request body security boundary (index.js readJsonBody).
 *
 * The coverage review found the whole strict matrix untested: oversize (413),
 * invalid JSON, non-object payloads, empty bodies and unreadable streams. A
 * lenient default made a silent {} indistinguishable from a real body, so the
 * strict paths have to be pinned by error code *and* status, not just by
 * "it rejected".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'omni-body-467-'));
process.env.OMNI_HOME = home;
process.env.DSH_HOME = home;
process.env.OMNI_DISABLE_SEMANTIC = '1';

const { readJsonBody } = await import('../index.js');

/** A minimal readable request: emit data/end, expose resume(). */
function fakeReq(chunks, { complete = false, error = null, noEmiter = false } = {}) {
  if (noEmiter) return { complete };
  const req = new EventEmitter();
  req.complete = complete;
  req.readable = true;
  req.resumed = 0;
  req.resume = () => { req.resumed += 1; };
  setImmediate(() => {
    if (error) {
      req.emit('error', error);
      return;
    }
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

async function rejectsWith(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    assert.equal(error.status, status, `expected status ${status}, got ${error.status}`);
    return true;
  });
}

test('strict: unreadable or already-consumed request fails closed', async () => {
  await rejectsWith(
    readJsonBody({}, 8192, { strict: true, allowMissing: false }),
    'body_unavailable',
    400,
  );
  await rejectsWith(
    readJsonBody(fakeReq([Buffer.from('{"a":1}')], { complete: true }), 8192, { strict: true, allowMissing: false }),
    'body_unavailable',
    400,
  );
});

test('strict: allowMissing still tolerates a request with no readable body', async () => {
  assert.deepEqual(await readJsonBody({}, 8192, { strict: true }), {});
});

test('lenient default: every failure degrades to an empty object', async () => {
  assert.deepEqual(await readJsonBody({}), {});
  assert.deepEqual(await readJsonBody(fakeReq([])), {});
  assert.deepEqual(await readJsonBody(fakeReq([Buffer.from('not json')])), {});
  assert.deepEqual(await readJsonBody(fakeReq([Buffer.from('[1,2]')])), {});
  assert.deepEqual(await readJsonBody(fakeReq([Buffer.from('x'.repeat(40))], {}), 8), {});
});

test('strict: empty body is body_empty / 400', async () => {
  await rejectsWith(readJsonBody(fakeReq([]), 8192, { strict: true }), 'body_empty', 400);
});

test('strict: invalid JSON is body_invalid_json / 400', async () => {
  await rejectsWith(
    readJsonBody(fakeReq([Buffer.from('{"a":')]), 8192, { strict: true }),
    'body_invalid_json',
    400,
  );
});

test('strict: non-object payloads are body_invalid_object / 400', async () => {
  for (const payload of ['[1,2]', 'null', '"text"', '42', 'true']) {
    await rejectsWith(
      readJsonBody(fakeReq([Buffer.from(payload)]), 8192, { strict: true }),
      'body_invalid_object',
      400,
    );
  }
});

test('strict: oversize body is body_too_large / 413 and drains the stream', async () => {
  const req = fakeReq([Buffer.from('{"abc":'), Buffer.from('1234567890}')]);
  await rejectsWith(readJsonBody(req, 10, { strict: true }), 'body_too_large', 413);
  assert.equal(req.resumed, 1, 'oversize must call resume() once to drain');
});

test('strict: a stream error is body_unavailable / 400', async () => {
  await rejectsWith(
    readJsonBody(fakeReq([], { error: new Error('socket hang up') }), 8192, { strict: true }),
    'body_unavailable',
    400,
  );
});

test('strict: valid object resolves as-is, string chunks are buffered too', async () => {
  const body = await readJsonBody(fakeReq([Buffer.from('{"a":'), '1}']), 8192, { strict: true });
  assert.deepEqual(body, { a: 1 });
});

test('strict: a settled request ignores trailing data and errors', async () => {
  const req = new EventEmitter();
  req.complete = false;
  req.readable = true;
  req.resume = () => {};
  const promise = readJsonBody(req, 8192, { strict: true });
  req.emit('data', Buffer.from('{"a":1}'));
  req.emit('end');
  req.emit('data', Buffer.from('{"a":2}'));
  req.emit('error', new Error('late error'));
  assert.deepEqual(await promise, { a: 1 }, 'first body wins; later frames cannot rewrite it');
});
