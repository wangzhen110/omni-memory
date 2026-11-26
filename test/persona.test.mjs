import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const post = (url, headers = {}) => ({
  method: 'POST',
  url,
  headers: { host: '127.0.0.1', 'x-omni-csrf': '1', ...headers },
  socket: { remoteAddress: '127.0.0.1' },
});

test('persona can be set and read through the tool', async () => {
  const app = await boot();
  const set = await app.call('memory_persona', {
    action: 'set',
    values: { 称呼: '老王', 性格: '直接、先给结论', 习惯: '每天总结', 偏好: '中文回答' },
  });
  assert.equal(set.value.persona['称呼'], '老王');

  const got = await app.call('memory_persona', { action: 'get' });
  assert.equal(got.value.persona['性格'], '直接、先给结论');

  await app.call('memory_persona', { action: 'set', values: { 称呼: '老王', 性格: '' } });
  const cleared = await app.call('memory_persona', { action: 'get' });
  assert.equal(cleared.value.persona['性格'], undefined, 'empty values clear the field');
});

test('persona rejects oversized values', async () => {
  const app = await boot();
  await assert.rejects(
    app.call('memory_persona', { action: 'set', values: { 性格: 'x'.repeat(1300) } }),
    /too long/,
  );
});

test('persona HTTP route needs POST + CSRF and round-trips the values', async () => {
  const app = await boot();
  const get = fakeRes();
  await app.route('/omni-memory/persona').handler(fakeReq('/omni-memory/persona'), get.res);
  assert.equal(get.state.statusCode, 200);
  assert.deepEqual(get.json().persona, {});

  const missing = fakeRes();
  await app.route('/omni-memory/persona').handler(
    { ...post('/omni-memory/persona?values=%7B%22%E6%80%A7%E6%A0%BC%22%3A%22%E7%9B%B4%E6%8E%A5%22%7D'), headers: {} },
    missing.res,
  );
  assert.equal(missing.state.statusCode, 403);

  const ok = fakeRes();
  await app.route('/omni-memory/persona').handler(
    post('/omni-memory/persona?values=%7B%22%E6%80%A7%E6%A0%BC%22%3A%22%E7%9B%B4%E6%8E%A5%22%7D'),
    ok.res,
  );
  assert.equal(ok.state.statusCode, 200);
  assert.equal(ok.json().persona['性格'], '直接');
});

test('persona is injected into the system prompt section', async () => {
  const app = await boot();
  await app.call('memory_persona', { action: 'set', values: { 称呼: '老王', 偏好: '先给结论' } });
  const text = app.section().text({ scope: { id: 'session-test' } });
  assert.ok(text.includes('用户长期设定'));
  assert.ok(text.includes('老王'));
  assert.ok(text.includes('先给结论'));
});

test('clearing all persona fields removes the block', async () => {
  const app = await boot();
  await app.call('memory_persona', { action: 'set', values: { 称呼: '老王' } });
  await app.call('memory_persona', { action: 'set', values: {} });
  const text = app.section().text({ scope: { id: 'session-test' } });
  assert.equal(text.includes('用户长期设定'), false);
});
