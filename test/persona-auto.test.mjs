import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

const textOf = chunks => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});

function fakeLlm(reply) {
  return {
    listProviders: () => [{ id: 'test-provider' }],
    listModels: async () => [{ id: 'test-model-small' }],
    stream: () => textOf([
      { type: 'text-delta', text: reply },
      { type: 'finish' },
    ]),
  };
}

test('persona refresh extracts settings from facts and notes with rules', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 称呼 老王', subject: '用户', relation: '称呼', object: '老王',
  });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 喜欢 咖啡', subject: '用户', relation: '喜欢', object: '咖啡', cardinality: 'multi',
  });
  await app.call('memory_write', { kind: 'note', scope: 'global', text: '回答风格：直接，先给结论', importance: 0.9 });

  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  assert.equal(refreshed.value.applied, true);
  assert.equal(refreshed.value.source, 'rules');
  assert.ok(refreshed.value.persona['称呼'].includes('老王'));
  assert.ok(refreshed.value.persona['偏好'].includes('咖啡'));
  assert.ok(refreshed.value.persona['性格'], 'personality extracted from the note');

  const got = await app.call('memory_persona', { action: 'get' });
  assert.equal(got.value.persona['称呼'], refreshed.value.persona['称呼']);
});

test('implementation notes and technical fragments are not treated as persona', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', importance: 0.95,
    text: '习惯/偏好/其他，面板「设定」+ memory_persona 工具 + HTTP GET/POST',
  });
  await app.call('memory_write', { kind: 'note', scope: 'global', importance: 0.9, text: '我的回答风格：先给结论，别客套' });
  await app.call('memory_write', {
    kind: 'fact', scope: 'global', text: '用户 称呼 老王', subject: '用户', relation: '称呼', object: '老王',
  });
  await app.call('memory_write', { kind: 'note', scope: 'global', importance: 0.9, text: '我喜欢简洁的回答' });

  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  const values = Object.values(refreshed.value.persona).join(' | ');
  assert.equal(/面板|HTTP|memory_persona|schema/.test(values), false, 'technical text must not become persona');
  assert.ok(String(refreshed.value.persona['称呼']).includes('老王'));
  assert.ok(String(refreshed.value.persona['性格']).includes('先给结论'));
  assert.ok(String(refreshed.value.persona['偏好']).includes('简洁'));
});

test('recent user utterances are the primary evidence', async () => {
  const app = await boot();
  app.fire('user/message', '叫我老王，我喜欢直接的回答，先给结论', 1, 'session-utterance');
  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  assert.ok(String(refreshed.value.persona['称呼']).includes('老王'));
  assert.ok(String(refreshed.value.persona['偏好']).includes('直接'));
});

test('directive sentences from the user become preferences, technical ones do not', async () => {
  const app = await boot();
  app.fire('user/message', '以后所有项目都用中文回答，不用每次确认', 1, 'session-directive');
  app.fire('user/message', '不要依赖 JSON body，参数放查询串', 2, 'session-directive');
  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  const pref = String(refreshed.value.persona['偏好'] ?? '');
  assert.ok(pref.includes('中文'), 'real preference captured');
  assert.equal(/JSON|body/.test(pref), false, 'technical instruction filtered');
});

test('persona refresh uses the host model only when explicitly requested', async () => {
  const app = await boot({ llm: fakeLlm('{"称呼":"老王","性格":"直接，先给结论","习惯":"每天总结"}') });
  await app.call('memory_write', { kind: 'note', scope: 'global', text: '一些日常记录', importance: 0.5 });
  const refreshed = await app.call('memory_persona', { action: 'refresh', useModel: true });
  assert.equal(refreshed.value.source, 'model');
  assert.equal(refreshed.value.modelUsed, true);
  assert.equal(refreshed.value.persona['性格'], '直接，先给结论');
  assert.equal(refreshed.value.persona['习惯'], '每天总结');
});

test('persona refresh defaults to offline rules and preserves unknown fields', async () => {
  const app = await boot({ llm: fakeLlm('{"称呼":"模型猜测"}') });
  await app.call('memory_persona', { action: 'set', values: { 称呼: '老板', 其他: '手工保留字段' } });
  await app.call('memory_write', { kind: 'note', scope: 'global', text: '我喜欢简洁的回答', importance: 0.9 });
  const refreshed = await app.call('memory_persona', { action: 'refresh' });
  assert.equal(refreshed.value.source, 'rules');
  assert.equal(refreshed.value.modelUsed, false);
  assert.equal(refreshed.value.persona['其他'], '手工保留字段');
  assert.equal(refreshed.value.persona['称呼'], '老板');
  assert.ok(String(refreshed.value.persona['偏好']).includes('简洁'));
});

test('persona refresh route needs POST and CSRF', async () => {
  const app = await boot();
  const get = fakeRes();
  await app.route('/omni-memory/persona/refresh').handler(fakeReq('/omni-memory/persona/refresh'), get.res);
  assert.equal(get.state.statusCode, 405);

  const missing = fakeRes();
  await app.route('/omni-memory/persona/refresh').handler(
    { method: 'POST', url: '/omni-memory/persona/refresh', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    missing.res,
  );
  assert.equal(missing.state.statusCode, 403);

  const ok = fakeRes();
  await app.route('/omni-memory/persona/refresh').handler(
    { method: 'POST', url: '/omni-memory/persona/refresh', headers: { host: '127.0.0.1', 'x-omni-csrf': '1' }, socket: { remoteAddress: '127.0.0.1' } },
    ok.res,
  );
  assert.equal(ok.state.statusCode, 200);
});
