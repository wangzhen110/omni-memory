import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes, projectCwd } from './helpers.mjs';

/** Open the plugin database from the test's throwaway home. */
function openDb(home) {
  const file = path.join(home, 'memory', 'omni.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

/** Request stub with headers, used by the CSRF/scope routes. */
function reqOf(method, url, headers = {}, address = '127.0.0.1') {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:7788', ...headers },
    socket: { remoteAddress: address },
  };
}

test('superseded notes leave search and the profile immediately', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: 'Omega 旧结论应当退出活跃记忆' });
  const db = openDb(app.home);
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(99999, written.value.id);
  db.close();

  const search = await app.call('memory_search', { query: 'Omega 旧结论' });
  assert.equal(search.value.hits.filter(hit => hit.kind === 'note').length, 0);

  const profile = await app.call('memory_profile');
  assert.ok(!profile.text.includes('Omega 旧结论'));
});

test('expired facts leave search and keep their validity span', async () => {
  const app = await boot();
  const old = await app.call('memory_write', {
    kind: 'fact', text: '部署方式 方案 Docker', subject: '部署方式', relation: '方案', object: 'Docker',
  });
  const fresh = await app.call('memory_write', {
    kind: 'fact', text: '部署方式 方案 裸机', subject: '部署方式', relation: '方案', object: '裸机',
  });
  assert.notEqual(old.value.id, fresh.value.id);

  const db = openDb(app.home);
  const rows = db.prepare('SELECT id, valid_to FROM facts WHERE subject = ? ORDER BY id').all('部署方式');
  db.close();
  assert.equal(rows.length, 2);
  assert.ok(Number(rows[0].valid_to) > 0, 'old fact must be invalidated');
  assert.equal(rows[1].valid_to, null, 'new fact stays active');

  const search = await app.call('memory_search', { query: 'Docker' });
  const factHits = search.value.hits.filter(hit => hit.kind === 'fact');
  assert.equal(factHits.filter(hit => hit.id === old.value.id).length, 0);

  const timeline = await app.call('memory_timeline', { entity: '部署方式' });
  assert.match(timeline.text, /Docker/);
  assert.match(timeline.text, /裸机/);
});

test('a project fact never invalidates a global fact', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'fact', scope: 'global',
    text: '共享实体 状态 全局旧值', subject: '共享实体', relation: '状态', object: '全局旧值',
  });
  const project = await app.call('memory_write', {
    kind: 'fact', scope: 'proj:demo#abc123',
    text: '共享实体 状态 项目新值', subject: '共享实体', relation: '状态', object: '项目新值',
  });
  assert.equal(project.value.scope, 'proj:demo#abc123');

  const db = openDb(app.home);
  const rows = db.prepare('SELECT scope, object, valid_to FROM facts WHERE subject = ? ORDER BY id').all('共享实体');
  db.close();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].valid_to, null, 'global fact must stay active');
  assert.equal(rows[1].valid_to, null, 'project fact must stay active');
});

test('bare HTTP search returns the global layer only', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'proj:alpha#deadbe', text: 'AlphaOnly 项目秘密结论',
  });

  const bare = fakeRes();
  await app.route('/omni-memory/search').handler(fakeReq('/omni-memory/search?q=AlphaOnly'), bare.res);
  assert.equal(bare.json().hits.length, 0);

  const scoped = fakeRes();
  await app.route('/omni-memory/search').handler(
    fakeReq('/omni-memory/search?q=AlphaOnly&scope=proj%3Aalpha%23deadbe'), scoped.res,
  );
  assert.equal(scoped.json().hits.length, 1);

  const all = fakeRes();
  await app.route('/omni-memory/search').handler(
    fakeReq('/omni-memory/search?q=AlphaOnly&scope=all'), all.res,
  );
  assert.equal(all.json().hits.length, 1);
});

test('scope=all is rejected for writes', async () => {
  const app = await boot();
  await assert.rejects(
    () => app.call('memory_write', { kind: 'note', scope: 'all', text: '不应落成孤儿' }),
    /read-only/,
  );
});

test('tool writes fall back to global without context and use the caller project with context', async () => {
  const app = await boot();
  const cwd = projectCwd('demo-project');

  // No context: fail closed to global instead of the last assembly.
  const tool = app.tools.get('memory_write');
  const orphan = await tool.execute({ kind: 'note', text: 'no context write' }, {});
  const db = openDb(app.home);
  const orphanScope = db.prepare('SELECT scope FROM notes WHERE id = ?').get(Number(orphan.id)).scope;
  db.close();
  assert.equal(orphanScope, 'global');

  // Captured workspace + agent context: the note belongs to that project.
  app.fireWithCwd(cwd, 'user/message', '开始工作', 1, 'session-alpha');
  app.fireInbox('开始工作', 'session-alpha');
  const scoped = await app.call('memory_write', { kind: 'note', text: 'context write' });
  assert.ok(String(scoped.value.scope).startsWith('proj:demo-project#'), scoped.value.scope);
});

test('forget is POST-only and requires the CSRF header', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '要被遗忘的笔记' });

  const get = fakeRes();
  await app.route('/omni-memory/forget').handler(
    reqOf('GET', `/omni-memory/forget?kind=note&id=${written.value.id}`), get.res,
  );
  assert.equal(get.state.statusCode, 405);

  const missing = fakeRes();
  await app.route('/omni-memory/forget').handler(
    reqOf('POST', `/omni-memory/forget?kind=note&id=${written.value.id}`), missing.res,
  );
  assert.equal(missing.state.statusCode, 403);

  const crossSite = fakeRes();
  await app.route('/omni-memory/forget').handler(
    reqOf('POST', `/omni-memory/forget?kind=note&id=${written.value.id}`, {
      origin: 'https://evil.example', host: '127.0.0.1:63027', 'x-omni-csrf': '1',
    }), crossSite.res,
  );
  assert.equal(crossSite.state.statusCode, 403);

  const ok = fakeRes();
  await app.route('/omni-memory/forget').handler(
    reqOf('POST', `/omni-memory/forget?kind=note&id=${written.value.id}`, {
      origin: 'http://127.0.0.1:63027', host: '127.0.0.1:63027', 'x-omni-csrf': '1',
    }), ok.res,
  );
  assert.equal(ok.state.statusCode, 200);
  assert.equal(ok.json().forgotten, true);
});

test('a tombstoned transcript can be captured again', async () => {
  const app = await boot();
  const text = '这一段转录会被压缩墓碑化，然后再出现一次';
  app.fire('user/message', text, 1, 'session-tomb');
  let db = openDb(app.home);
  const first = db.prepare('SELECT id FROM chunks WHERE text = ? AND deleted_at IS NULL').get(text);
  db.close();
  assert.ok(first);

  await app.call('memory_forget', { kind: 'chunk', id: first.id });
  app.fire('user/message', text, 2, 'session-tomb');

  db = openDb(app.home);
  const rows = db.prepare('SELECT id, deleted_at FROM chunks WHERE text = ? ORDER BY id').all(text);
  db.close();
  assert.equal(rows.length, 2, 're-capture must insert a fresh row');
  const active = rows.filter(row => row.deleted_at === null);
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, first.id);
});

test('identical transcripts in two projects are both kept', async () => {
  const app = await boot();
  const text = '两个项目都会出现的同一句话';
  app.fireWithCwd(projectCwd('project-a'), 'user/message', text, 1, 'session-a');
  app.fireWithCwd(projectCwd('project-b'), 'user/message', text, 2, 'session-b');

  const db = openDb(app.home);
  const rows = db.prepare('SELECT id, scope FROM chunks WHERE text = ? AND deleted_at IS NULL').all(text);
  db.close();
  assert.equal(rows.length, 2);
  const scopes = new Set(rows.map(row => row.scope));
  assert.equal(scopes.size, 2);

  const projectB = [...scopes].find(scope => String(scope).includes('project-b'));
  const res = fakeRes();
  await app.route('/omni-memory/list').handler(
    fakeReq(`/omni-memory/list?limit=10&scope=${encodeURIComponent(projectB)}`), res.res,
  );
  assert.equal(res.json().chunks.length, 1);
  assert.match(res.json().chunks[0].text, /同一句话/);
});

test('memory_reindex rebuilds missing vectors for the hashed backend', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', text: '需要重建向量的结论' });

  let db = openDb(app.home);
  db.prepare("DELETE FROM vectors WHERE kind = 'note' AND owner_id = ?").run(written.value.id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n;
  db.close();

  const reindex = await app.call('memory_reindex', {});
  assert.equal(reindex.value.backend, 'hashed');
  assert.ok(reindex.value.processed >= 1);

  db = openDb(app.home);
  const after = db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n;
  db.close();
  assert.ok(after > Number(before));
});

test('schema v6 databases migrate to v11 without losing rows', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-v6-'));
  const dir = path.join(home, 'memory');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'omni.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT,
      role TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, source TEXT,
      importance REAL NOT NULL DEFAULT 0.5, scope TEXT, deleted_at INTEGER
    );
    CREATE UNIQUE INDEX chunks_hash ON chunks(hash);
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
      text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, source TEXT,
      revision INTEGER NOT NULL DEFAULT 1, superseded_by INTEGER,
      contested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
      verification TEXT, verified_at INTEGER, evidence TEXT
    );
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, relation TEXT NOT NULL,
      object TEXT NOT NULL, text TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
      confidence REAL NOT NULL DEFAULT 0.7, source TEXT, contested INTEGER NOT NULL DEFAULT 0,
      scope TEXT, deleted_at INTEGER
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL,
      valid_from INTEGER NOT NULL, valid_to INTEGER, source TEXT
    );
    CREATE TABLE vectors (kind TEXT NOT NULL, owner_id INTEGER NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (kind, owner_id));
    CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
    INSERT INTO meta(key, value) VALUES ('schema_version', '6');
    INSERT INTO chunks(ts, role, text, hash, scope) VALUES (1, 'user', '旧库里的转录', 'h1', 'global');
    INSERT INTO notes(ts, scope, text) VALUES (1, 'global', '旧库里的笔记');
    INSERT INTO facts(subject, relation, object, text, valid_from, scope)
      VALUES ('旧实体', '状态', '旧值', '旧实体 状态 旧值', 1, 'global');
    INSERT INTO edges(src, rel, dst, valid_from) VALUES ('旧实体', '状态', '旧值', 1);
  `);
  db.close();

  const app = await boot({ home });
  const res = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=10'), res.res);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.schema, app.mod.SCHEMA_VERSION);
  assert.equal(body.stats.notes, 1);

  const check = new DatabaseSync(file);
  const chunk = check.prepare('SELECT text, scope FROM chunks WHERE hash = ?').get('h1');
  assert.equal(chunk.text, '旧库里的转录');
  const columns = name => check.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
  assert.ok(columns('facts').includes('recorded_at'));
  assert.ok(columns('edges').includes('scope'));
  const indexes = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
  assert.ok(indexes.includes('chunks_hash_active'));
  check.close();
});
