import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { human } from '../scripts/install.mjs';

// 4.6.20/4.6.21: two contracts that regressed silently (published docs drifted
// from code, and the installer printed "undefined" on the apply path). Both are
// pinned here so a future refactor fails loudly instead of failing a review.
//
// 4.6.21 fixes a false positive found in review: the plan.home case matched the
// doctor line (same value) instead of the install line, so dropping the
// plan.home fallback still passed. Install-line assertions below read the
// first occurrence only, and doctor.home is deliberately a different value.

function installLine(summary) {
  const line = summary.split('\n').find((l) => l.startsWith('数据根目录:'));
  assert.ok(line, 'install summary must print 数据根目录');
  return line;
}

function baseResult(overrides = {}) {
  return {
    repo: 'D:\\repo',
    dryRun: true,
    plan: { target: 'C:\\launcher.exe', commit: 'abc1234', sha256: 'f'.repeat(64) },
    doctor: { ok: true, repo: 'D:\\repo', home: 'D:\\doctor-home', db: 'D:\\doctor-home\\memory\\omni.db', checks: [], counts: { ok: 0, warn: 0, fail: 0 } },
    ...overrides,
  };
}

test('install line uses result.home and never prints undefined', () => {
  const summary = human(baseResult({
    plan: { target: 'C:\\Users\\X\\.dsh\\omni-serve.exe', noTask: false, task: 'OmniMemory7788', commit: 'abc1234', sha256: 'f'.repeat(64), home: 'C:\\plan-home' },
    home: 'C:\\result-home',
  }));
  assert.equal(installLine(summary), '数据根目录: C:\\result-home');
  assert.doesNotMatch(summary, /undefined/);
});

test('install line falls back to plan.home when result.home is absent', () => {
  const summary = human(baseResult({
    plan: { target: 'C:\\launcher.exe', home: 'D:\\.dsh-alpha', commit: 'abc1234', sha256: 'f'.repeat(64) },
  }));
  assert.equal(installLine(summary), '数据根目录: D:\\.dsh-alpha');
  assert.doesNotMatch(summary, /undefined/);
});

test('install line says so plainly when no data root can be resolved', () => {
  const summary = human(baseResult({ plan: null }));
  assert.equal(installLine(summary), '数据根目录: 未解析（doctor 使用默认 ~/.dsh）');
  assert.doesNotMatch(summary, /undefined/);
});

test('计划任务 never prints undefined and reports noTask as 不创建/不修改', () => {
  const withTask = human(baseResult({
    task: 'OmniMemory7788',
    plan: { target: 'C:\\launcher.exe', commit: 'abc1234', sha256: 'f'.repeat(64) },
  }));
  assert.match(withTask, /^计划任务: OmniMemory7788$/m);

  const fromPlan = human(baseResult({
    plan: { target: 'C:\\launcher.exe', task: 'PlanTask7788', commit: 'abc1234', sha256: 'f'.repeat(64) },
  }));
  assert.match(fromPlan, /^计划任务: PlanTask7788$/m);

  const noTask = human(baseResult({
    plan: { target: 'C:\\launcher.exe', noTask: true, commit: 'abc1234', sha256: 'f'.repeat(64) },
  }));
  assert.match(noTask, /^计划任务: 不创建\/不修改$/m);

  const unknown = human(baseResult({ plan: { target: 'C:\\launcher.exe', commit: 'abc1234', sha256: 'f'.repeat(64) } }));
  assert.match(unknown, /^计划任务: 未解析$/m);

  for (const s of [withTask, fromPlan, noTask, unknown]) assert.doesNotMatch(s, /计划任务: undefined/);
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
