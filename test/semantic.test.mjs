import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot, fakeReq, fakeRes } from './helpers.mjs';

/**
 * A mock OpenAI-compatible embeddings endpoint. It maps text to a concept
 * vector by intent, which lets the test prove that a query sharing NO
 * characters with the stored note can still recall it — the exact capability
 * the hashed backend cannot provide (FR-21).
 */
const CONCEPTS = [
  { keys: ['投影', '顶掉', '界面弄没', '聊天区变空白'], vector: [1, 0, 0, 0] },
  { keys: ['迁移', '升级', '旧库'], vector: [0, 1, 0, 0] },
  { keys: ['无关', '天气'], vector: [0, 0, 1, 0] },
];

function vectorFor(text) {
  for (const concept of CONCEPTS) {
    if (concept.keys.some(key => text.includes(key))) return concept.vector;
  }
  return [0, 0, 0, 1];
}

async function startServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = inputs.map(text => ({ embedding: vectorFor(String(text)) }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/embeddings` };
}

async function withSemantic(fn) {
  const { server, url } = await startServer();
  const previous = {
    url: process.env.OMNI_EMBED_URL,
    model: process.env.OMNI_EMBED_MODEL,
    key: process.env.OMNI_EMBED_KEY,
  };
  process.env.OMNI_EMBED_URL = url;
  process.env.OMNI_EMBED_MODEL = 'mock-embed';
  delete process.env.OMNI_EMBED_KEY;
  try {
    await fn(url);
  } finally {
    for (const [key, value] of Object.entries({
      OMNI_EMBED_URL: previous.url,
      OMNI_EMBED_MODEL: previous.model,
      OMNI_EMBED_KEY: previous.key,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

test('FR-21 a paraphrase with zero shared characters recalls the note', async () => {
  await withSemantic(async () => {
    const app = await boot();
    await app.call('memory_write', {
      kind: 'note',
      text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
      importance: 0.9,
    });

    const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
    assert.equal(hit.value.hits.length, 1, 'semantic route should recall the note');
    const first = hit.value.hits[0];
    assert.ok(first.vectorScore > 0, 'remote embedding route must contribute');
    assert.equal(first.lexicalScore ?? null, null, 'lexical route cannot match this query');
  });
});

test('FR-21 the same query finds nothing on the hashed backend', async () => {
  const previous = process.env.OMNI_EMBED_URL;
  delete process.env.OMNI_EMBED_URL; // fall back to hashed n-grams
  try {
    const app = await boot();
    await app.call('memory_write', {
      kind: 'note',
      text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
      importance: 0.9,
    });
    const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
    assert.equal(hit.value.hits.length, 0, 'hashed backend has no synonym recall');
  } finally {
    if (previous !== undefined) process.env.OMNI_EMBED_URL = previous;
  }
});

test('FR-21 the bundled local model recalls a paraphrase with zero shared characters', async () => {
  const app = await boot({ semantic: true });
  await app.call('memory_write', {
    kind: 'note',
    text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
    importance: 0.9,
  });

  const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
  assert.equal(hit.value.hits.length, 1, 'local semantic route should recall the note');
  const first = hit.value.hits[0];
  assert.ok(first.semanticScore > 0, 'local semantic route must contribute');
  assert.equal(first.vectorScore ?? null, null, 'hashed fallback must not fuse when semantic answered');
  assert.equal(first.lexicalScore ?? null, null, 'lexical route cannot match this query');
});

test('FR-41 the background worker drains more than one semantic batch', async () => {
  const app = await boot({ semantic: true });
  for (let index = 0; index < 12; index += 1) {
    await app.call('memory_write', {
      kind: 'note',
      text: `语义回填测试第 ${index} 条：${index % 2 ? '磁盘满了如何释放系统盘' : '实时投影被顶掉导致聊天区空白'}`,
      importance: 0.8,
    });
  }

  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { res, json } = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
    status = json();
    if (status.semantic.indexed >= 12 && status.semantic.backfillDone) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(status.semantic.indexed >= 12, `worker indexed only ${status.semantic.indexed} rows`);
  assert.equal(status.semantic.backfillDone, true, 'backfill should finish after draining batches');
});

test('FR-41 an upgraded store backfills rows written before the model existed', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-semantic-old-'));
  const old = await boot({ home });
  for (let index = 0; index < 12; index += 1) {
    await old.call('memory_write', {
      kind: 'note',
      text: `升级前写入的第 ${index} 条：${index % 2 ? '磁盘满了如何释放系统盘' : '实时投影被顶掉导致聊天区空白'}`,
      importance: 0.8,
    });
  }

  const app = await boot({ home, semantic: true });
  let status;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { res, json } = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
    status = json();
    if (status.semantic.indexed >= 12 && status.semantic.backfillDone) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(status.semantic.indexed >= 12, `upgraded store indexed only ${status.semantic.indexed} rows`);
  assert.equal(status.semantic.backfillDone, true, 'old rows should backfill without an explicit reindex');
});

test('FR-21 the remote backend still answers when the endpoint is down', async () => {
  const previous = process.env.OMNI_EMBED_URL;
  process.env.OMNI_EMBED_URL = 'http://127.0.0.1:9/v1/embeddings'; // nothing listens
  process.env.OMNI_EMBED_TIMEOUT_MS = '300';
  try {
    const app = await boot();
    await app.call('memory_write', { kind: 'note', text: '远程嵌入不可用时的兜底笔记' });
    const hit = await app.call('memory_search', { query: '远程嵌入不可用' });
    assert.equal(hit.value.hits.length, 1, 'lexical route must still answer');
  } finally {
    delete process.env.OMNI_EMBED_TIMEOUT_MS;
    if (previous === undefined) delete process.env.OMNI_EMBED_URL;
    else process.env.OMNI_EMBED_URL = previous;
  }
});

async function semanticStatus(app) {
  const { res, json } = fakeRes();
  await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
  return json().semantic;
}

test('FR-41 forgetting and amending remove stale semantic rows', async () => {
  const app = await boot({ semantic: true });
  const old = await app.call('memory_write', {
    kind: 'note',
    text: '语义 GC 旧文本：磁盘满了如何释放系统盘',
    importance: 0.8,
  });
  await app.call('memory_search', { query: '磁盘释放' });
  assert.equal((await semanticStatus(app)).indexed, 1, 'one active note should have one semantic row');

  await app.call('memory_forget', { kind: 'note', id: old.value.id });
  assert.equal((await semanticStatus(app)).indexed, 0, 'forget must delete the derived semantic row');

  const live = await app.call('memory_write', {
    kind: 'note',
    text: '语义 GC 修订前：实时投影被顶掉导致聊天区空白',
    importance: 0.8,
  });
  await app.call('memory_search', { query: '投影顶掉' });
  assert.equal((await semanticStatus(app)).indexed, 1, 'live note should have one semantic row');

  await app.call('memory_amend', {
    id: live.value.id,
    text: '语义 GC 修订后：调用 inspectSession 会让聊天区变空白',
    reason: 'semantic GC test',
  });
  await app.call('memory_search', { query: 'inspectSession' });
  const status = await semanticStatus(app);
  assert.equal(status.indexed, 1, 'amend must not leave the superseded row behind');
  assert.equal(status.pending, 0, 'the replacement should be indexed, not just queued');
});

test('FR-41 an amend during the first flush is not swallowed by the old snapshot', async () => {
  const app = await boot({ semantic: true });
  const old = await app.call('memory_write', {
    kind: 'note',
    text: '并发写入旧文本：磁盘满了如何释放系统盘',
    importance: 0.8,
  });
  // The first semantic search loads the model, which gives the amend enough
  // time to enqueue a newer revision while the old snapshot is in flight.
  const inFlight = app.call('memory_search', { query: '触发首次模型加载' });
  await app.call('memory_amend', {
    id: old.value.id,
    text: '调用 inspectSession 会把实时投影顶掉，聊天区变空白',
    reason: 'race test',
  });
  await inFlight;

  const hit = await app.call('memory_search', { query: '那个把界面弄没的坑' });
  assert.ok(hit.value.hits.length >= 1, 'the newer revision must be searchable after the race');
  assert.ok(hit.value.hits[0].semanticScore > 0, 'the hit must come from the semantic route');
});
