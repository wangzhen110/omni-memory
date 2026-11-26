import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, projectCwd } from './helpers.mjs';

/** Enter a session whose workspace is proj-a, and make it the current project. */
async function enterProject(app, cwd = projectCwd('proj-a'), sessionId = 'session-a') {
  app.fireWithCwd(cwd, 'user/message', '进入项目甲', 1, sessionId);
  app.section().text({ scope: { id: sessionId } });
  return sessionId;
}

test('FR-27 project wording is written to the project layer', async () => {
  const app = await boot();
  await enterProject(app);
  const written = await app.call('memory_write', {
    kind: 'note', text: '本仓库的检索管线用 RRF 融合三路结果',
  });
  assert.match(written.value.scope, /^proj:proj-a#/);
  assert.equal(written.value.scopeReason, 'project-specific wording');
});

test('FR-27 cross-project rules go to the global layer', async () => {
  const app = await boot();
  await enterProject(app);
  const written = await app.call('memory_write', {
    kind: 'note', text: '以后所有项目都优先用中文回答，不要再问确认',
  });
  assert.equal(written.value.scope, 'global');
  assert.equal(written.value.scopeReason, 'cross-project wording');
});

test('FR-27 an ambiguous statement defaults to the project it was said in', async () => {
  const app = await boot();
  await enterProject(app);
  const written = await app.call('memory_write', {
    kind: 'note', text: '这个结论先放在这里',
  });
  assert.match(written.value.scope, /^proj:proj-a#/);
  assert.equal(written.value.scopeReason, 'default-to-project');
});

test('FR-27 an explicit scope always wins', async () => {
  const app = await boot();
  await enterProject(app);
  const written = await app.call('memory_write', {
    kind: 'note', text: '本仓库的构建命令是 vite build', scope: 'global',
  });
  assert.equal(written.value.scope, 'global');
  assert.equal(written.value.scopeReason, 'explicit');
});

test('FR-27 without a known project everything is global', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'note', text: '本仓库的检索管线用 RRF 融合',
  });
  assert.equal(written.value.scope, 'global');
  assert.equal(written.value.scopeReason, 'no-project');
});

test('FR-27 facts follow the same judgement', async () => {
  const app = await boot();
  await enterProject(app);
  const projectFact = await app.call('memory_write', {
    kind: 'fact', subject: '检索管线', relation: '实现', object: 'RRF',
    text: '本项目检索管线实现为 RRF 融合',
  });
  assert.match(projectFact.value.scope, /^proj:proj-a#/);

  const globalFact = await app.call('memory_write', {
    kind: 'fact', subject: '回答语言', relation: '偏好', object: '中文',
    text: '所有项目一律用中文回答',
  });
  assert.equal(globalFact.value.scope, 'global');
});

test('FR-27 search defaults to the current project instead of every layer', async () => {
  const app = await boot();
  const sessionId = await enterProject(app);
  const project = await app.call('memory_write', { kind: 'note', text: '本仓库的缓存用 WAL 模式' });
  const otherProject = await app.call('memory_write', {
    kind: 'note', text: '另一个仓库的缓存用内存模式', scope: 'proj:other#abcdef',
  });

  const scoped = await app.call('memory_search', { query: '缓存模式' });
  assert.match(scoped.value.scope, /^proj:proj-a#/);
  const ids = scoped.value.hits.map(hit => hit.id);
  assert.ok(ids.includes(project.value.id));
  assert.equal(ids.includes(otherProject.value.id), false);

  const all = await app.call('memory_search', { query: '缓存模式', scope: 'all' });
  assert.equal(all.value.scope, 'all');
  assert.ok(all.value.hits.some(hit => hit.id === otherProject.value.id));

  void sessionId;
});

test('FR-27 the requested scope string is echoed back for traceability', async () => {
  const app = await boot();
  await enterProject(app);
  const global = await app.call('memory_search', { query: '缓存', scope: 'global' });
  assert.equal(global.value.scope, 'global');
  const all = await app.call('memory_search', { query: '缓存', scope: 'all' });
  assert.equal(all.value.scope, 'all');
});
