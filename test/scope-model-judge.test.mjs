import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot, fakeReq, fakeRes, projectCwd } from './helpers.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeLlm(reply) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ id: 'fake-flash' }],
    stream(options) {
      calls.push(options);
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

function noteScope(home, id) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const row = db.prepare('SELECT scope, text FROM notes WHERE id = ?').get(id);
  db.close();
  return row;
}

async function enterProject(app) {
  app.fireWithCwd(projectCwd('proj-a'), 'user/message', '进入项目甲', 1, 'session-a');
  app.section().text({ scope: { id: 'session-a' } });
}

test('FR-28 an ambiguous note is re-classified by the model and moved', async () => {
  const previous = process.env.OMNI_SCOPE_JUDGE;
  process.env.OMNI_SCOPE_JUDGE = 'always';
  try {
    const llm = fakeLlm('global');
    const app = await boot({ llm });
    await enterProject(app);
    const written = await app.call('memory_write', { kind: 'note', text: '这个结论先放在这里' });
    assert.match(written.value.scope, /^proj:proj-a#/);
    await wait(250);
    assert.equal(noteScope(app.home, written.value.id).scope, 'global');
    assert.equal(llm.calls.length, 1);
    assert.match(String(llm.calls[0].model), /fake-flash/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_SCOPE_JUDGE;
    else process.env.OMNI_SCOPE_JUDGE = previous;
  }
});

test('FR-28 a high-confidence rule is not re-checked in auto mode', async () => {
  const previous = process.env.OMNI_SCOPE_JUDGE;
  process.env.OMNI_SCOPE_JUDGE = 'auto';
  try {
    const llm = fakeLlm('project');
    const app = await boot({ llm });
    await enterProject(app);
    const written = await app.call('memory_write', {
      kind: 'note', text: '以后所有项目都先给结论',
    });
    assert.equal(written.value.scope, 'global');
    await wait(250);
    assert.equal(llm.calls.length, 0);
    assert.equal(noteScope(app.home, written.value.id).scope, 'global');
  } finally {
    if (previous === undefined) delete process.env.OMNI_SCOPE_JUDGE;
    else process.env.OMNI_SCOPE_JUDGE = previous;
  }
});

test('FR-28 an explicit scope is never overruled by the model', async () => {
  const llm = fakeLlm('global');
  const app = await boot({ llm });
  await enterProject(app);
  const written = await app.call('memory_write', {
    kind: 'note', text: '本仓库的构建命令是 vite build', scope: 'global',
  });
  await wait(250);
  assert.equal(llm.calls.length, 0);
  assert.equal(noteScope(app.home, written.value.id).scope, 'global');
});

test('FR-28 without a project the model is not called', async () => {
  const llm = fakeLlm('project');
  const app = await boot({ llm });
  const written = await app.call('memory_write', { kind: 'note', text: '没有任何上下文的结论' });
  await wait(250);
  assert.equal(llm.calls.length, 0);
  assert.equal(noteScope(app.home, written.value.id).scope, 'global');
});

test('FR-28 always mode judges every write', async () => {
  const previous = process.env.OMNI_SCOPE_JUDGE;
  process.env.OMNI_SCOPE_JUDGE = 'always';
  try {
    const llm = fakeLlm('project');
    const app = await boot({ llm });
    await enterProject(app);
    const written = await app.call('memory_write', {
      kind: 'note', text: '以后所有项目都先给结论',
    });
    await wait(250);
    assert.equal(llm.calls.length, 1);
    assert.match(noteScope(app.home, written.value.id).scope, /^proj:proj-a#/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_SCOPE_JUDGE;
    else process.env.OMNI_SCOPE_JUDGE = previous;
  }
});

test('FR-28 off mode keeps the rule verdict and never calls the model', async () => {
  const previous = process.env.OMNI_SCOPE_JUDGE;
  process.env.OMNI_SCOPE_JUDGE = 'off';
  try {
    const llm = fakeLlm('global');
    const app = await boot({ llm });
    await enterProject(app);
    const written = await app.call('memory_write', { kind: 'note', text: '这个结论先放在这里' });
    await wait(250);
    assert.equal(llm.calls.length, 0);
    assert.match(noteScope(app.home, written.value.id).scope, /^proj:proj-a#/);
  } finally {
    if (previous === undefined) delete process.env.OMNI_SCOPE_JUDGE;
    else process.env.OMNI_SCOPE_JUDGE = previous;
  }
});

test('FR-28 a judge failure keeps the write and the rule verdict', async () => {
  const app = await boot({
    llm: {
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      listModels: async () => [{ id: 'fake-flash' }],
      stream() { throw new Error('provider down'); },
    },
  });
  await enterProject(app);
  const written = await app.call('memory_write', { kind: 'note', text: '这个结论先放在这里' });
  await wait(250);
  assert.match(noteScope(app.home, written.value.id).scope, /^proj:proj-a#/);
});

test('FR-28 without an llm service writes still succeed', async () => {
  const app = await boot();
  await enterProject(app);
  const written = await app.call('memory_write', { kind: 'note', text: '这个结论先放在这里' });
  await wait(100);
  assert.match(written.value.scope, /^proj:proj-a#/);
});

test('FR-28 the status route reports the last model verdict', async () => {
  const previous = process.env.OMNI_SCOPE_JUDGE;
  process.env.OMNI_SCOPE_JUDGE = 'always';
  try {
    const llm = fakeLlm('global');
    const app = await boot({ llm });
    await enterProject(app);
    const written = await app.call('memory_write', { kind: 'note', text: '这个结论先放在这里' });
    await wait(250);
    const { res, json } = fakeRes();
    await app.route('/omni-memory/status').handler(fakeReq('/omni-memory/status'), res);
    const body = json();
    assert.equal(body.lastJudge.id, written.value.id);
    assert.equal(body.lastJudge.from, written.value.scope);
    assert.equal(body.lastJudge.to, 'global');
  } finally {
    if (previous === undefined) delete process.env.OMNI_SCOPE_JUDGE;
    else process.env.OMNI_SCOPE_JUDGE = previous;
  }
});
