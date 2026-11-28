import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { human } from '../scripts/install.mjs';

// 4.6.20: two contracts that regressed silently (published docs drifted from
// code, and the installer printed "undefined" on the apply path). Both are
// pinned here so a future refactor fails loudly instead of failing a review.

test('install summary never prints undefined for the data root', () => {
  const summary = human({
    repo: 'D:\\repo',
    dryRun: false,
    plan: { target: 'C:\\Users\\X\\.dsh\\omni-serve.exe', noTask: false, task: 'OmniMemory7788', commit: 'abc1234', sha256: 'f'.repeat(64), home: 'C:\\Users\\X\\.dsh' },
    doctor: { ok: true, repo: 'D:\\repo', home: 'C:\\Users\\X\\.dsh', db: 'C:\\Users\\X\\.dsh\\memory\\omni.db', checks: [], counts: { ok: 0, warn: 0, fail: 0 } },
  });
  assert.match(summary, /数据根目录: C:\\Users\\X\\\.dsh/);
  assert.doesNotMatch(summary, /undefined/);
});

test('install summary falls back to plan.home when result.home is absent', () => {
  const summary = human({
    repo: 'D:\\repo',
    dryRun: true,
    plan: { target: 'C:\\launcher.exe', home: 'D:\\.dsh-alt', commit: 'abc1234', sha256: 'f'.repeat(64) },
    doctor: { ok: true, repo: 'D:\\repo', home: 'D:\\.dsh-alt', db: 'D:\\memory\\omni.db', checks: [], counts: { ok: 0, warn: 0, fail: 0 } },
  });
  assert.match(summary, /数据根目录: D:\\\.dsh-alt/);
});

test('install summary says so plainly when no data root can be resolved', () => {
  const summary = human({
    repo: 'D:\\repo',
    dryRun: true,
    plan: null,
    doctor: { ok: true, repo: 'D:\\repo', home: '', db: '', checks: [], counts: { ok: 0, warn: 0, fail: 0 } },
  });
  assert.match(summary, /数据根目录: 未解析/);
  assert.doesNotMatch(summary, /undefined/);
});

test('fact errors keep the four documented messages', async () => {
  const app = await boot();
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', object: '容器', scope: 'global' }),
    { message: 'subject is required for kind=fact' },
  );
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', subject: '★★', relation: '是', object: '容器', scope: 'global' }),
    { message: 'subject is required for kind=fact (it must contain a letter or digit)' },
  );
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', subject: '容器', relation: '', object: '端口', scope: 'global' }),
    { message: 'relation is required for kind=fact' },
  );
  await assert.rejects(
    () => app.call('memory_write', { kind: 'fact', subject: '容器', relation: '是', scope: 'global' }),
    { message: 'object is required for kind=fact (pass object or a non-empty text)' },
  );
});

test('a valid fact still writes after the message assertions', async () => {
  const app = await boot();
  const written = await app.call('memory_write', {
    kind: 'fact', subject: '部署端口', relation: '是', object: '7788', scope: 'global',
  });
  assert.ok(written.value.id, 'a valid fact returns its row id');
});
