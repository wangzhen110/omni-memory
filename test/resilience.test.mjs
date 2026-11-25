import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('NFR-07 a failing capture never propagates to the caller', async () => {
  const app = await boot();
  const bad = [
    { type: 'user/message' },
    { type: 'user/message', data: { message: null } },
    { type: 'assistant/message', data: { message: { content: 'not-an-array' } } },
    { type: 'assistant/message', data: { message: { content: [{}] } } },
    null,
    undefined,
  ];
  for (const event of bad) {
    assert.doesNotThrow(() => app.fireRaw(event));
  }
});

test('NFR-07 the prompt section returns a string even when nothing is stored', async () => {
  const app = await boot();
  assert.doesNotThrow(() => app.section().text());
  assert.equal(typeof app.section().text(), 'string');
});

test('NFR-07 a search for punctuation-only input does not throw', async () => {
  const app = await boot();
  const hit = await app.call('memory_search', { query: '，。！？' });
  assert.deepEqual(hit.value.hits, []);
});

test('NFR-07 the store survives repeated writes and reads in one session', async () => {
  const app = await boot();
  for (let i = 0; i < 30; i += 1) {
    await app.call('memory_write', { kind: 'note', text: `压力条目 ${i}` });
  }
  const hit = await app.call('memory_search', { query: '压力条目', limit: 30 });
  assert.equal(hit.value.hits.length, 30);
  const profile = await app.call('memory_profile');
  assert.equal(profile.value.stats.notes, 30);
});

test('NFR-07 an unknown tool argument kind is rejected, not silently downgraded', async () => {
  const app = await boot();
  await assert.rejects(
    app.call('memory_write', { kind: 'unknown-kind', text: '兜底为笔记' }),
    /kind must be note, fact, or episode/,
  );
});
