import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot, fakeReq, fakeRes, projectCwd } from './helpers.mjs';

function chunkScope(home, sessionId) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const row = db.prepare('SELECT scope FROM chunks WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  db.close();
  return row?.scope ?? null;
}

async function twoProjects(app) {
  app.fireWithCwd(projectCwd('proj-a'), 'user/message', '项目甲的对话内容', 1, 'session-a');
  app.fireWithCwd(projectCwd('proj-b'), 'user/message', '项目乙的对话内容', 1, 'session-b');
  const scopeA = chunkScope(app.home, 'session-a');
  const scopeB = chunkScope(app.home, 'session-b');
  await app.call('memory_write', { kind: 'note', text: '项目甲的构建命令是 vite build', scope: scopeA });
  await app.call('memory_write', { kind: 'note', text: '项目乙的构建命令是 webpack', scope: scopeB });
  return { scopeA, scopeB };
}

test('the list route reports every project layer with transcripts counted', async () => {
  const app = await boot();
  const { scopeA, scopeB } = await twoProjects(app);

  const { res, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=project'), res);
  const body = json();
  assert.equal(body.ok, true);
  const projects = body.projects ?? [];
  assert.equal(projects.length, 2);
  const a = projects.find(project => project.scope === scopeA);
  const b = projects.find(project => project.scope === scopeB);
  assert.ok(a, 'project A must be listed');
  assert.ok(b, 'project B must be listed');
  assert.equal(a.notes, 1);
  assert.ok(a.chunks >= 1, 'captured transcripts must be counted');
});

test('an exact project view lists its own transcripts', async () => {
  const app = await boot();
  const { scopeA, scopeB } = await twoProjects(app);

  const { res, json } = fakeRes();
  await app.route('/omni-memory/list').handler(
    fakeReq(`/omni-memory/list?scope=${encodeURIComponent(scopeA)}`), res,
  );
  const body = json();
  assert.ok(Array.isArray(body.chunks));
  assert.ok(body.chunks.length >= 1);
  assert.equal(body.chunks.every(chunk => String(chunk.text).includes('项目甲')), true);
  assert.equal(body.notes.some(note => String(note.scope) === scopeB), false, 'other project notes must not leak');
});

test('a project with transcripts and no notes still shows up', async () => {
  const app = await boot();
  app.fireWithCwd(projectCwd('proj-c'), 'user/message', '项目丙只有转录没有笔记', 1, 'session-c');
  const scopeC = chunkScope(app.home, 'session-c');

  const { res, json } = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=project'), res);
  const body = json();
  const entry = (body.projects ?? []).find(project => project.scope === scopeC);
  assert.ok(entry, 'transcript-only project must be visible');
  assert.equal(entry.notes, 0);
  assert.ok(entry.chunks >= 1);
});
