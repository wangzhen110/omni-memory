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

async function seedTwoLayers(app) {
  app.fireWithCwd(projectCwd('proj-a'), 'user/message', '项目甲的背景信息', 1, 'session-a');
  const scopeA = chunkScope(app.home, 'session-a');
  const projectNote = await app.call('memory_write', {
    kind: 'note', text: '项目甲专属结论：构建用 vite', scope: scopeA, importance: 0.9,
  });
  const globalNote = await app.call('memory_write', {
    kind: 'note', text: '全局偏好：回答用中文，直接执行', importance: 0.95,
  });
  return { scopeA, projectNote, globalNote };
}

test('FR-26 capture derives the project layer from the session workspace', async () => {
  const app = await boot();
  app.fireWithCwd(projectCwd('proj-a'), 'user/message', '项目甲的消息', 1, 'session-a');
  const scope = chunkScope(app.home, 'session-a');
  assert.match(scope, /^proj:proj-a#[0-9a-f]{6}$/);
});

test('FR-26 a session without a workspace stays global', async () => {
  const app = await boot();
  app.fire('user/message', '没有工作目录的消息', 1, 'session-plain');
  assert.equal(chunkScope(app.home, 'session-plain'), 'global');
});

test('FR-26 the profile shows global notes plus the current project only', async () => {
  const app = await boot();
  const { scopeA } = await seedTwoLayers(app);

  const projectView = app.section().text({ scope: { id: 'session-a' } });
  assert.match(projectView, /项目甲专属结论/);
  assert.match(projectView, /全局偏好/);
  assert.match(projectView, new RegExp(`Current project scope: ${scopeA.replace('#', '#')}`));

  const elsewhere = app.section().text({ scope: { id: 'session-elsewhere' } });
  assert.match(elsewhere, /全局偏好/);
  assert.equal(elsewhere.includes('项目甲专属结论'), false, 'project notes must not leak');
});

test('FR-26 project search includes the global layer but not another project', async () => {
  const app = await boot();
  const { scopeA, projectNote, globalNote } = await seedTwoLayers(app);

  const inProject = await app.call('memory_search', { query: '构建用 vite', scope: scopeA, limit: 10 });
  assert.ok(inProject.value.hits.some(hit => hit.kind === 'note' && hit.id === projectNote.value.id));

  const inOther = await app.call('memory_search', { query: '构建用 vite', scope: 'proj:other#abcdef', limit: 10 });
  assert.equal(inOther.value.hits.some(hit => hit.kind === 'note' && hit.id === projectNote.value.id), false);

  const globalVisible = await app.call('memory_search', { query: '直接执行', scope: 'proj:other#abcdef', limit: 10 });
  assert.ok(globalVisible.value.hits.some(hit => hit.kind === 'note' && hit.id === globalNote.value.id),
    'global notes stay visible in every project');
});

test('FR-26 scope=all searches every layer', async () => {
  const app = await boot();
  const { projectNote } = await seedTwoLayers(app);
  const all = await app.call('memory_search', { query: '构建用 vite', scope: 'all', limit: 10 });
  assert.ok(all.value.hits.some(hit => hit.kind === 'note' && hit.id === projectNote.value.id));
});

test('FR-26 the list route filters layers and reports both counts', async () => {
  const app = await boot();
  await seedTwoLayers(app);

  const project = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=project'), project.res);
  const projectBody = project.json();
  assert.equal(projectBody.notes.every(note => String(note.scope).startsWith('proj:')), true);
  assert.ok(projectBody.stats.globalNotes >= 1);
  assert.ok(projectBody.stats.projectNotes >= 1);

  const global = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=global'), global.res);
  const globalBody = global.json();
  assert.equal(globalBody.notes.every(note => !String(note.scope).startsWith('proj:')), true);
  assert.equal(globalBody.page.scope, 'global');

  const all = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?scope=all'), all.res);
  const allBody = all.json();
  assert.ok(allBody.page.totalNotes > projectBody.page.totalNotes);
});
