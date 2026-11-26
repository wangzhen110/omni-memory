import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, projectCwd } from './helpers.mjs';

const CWD = projectCwd('persisted-project');

test('agent to project mapping survives a plugin reload', async () => {
  const home = (await boot()).home;

  const first = await boot({ home });
  first.fireWithCwd(CWD, 'user/message', '开始工作', 1, 'session-persist');
  first.fireInbox('开始工作', 'session-persist');
  const written = await first.call('memory_write', { kind: 'note', text: 'reload 前写入' });
  assert.ok(String(written.value.scope).startsWith('proj:persisted-project#'), written.value.scope);

  // Fresh module instance, same home: the in-memory map is gone, meta remains.
  const second = await boot({ home });
  const tool = second.tools.get('memory_write');
  const after = await tool.execute(
    { kind: 'note', text: 'reload 后写入' },
    { agent: { id: 'session-persist' } },
  );
  assert.ok(String(after.scope).startsWith('proj:persisted-project#'), after.scope);
});

test('an unknown agent still fails closed to global after reload', async () => {
  const home = (await boot()).home;
  const app = await boot({ home });
  const tool = app.tools.get('memory_write');
  const value = await tool.execute({ kind: 'note', text: 'unknown agent write' }, { agent: { id: 'never-seen' } });
  assert.equal(value.scope, 'global');
});
