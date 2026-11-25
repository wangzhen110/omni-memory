import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { boot } from './helpers.mjs';

const TARGET = 'proj:专业知识#967a81';

function dbOf(app) {
  const db = new DatabaseSync(path.join(app.home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

test('profile excludes imported knowledge but keeps ordinary active notes', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', importance: 0.95, source: '专业知识/风电/登高.md#规则',
    text: '风电登高作业必须使用 GB/T 19155 规定的吊篮，并且每次都要检查钢丝绳。',
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', importance: 0.8, text: 'ActiveProfileNote 这条普通结论应留在画像里',
  });
  const profile = await app.call('memory_profile', { scope: 'global' });
  assert.equal(profile.text.includes('ActiveProfileNote'), true, 'ordinary active note missing');
  assert.equal(profile.text.includes('GB/T 19155'), false, 'knowledge source leaked into profile');
  assert.equal(profile.text.includes('风电登高'), false, 'knowledge source leaked into profile');
});

test('search preserves full text, reports total, supports offset and explains hits', async () => {
  const app = await boot();
  const long = 'SearchOutput Alpha ' + '这是一段用于验证不硬截断的完整正文。'.repeat(25) + ' 尾部结论必须可见。';
  await app.call('memory_write', { kind: 'note', scope: 'global', text: long, importance: 0.8 });
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'SearchOutput Beta 第二条', importance: 0.7 });
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'SearchOutput Gamma 第三条', importance: 0.6 });
  const result = await app.call('memory_search', { query: 'SearchOutput', scope: 'global', limit: 2, offset: 1 });
  assert.equal(result.value.total, 3);
  assert.equal(result.value.returned, 2);
  assert.equal(result.value.offset, 1);
  assert.equal(result.value.truncated, false);
  assert.ok(result.value.total > result.value.returned);
  assert.ok(result.value.hits.every(hit => hit.why && hit.snippet));
  const alpha = result.value.hits.find(hit => hit.text.startsWith('SearchOutput Alpha'));
  if (alpha) {
    assert.equal(alpha.text, long);
    assert.equal(alpha.text.length > 400, true);
  }
  assert.match(result.text, /matched 3 candidate\(s\)/);
  assert.match(result.text, /showing 2 from 1/);
});

test('search flags a stale product version and keeps the current one unflagged', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: '全息记忆 3.11.8 的旧结论：这里只记录旧版本。', importance: 0.9,
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', text: '全息记忆 4.2.0 的当前结论：这里记录当前版本。', importance: 0.5,
  });
  const result = await app.call('memory_search', { query: '全息记忆 版本 结论', scope: 'global', limit: 3 });
  const stale = result.value.hits.find(hit => hit.text.includes('3.11.8'));
  const current = result.value.hits.find(hit => hit.text.includes('4.2.0'));
  assert.equal(stale?.staleVersion, '3.11.8');
  assert.equal(current?.staleVersion, undefined);
});

test('overview exposes one pending total and the coverage fields', async () => {
  const app = await boot();
  await app.call('memory_ingest', { text: '以后所有项目都先给结论，这条是待审候选。', role: 'user', scope: 'global' });
  const { fakeReq, fakeRes } = await import('./helpers.mjs');
  const { res, state, json } = fakeRes();
  await app.route('/omni-memory/overview').handler(fakeReq('/omni-memory/overview?scope=global'), res);
  assert.equal(state.statusCode, 200);
  const stats = json().stats;
  assert.equal(stats.pendingBreakdown.total, stats.pending);
  assert.ok(stats.pendingBreakdown.candidates >= 1);
  assert.equal(stats.coverage.recall.total, stats.recallTotal);
  assert.equal(stats.sourceRate === null || typeof stats.sourceRate === 'number', true);
});

test('kb-migrate moves only knowledge-source notes and is a dry run by default', async () => {
  const app = await boot();
  await app.call('memory_write', {
    kind: 'note', scope: 'global', source: '专业知识/测试/一.md#节', text: 'KnowledgeOne 领域知识',
  });
  await app.call('memory_write', {
    kind: 'note', scope: 'global', source: 'session:test', text: 'UserRuleOne 用户规则',
  });
  const db = dbOf(app);
  const { migrateKnowledgeNotes } = await import('../index.js');
  const preview = migrateKnowledgeNotes(db);
  assert.equal(preview.total, 1);
  assert.equal(preview.moved, 0);
  const applied = migrateKnowledgeNotes(db, { apply: true });
  assert.equal(applied.moved, 1);
  const global = db.prepare("SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND scope = 'global' AND source LIKE '专业知识/%'").get();
  const target = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND scope = ?').get(TARGET);
  assert.equal(Number(global.n), 0);
  assert.equal(Number(target.n), 1);
  db.close();
});
