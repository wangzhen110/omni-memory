import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes } from './helpers.mjs';
import { hasFtsTable } from './fts-support.mjs';

/**
 * Subsystem fault injection against a throwaway store.
 *
 * Every case opens its own boot() instance (fresh module cache), damages only
 * that instance's ${home}/memory/omni.db, and closes both its own connections
 * and the store connection before removing the temp directory. The production
 * ~/.dsh/memory/omni.db is never touched: boot() points DSH_HOME at mkdtemp().
 */
async function bootCase(t) {
  const app = await boot();
  const connections = [];

  t.after(() => {
    for (const db of connections.splice(0).reverse()) {
      try { db.close(); } catch { /* already closed */ }
    }
    // helpers.ctx.effect() drops the module's store-close disposer, so close the
    // store explicitly; otherwise Windows keeps omni.db(-wal/-shm) locked and
    // the temp directory cannot be removed.
    try { app.mod.openStore().db.close(); } catch { /* store never opened */ }
    try { rmSync(app.home, { recursive: true, force: true }); } catch { /* already gone */ }
  });

  function openDb() {
    // The file only exists after the first write has run openStore().
    const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
    connections.push(db);
    return db;
  }

  async function writeNote(text) {
    const { value } = await app.call('memory_write', { kind: 'note', text, scope: 'global' });
    return value.id;
  }

  async function getStatus() {
    const res = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res.res);
    return res;
  }

  return { app, openDb, writeNote, getStatus };
}

test('删除 notes_fts 后 memory_search 退化为字面召回，结果合法且其他读路由可用', async t => {
  const { app, openDb, writeNote, getStatus } = await bootCase(t);
  const token = 'faultftsdelta42';
  const noteId = await writeNote(`故障注入笔记 ${token}`);
  const db = openDb();
  if (!hasFtsTable(db, 'notes_fts')) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }

  // index.js: ftsRowIds() wraps the MATCH query in try/catch -> [] (line 2709),
  // and rowsByIds() returns [] for empty ids. The LIKE recent window still
  // answers, so the result is constrained to real base-table rows.
  db.exec('DROP TABLE notes_fts');

  const searched = await app.call('memory_search', { query: token, scope: 'global', limit: 8 });
  assert.ok(Array.isArray(searched.value.hits));
  assert.equal(searched.value.total, searched.value.hits.length);
  assert.ok(searched.value.hits.some(hit => hit.kind === 'note' && hit.id === noteId));
  assert.ok(searched.value.hits.every(hit =>
    Number.isInteger(hit.id) && hit.id > 0 && typeof hit.text === 'string' && hit.text.length > 0));
  assert.ok(searched.value.hits.length <= 8);

  const status = await getStatus();
  assert.equal(status.state.statusCode, 200);
  assert.equal(status.json().ok, true);
  const profile = await app.call('memory_profile', {});
  assert.ok(profile.value.text.includes(token));
});

test('notes_fts 被破坏为普通表后 memory_search 不抛未捕获异常', async t => {
  const { app, openDb, writeNote } = await bootCase(t);
  const token = 'faultftscorrupt77';
  const noteId = await writeNote(`损坏的 FTS ${token}`);
  const db = openDb();
  if (!hasFtsTable(db, 'notes_fts')) {
    t.skip('FTS5 is not compiled into this Node build');
    return;
  }

  db.exec('DROP TABLE notes_fts');
  db.exec('CREATE TABLE notes_fts (text TEXT)');

  const searched = await app.call('memory_search', { query: token, scope: 'global', limit: 8 });
  assert.equal(searched.value.total, searched.value.hits.length);
  assert.ok(searched.value.hits.some(hit => hit.kind === 'note' && hit.id === noteId));
  assert.ok(searched.value.hits.every(hit => Number.isInteger(hit.id) && hit.id > 0));
});

test('删除 bigrams 与 vectors 后 memory_search 退化为纯字面召回且不崩', async t => {
  const { app, openDb, writeNote } = await bootCase(t);
  const token = 'faultbigramvector91';
  const noteId = await writeNote(`双字符集与向量表故障 ${token}`);
  const db = openDb();

  // searchBigrams() and both vector SQL blocks catch SQLITE_ERROR and return []
  // (index.js:2871, 3420, 3432), leaving lexical recall intact.
  db.exec('DROP TABLE bigrams');
  db.exec('DROP TABLE vectors');

  const searched = await app.call('memory_search', { query: token, scope: 'global', limit: 8 });
  assert.equal(searched.value.total, searched.value.hits.length);
  assert.ok(searched.value.hits.some(hit => hit.kind === 'note' && hit.id === noteId));
  assert.ok(searched.value.hits.every(hit => hit.via !== 'vector' && hit.vectorScore == null));

  const httpRes = fakeRes();
  await app.route('/omni-memory/search').handler(
    fakeReq(`/omni-memory/search?q=${token}&scope=global&limit=8`), httpRes.res);
  assert.equal(httpRes.state.statusCode, 200);
  assert.equal(httpRes.json().ok, true);
  assert.ok(Array.isArray(httpRes.json().hits));
});

test('删除 edges 后 /graph 与 /node 仍返回合法图数据，search 的图扩展安全跳过', async t => {
  const { app, openDb, writeNote } = await bootCase(t);
  await app.call('memory_write', { kind: 'fact', subject: 'alpha', relation: 'mentions', object: 'beta', scope: 'global' });
  const noteId = await writeNote('图故障注入 alpha beta');
  const db = openDb();

  // The /graph and /node HTTP routes project facts+notes and never read
  // `edges`; graphExpand() does read edges but wraps that query in try/catch
  // (index.js:3608). Both paths must survive the missing table.
  db.exec('DROP TABLE edges');

  const graph = fakeRes();
  await app.route('/omni-memory/graph').handler(fakeReq('/omni-memory/graph?scope=global'), graph.res);
  assert.equal(graph.state.statusCode, 200);
  const graphBody = graph.json();
  assert.equal(graphBody.ok, true);
  assert.ok(Array.isArray(graphBody.nodes));
  assert.ok(Array.isArray(graphBody.links));
  assert.ok(graphBody.nodes.some(node => node.id === 'e:alpha'));

  const node = fakeRes();
  await app.route('/omni-memory/node').handler(
    fakeReq('/omni-memory/node?node=e%3Aalpha&scope=global'), node.res);
  assert.equal(node.state.statusCode, 200);
  const nodeBody = node.json();
  assert.equal(nodeBody.ok, true);
  assert.equal(nodeBody.node.kind, 'entity');
  assert.ok(nodeBody.node.facts.some(fact => fact.subject === 'alpha' && fact.object === 'beta'));

  const searched = await app.call('memory_search', { query: '图故障注入', scope: 'global', limit: 8 });
  assert.ok(searched.value.hits.some(hit => hit.kind === 'note' && hit.id === noteId));
  assert.ok(searched.value.hits.every(hit => hit.via !== 'graph'));
});

test('第二个连接持有写锁时写入在短 busy_timeout 内受控失败，释放后恢复', async t => {
  const previous = process.env.OMNI_BUSY_TIMEOUT_MS;
  process.env.OMNI_BUSY_TIMEOUT_MS = '50';
  t.after(() => {
    if (previous === undefined) delete process.env.OMNI_BUSY_TIMEOUT_MS;
    else process.env.OMNI_BUSY_TIMEOUT_MS = previous;
  });

  // boot() imports a fresh module instance, so it picks up the short timeout.
  const { app, openDb, writeNote } = await bootCase(t);
  await writeNote('锁竞争种子数据');
  const blocker = openDb();
  blocker.exec('PRAGMA busy_timeout = 50');
  blocker.exec('BEGIN IMMEDIATE');
  blocker.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('fault-injection-lock', '1');

  const started = Date.now();
  await assert.rejects(
    app.call('memory_write', { kind: 'note', text: '锁竞争下的写入', scope: 'global' }),
    error => error instanceof Error && /locked|busy/i.test(error.message));
  const elapsed = Date.now() - started;

  // The failure must be a normal rejected tool call, bounded by the timeout,
  // not an uncaught exception or an unbounded wait.
  assert.ok(elapsed < 3000, `写入应在短超时内失败，实际耗时 ${elapsed}ms`);

  blocker.exec('ROLLBACK');
  const recovered = await app.call('memory_write', {
    kind: 'note', text: '锁释放后的写入', scope: 'global',
  });
  assert.ok(recovered.value.id > 0);
});

test('删除 semantic_vectors 后 /omni-memory/status 仍返回完整状态', async t => {
  const { app, openDb, writeNote, getStatus } = await bootCase(t);
  const token = 'faultsemanticstatus63';
  await writeNote(`语义向量表故障 ${token}`);
  const db = openDb();

  // semanticStatus() counts rows in try/catch and reports indexed: 0 (line 1683).
  db.exec('DROP TABLE semantic_vectors');

  const status = await getStatus();
  assert.equal(status.state.statusCode, 200);
  assert.equal(status.json().ok, true);
  assert.equal(status.json().semantic.indexed, 0);
  assert.ok(status.json().stats.notes >= 1);
  assert.ok(typeof status.json().embedding.kind === 'string');

  const searched = await app.call('memory_search', { query: token, scope: 'global', limit: 8 });
  assert.ok(searched.value.hits.some(hit => hit.kind === 'note'));
});
