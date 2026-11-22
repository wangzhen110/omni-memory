import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, fakeReq, fakePost, fakePostConsumed, fakeRes } from './helpers.mjs';

test('twenty one loopback routes are registered', async () => {
  const app = await boot();
  const paths = app.routes.map(route => route.path).sort();
  assert.deepEqual(paths, [
    '/omni-memory/candidate',
    '/omni-memory/candidates',
    '/omni-memory/consolidate',
    '/omni-memory/dream/proposals',
    '/omni-memory/dream/replace',
    '/omni-memory/dream/rollback',
    '/omni-memory/export',
    '/omni-memory/forget',
    '/omni-memory/graph',
    '/omni-memory/ingest',
    '/omni-memory/list',
    '/omni-memory/node',
    '/omni-memory/openapi.json',
    '/omni-memory/overview',
    '/omni-memory/packet',
    '/omni-memory/persona',
    '/omni-memory/persona/refresh',
    '/omni-memory/restore',
    '/omni-memory/search',
    '/omni-memory/status',
    '/omni-memory/tool',
  ]);
});

test('GET /omni-memory/overview aggregates growth, health and profile signals', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '概览全局笔记', source: 'preference' });
  await app.call('memory_write', { kind: 'note', text: '概览项目笔记', scope: 'proj:overview#abc' });
  await app.call('memory_write', {
    kind: 'fact', text: '概览事实', subject: '全息记忆', relation: '包含', object: '概览',
  });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/overview').handler(
    fakeReq('/omni-memory/overview?range=4w&scope=all'),
    res,
  );
  assert.equal(state.statusCode, 200);
  const body = json();
  assert.equal(body.ok, true);
  assert.ok(body.stats.notes >= 2);
  assert.equal(body.stats.facts, 1);
  assert.equal(body.stats.projects, 1);
  assert.equal(body.stats.transcriptProjects, 0);
  assert.equal(body.stats.usefulRate, null);
  assert.equal(body.series.labels.length, 4);
  assert.equal(body.daily.length, 84);
  assert.equal(body.series.cumulative.at(-1), body.stats.notes + body.stats.facts);
  assert.equal(body.daily.reduce((sum, day) => sum + day.count, 0), body.stats.notes + body.stats.facts);
  assert.ok(body.health.total >= 3);
  assert.ok(body.projects.some(project => project.scope === 'global'));
  assert.ok(body.projects.some(project => project.scope === 'proj:overview#abc' && project.memory === 1));
  assert.ok(body.profile.signals.length >= 1);
  assert.ok(body.activity.length >= 1);
});

test('GET /omni-memory/overview SQL buckets match the legacy row scan', async () => {
  const app = await boot();
  for (let i = 0; i < 10; i += 1) {
    await app.call('memory_write', { kind: 'note', text: `概览分桶笔记 ${i}` });
  }
  for (let i = 0; i < 6; i += 1) {
    await app.call('memory_write', {
      kind: 'fact', text: `概览分桶事实 ${i}`, subject: `分桶主体${i}`, relation: '属于', object: '概览对比',
    });
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const start = new Date(weekStart);
  start.setDate(start.getDate() - 25 * 7);
  const startMs = start.getTime();
  const dayStart = new Date(today);
  dayStart.setDate(dayStart.getDate() - 83);

  const s = app.mod.openStore();
  const noteIds = s.db.prepare('SELECT id FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL ORDER BY id').all().map(row => row.id);
  const noteTimes = [
    startMs - 3 * dayMs,
    startMs + 1000,
    startMs + 2 * weekMs + 3 * dayMs,
    startMs + 5 * weekMs + dayMs,
    startMs + 10 * weekMs + 5 * dayMs,
    startMs + 25 * weekMs + 2 * dayMs,
    startMs + 26 * weekMs + dayMs,
    dayStart.getTime() + dayMs + 1000,
    dayStart.getTime() + 40 * dayMs + 1000,
    dayStart.getTime() + 83 * dayMs + 1000,
  ];
  const updateNote = s.db.prepare('UPDATE notes SET ts = ? WHERE id = ?');
  noteIds.forEach((id, i) => updateNote.run(noteTimes[i], id));

  const factIds = s.db.prepare('SELECT id FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL ORDER BY id').all().map(row => row.id);
  const factTimes = [
    startMs - 10 * dayMs,
    startMs + 1 * weekMs + 6 * dayMs,
    startMs + 3 * weekMs + 4 * dayMs,
    startMs + 8 * weekMs + 2 * dayMs,
    startMs + 20 * weekMs + 5 * dayMs,
    dayStart.getTime() + 84 * dayMs + 1000,
  ];
  const updateFact = s.db.prepare('UPDATE facts SET valid_from = ? WHERE id = ?');
  factIds.forEach((id, i) => updateFact.run(factTimes[i], id));

  const insertChunk = s.db.prepare('INSERT INTO chunks (ts, session_id, role, text, hash, source, importance, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const chunkTimes = [startMs + weekMs + dayMs, startMs + 15 * weekMs + 3 * dayMs, startMs - dayMs];
  chunkTimes.forEach((ts, i) => insertChunk.run(ts, `bucket-${i}`, 'user', `分桶会话 ${i}`, `hash-${i}`, 'test', 0.5, 'global'));

  const legacyBuckets = rows => {
    const values = Array(26).fill(0);
    let base = 0;
    for (const row of rows) {
      const ts = Number(row.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts < startMs) { base += 1; continue; }
      const index = Math.floor((ts - startMs) / weekMs);
      if (index >= 0 && index < 26) values[index] += 1;
    }
    return { values, base };
  };
  const keyOf = d => {
    const date = new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const noteRows = s.db.prepare('SELECT ts FROM notes WHERE deleted_at IS NULL AND superseded_by IS NULL').all();
  const factRows = s.db.prepare('SELECT valid_from AS ts FROM facts WHERE deleted_at IS NULL AND valid_to IS NULL').all();
  const chunkRows = s.db.prepare('SELECT ts FROM chunks WHERE deleted_at IS NULL').all();
  const expectedNotes = legacyBuckets(noteRows);
  const expectedFacts = legacyBuckets(factRows);
  const expectedChunks = legacyBuckets(chunkRows);
  const dailyCounts = new Map();
  for (const row of [...noteRows, ...factRows]) {
    const ts = Number(row.ts);
    if (!Number.isFinite(ts) || ts < dayStart.getTime()) continue;
    const key = keyOf(ts);
    dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1);
  }
  const expectedDaily = Array.from({ length: 84 }, (_, i) => {
    const d = new Date(dayStart);
    d.setDate(d.getDate() + i);
    const date = keyOf(d);
    return { date, count: dailyCounts.get(date) ?? 0 };
  });
  let cumulative = expectedNotes.base + expectedFacts.base;
  const expectedCumulative = expectedNotes.values.map((n, i) => {
    cumulative += n + expectedFacts.values[i];
    return cumulative;
  });

  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/overview').handler(
    fakeReq('/omni-memory/overview?range=26w&scope=all'),
    res,
  );
  assert.equal(state.statusCode, 200);
  const body = json();
  assert.deepEqual(body.series.notes, expectedNotes.values);
  assert.deepEqual(body.series.facts, expectedFacts.values);
  assert.deepEqual(body.series.chunks, expectedChunks.values);
  assert.equal(body.series.base, expectedNotes.base + expectedFacts.base);
  assert.deepEqual(body.series.cumulative, expectedCumulative);
  assert.deepEqual(body.daily, expectedDaily);
});

test('GET /omni-memory/list returns stats and rows', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '列表接口测试' });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=10'), res);
  assert.equal(state.statusCode, 200);
  const body = json();
  assert.equal(body.ok, true);
  assert.equal(body.stats.notes, 1);
  assert.equal(body.notes.length, 1);
  assert.match(body.notes[0].text, /列表接口测试/);
});

test('non-loopback callers are rejected with 403', async () => {
  const app = await boot();
  for (const path of ['/omni-memory/list', '/omni-memory/search?q=x', '/omni-memory/forget?kind=note&id=1']) {
    const { res, state } = fakeRes();
    await app.route(path.split('?')[0]).handler(fakeReq(path, '10.1.2.3'), res);
    assert.equal(state.statusCode, 403);
  }
});

test('GET /omni-memory/node returns a note body', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '点星弹卡测试' });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/node').handler(fakeReq(`/omni-memory/node?node=n:${written.value.id}`), res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().node.text, '点星弹卡测试');
});

test('GET /omni-memory/node explains an entity through its facts', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', text: '记忆插件 包含 星图', subject: '记忆插件', relation: '包含', object: '星图',
  });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/node').handler(
    fakeReq(`/omni-memory/node?node=e:${encodeURIComponent('记忆插件')}`),
    res,
  );
  assert.equal(state.statusCode, 200);
  assert.equal(json().node.kind, 'entity');
  assert.ok(json().node.facts.length >= 1);
});

test('GET /omni-memory/node rejects an unknown node', async () => {
  const app = await boot();
  const { res, state } = fakeRes();
  await app.route('/omni-memory/node').handler(fakeReq('/omni-memory/node?node=n:999999'), res);
  assert.equal(state.statusCode, 404);
});

test('GET /omni-memory/list lists workspaces that have no memories yet', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const home = mkdtempSync(path.join(tmpdir(), 'omni-ws-'));
  mkdirSync(path.join(home, 'sessions', '--C-Users-Test-~9879~76EE-memory-demo--'), { recursive: true });
  const app = await boot({ home });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list'), res);
  assert.equal(state.statusCode, 200);
  const entry = json().projects.find(item => String(item.label ?? '').includes('memory-demo'));
  assert.ok(entry, 'workspace should be listed even without rows');
  assert.equal(entry.empty, true);
  assert.equal(entry.notes, 0);
});

test('GET /omni-memory/list keeps real layers ahead of empty ones', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const home = mkdtempSync(path.join(tmpdir(), 'omni-ws-order-'));
  mkdirSync(path.join(home, 'sessions', '--C-Users-Test-~9879~76EE-empty-slot--'), { recursive: true });
  const app = await boot({ home });
  await app.call('memory_write', { kind: 'note', text: '带数据的项目', scope: 'proj:with-data#abc123' });
  const { res, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list'), res);
  const body = json();
  assert.ok(body.projectTotal >= 2);
  assert.equal(body.projects[0].scope, 'proj:with-data#abc123');
  assert.equal(body.projects[0].empty, undefined);
});

test('GET /omni-memory/search returns ranked hits', async () => {  const app = await boot();
  await app.call('memory_write', { kind: 'note', text: '搜索接口能命中这句话' });
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/search').handler(fakeReq('/omni-memory/search?q=' + encodeURIComponent('命中这句话')), res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().hits.length, 1);
});

test('D-04 POST forget works when the host already consumed the request body', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '宿主已读空 body 的场景' });
  const { res, state, json } = fakeRes();
  const req = fakePostConsumed(`/omni-memory/forget?kind=note&id=${written.value.id}`);
  req.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  await app.route('/omni-memory/forget').handler(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().forgotten, true);
});

test('D-04 POST /omni-memory/forget tombstones the row', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '接口遗忘测试' });
  const { res, state, json } = fakeRes();
  const req = fakePost({ kind: 'note', id: written.value.id }, '127.0.0.1', `/omni-memory/forget?kind=note&id=${written.value.id}`);
  req.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  await app.route('/omni-memory/forget').handler(req, res);
  assert.equal(state.statusCode, 200);
  assert.equal(json().forgotten, true);
  const hit = await app.call('memory_search', { query: '接口遗忘测试' });
  assert.equal(hit.value.hits.length, 0);
});

test('D-04 GET forget is rejected instead of mutating', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '兼容路径' });
  const { res, state } = fakeRes();
  await app.route('/omni-memory/forget').handler(fakeReq(`/omni-memory/forget?kind=note&id=${written.value.id}`), res);
  assert.equal(state.statusCode, 405);
  const hit = await app.call('memory_search', { query: '兼容路径' });
  assert.equal(hit.value.hits.length, 1, 'GET must not tombstone the row');
});

test('D-04 POST forget without id returns 400', async () => {
  const app = await boot();
  const { res, state } = fakeRes();
  const req = fakePost({ kind: 'note' });
  req.headers = { host: '127.0.0.1', 'x-omni-csrf': '1' };
  await app.route('/omni-memory/forget').handler(req, res);
  assert.equal(state.statusCode, 400);
});

test('D-04 POST forget rejects a non-loopback caller before touching data', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '远程遗忘尝试' });
  const { res, state } = fakeRes();
  await app.route('/omni-memory/forget').handler(
    fakePost({ kind: 'note', id: written.value.id }, '192.168.1.9'),
    res,
  );
  assert.equal(state.statusCode, 403);
  const hit = await app.call('memory_search', { query: '远程遗忘尝试' });
  assert.equal(hit.value.hits.length, 1);
});

test('GET /omni-memory/search without a query returns an empty list', async () => {
  const app = await boot();
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/search').handler(fakeReq('/omni-memory/search'), res);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(json().hits, []);
});
