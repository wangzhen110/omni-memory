import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, backupPathOf, copyBackup } from './helpers.mjs';

const EXPORT_FORMAT = 'omni-memory-backup';

/** 每个 boot 都用独立 DSH_HOME；回调里关掉模块缓存的数据库连接再删目录，避免 Windows 上文件被占用。 */
async function bootIsolated(t) {
  const app = await boot();
  t.after(() => {
    try { app.mod.openStore().db.close(); } catch { /* 连接可能已关闭 */ }
    rmSync(app.home, { recursive: true, force: true });
  });
  return app;
}

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

function tableCounts(home) {
  const db = dbOf(home);
  const result = {};
  for (const [key, table] of [
    ['notes', 'notes'], ['facts', 'facts'], ['chunks', 'chunks'], ['edges', 'edges'],
    ['entities', 'entities'], ['relations', 'relations'], ['entityAliases', 'entity_aliases'],
    ['persona', 'persona'], ['candidates', 'note_candidates'],
  ]) {
    result[key] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  db.close();
  return result;
}

function writeSnapshot(home, name, snapshot) {
  const dir = path.join(home, 'memory', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return file;
}

async function exportedSeed(t, seedText) {
  const app = await bootIsolated(t);
  await app.call('memory_write', { kind: 'note', scope: 'global', text: seedText });
  const file = backupPathOf(app, 'seed.json');
  await app.call('memory_export', { path: path.basename(file) });
  return { app, file, snapshot: JSON.parse(readFileSync(file, 'utf8')) };
}

function groupByScope(rows) {
  const counts = new Map();
  for (const row of rows) {
    const scope = row.scope ?? 'global';
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

test('import rejects a snapshot written by a newer version and leaves the store untouched', async (t) => {
  const { snapshot } = await exportedSeed(t, 'EdgeVersion 基准');
  const target = await bootIsolated(t);
  await target.call('memory_write', { kind: 'note', scope: 'global', text: 'EdgeVersion 保留' });
  const before = tableCounts(target.home);
  assert.equal(before.notes, 1);

  const file = writeSnapshot(target.home, 'newer-version.json', {
    ...snapshot,
    version: snapshot.version + 1,
  });

  await assert.rejects(
    () => target.call('memory_import', { path: path.basename(file) }),
    (error) => /newer version/.test(error.message),
    'dryRun 也必须拒绝未来版本',
  );
  await assert.rejects(
    () => target.call('memory_import', { path: path.basename(file), dryRun: false }),
    (error) => /newer version/.test(error.message),
  );
  assert.deepEqual(tableCounts(target.home), before, '版本检查在任何写入之前发生');
});

test('import fails cleanly on truncated or malformed JSON without partial writes', async (t) => {
  const { app: sourceApp, file: validFile } = await exportedSeed(t, 'EdgeTrunc 基准');
  const target = await bootIsolated(t);
  await target.call('memory_write', { kind: 'note', scope: 'global', text: 'EdgeTrunc 保留' });
  const before = tableCounts(target.home);

  const targetBackupDir = path.join(target.home, 'memory', 'backups');
  mkdirSync(targetBackupDir, { recursive: true });
  const truncated = path.join(targetBackupDir, 'truncated.json');
  writeFileSync(truncated, readFileSync(validFile, 'utf8').slice(0, 100));
  const malformed = path.join(targetBackupDir, 'malformed.json');
  writeFileSync(malformed, '{ not really json');

  for (const file of [truncated, malformed]) {
    await assert.rejects(
      () => target.call('memory_import', { path: path.basename(file), dryRun: false }),
      (error) => /cannot read backup/.test(error.message),
      '解析失败应被包装成受控错误，而不是抛出裸 SyntaxError',
    );
  }
  assert.deepEqual(tableCounts(target.home), before, '解析失败不能留下半写入');

  // 失败之后库仍然可用：再导入合法快照应正常写入。
  const shared = copyBackup(sourceApp, target, 'seed.json');
  const applied = await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  assert.equal(applied.value.notes, 1);
  assert.equal(tableCounts(target.home).notes, before.notes + 1);
});

test('import rejects a snapshot with a wrong or missing format field', async (t) => {
  const { snapshot } = await exportedSeed(t, 'EdgeFormat 基准');
  const target = await bootIsolated(t);
  await target.call('memory_write', { kind: 'note', scope: 'global', text: 'EdgeFormat 保留' });
  const before = tableCounts(target.home);

  const wrong = writeSnapshot(target.home, 'wrong-format.json', { ...snapshot, format: 'some-other-tool' });
  const missing = writeSnapshot(target.home, 'missing-format.json', { ...snapshot, format: undefined });

  for (const file of [wrong, missing]) {
    await assert.rejects(
      () => target.call('memory_import', { path: path.basename(file), dryRun: false }),
      (error) => /not an omni-memory backup/.test(error.message),
    );
  }
  assert.deepEqual(tableCounts(target.home), before);
});

test('a type-invalid note is rejected before writing and leaves every row untouched', async (t) => {
  const { snapshot } = await exportedSeed(t, 'EdgePartial 基准');
  const target = await bootIsolated(t);
  await target.call('memory_write', { kind: 'note', scope: 'global', text: 'EdgePartial 保留' });
  const before = tableCounts(target.home);
  const base = snapshot.notes[0];

  const file = writeSnapshot(target.home, 'partial-invalid.json', {
    ...snapshot,
    notes: [
      { ...base, id: 9101, text: 'EdgePartialGoodA' },
      // 缺 text 的行在计划阶段跳过。
      { id: 9102, ts: base.ts, scope: 'global', importance: 0.5 },
      // 非数字 importance 必须在写库前拒绝，而不是让 NaN 撞上 NOT NULL。
      { ...base, id: 9103, text: 'EdgePartialBad', importance: 'not-a-number' },
      { ...base, id: 9104, text: 'EdgePartialGoodB' },
    ],
    facts: [], chunks: [], edges: [], entities: [], relations: [],
    entityAliases: [], persona: [], candidates: [],
  });

  await assert.rejects(
    () => target.call('memory_import', { path: path.basename(file) }),
    (error) => /imported numeric field is not finite/.test(error.message),
  );
  await assert.rejects(
    () => target.call('memory_import', { path: path.basename(file), dryRun: false }),
    (error) => /imported numeric field is not finite/.test(error.message),
  );
  assert.deepEqual(tableCounts(target.home), before, '坏行不会部分写入，也不会留下前面的好行');

  const hits = await target.call('memory_search', { query: 'EdgePartialGoodA', scope: 'all' });
  assert.equal(hits.value.hits.filter(hit => hit.kind === 'note').length, 0);
});

test('global and two project scopes survive export/import without cross-scope mixing', async (t) => {
  const source = await bootIsolated(t);
  for (const [scope, tag] of [['global', 'Global'], ['proj-alpha', 'Alpha'], ['proj-beta', 'Beta']]) {
    await source.call('memory_write', { kind: 'note', scope, text: `EdgeScope${tag} 结论` });
    await source.call('memory_write', {
      kind: 'fact', scope, text: '', subject: `EdgeScope${tag}Fact`, relation: '归属', object: tag,
    });
  }

  const file = backupPathOf(source, 'cross-scope.json');
  await source.call('memory_export', { path: path.basename(file) });
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.format, EXPORT_FORMAT);

  const expectedNotes = groupByScope(snapshot.notes);
  const expectedFacts = groupByScope(snapshot.facts);
  assert.deepEqual(expectedNotes, [['global', 1], ['proj-alpha', 1], ['proj-beta', 1]]);
  assert.deepEqual(expectedFacts, [['global', 1], ['proj-alpha', 1], ['proj-beta', 1]]);

  const target = await bootIsolated(t);
  const shared = copyBackup(source, target, 'cross-scope.json');
  const dry = await target.call('memory_import', { path: path.basename(shared) });
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.notes, snapshot.notes.length);
  assert.equal(dry.value.facts, snapshot.facts.length);
  assert.equal(tableCounts(target.home).notes, 0);
  assert.equal(tableCounts(target.home).facts, 0);

  const applied = await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  assert.equal(applied.value.notes, snapshot.notes.length);
  assert.equal(applied.value.facts, snapshot.facts.length);

  const db = dbOf(target.home);
  const noteRows = db.prepare('SELECT scope, text FROM notes ORDER BY id').all();
  const factRows = db.prepare('SELECT scope, subject, relation, object FROM facts ORDER BY id').all();
  db.close();

  assert.deepEqual(groupByScope(noteRows), expectedNotes);
  assert.deepEqual(groupByScope(factRows), expectedFacts);

  const noteScopeByText = new Map(noteRows.map(row => [row.text, row.scope ?? 'global']));
  for (const row of snapshot.notes) {
    assert.equal(noteScopeByText.get(row.text), row.scope ?? 'global', 'note 的 scope 不能被改写');
  }
  const factKey = row => `${row.subject}|${row.relation}|${row.object}`;
  const factScopeByKey = new Map(factRows.map(row => [factKey(row), row.scope ?? 'global']));
  for (const row of snapshot.facts) {
    assert.equal(factScopeByKey.get(factKey(row)), row.scope ?? 'global', 'fact 的 scope 不能被改写');
  }
});

test('a legacy-style snapshot without newer optional note fields still imports', async (t) => {
  const { snapshot } = await exportedSeed(t, 'EdgeLegacy 基准');
  const sourceNote = snapshot.notes[0];
  const legacyNote = { ...sourceNote };
  for (const key of [
    'verification', 'verified_at', 'evidence',
    'recall_count', 'last_recall_at', 'useful_count', 'misleading_count',
  ]) {
    delete legacyNote[key];
  }

  const target = await bootIsolated(t);
  const file = writeSnapshot(target.home, 'legacy-style.json', {
    ...snapshot,
    notes: [legacyNote],
    facts: [], chunks: [], edges: [], entities: [], relations: [],
    entityAliases: [], persona: [], candidates: [],
  });

  // 实现里这些字段都用 ?? 兜底，所以删掉新增可选字段不会阻塞导入。
  const result = await target.call('memory_import', { path: path.basename(file), dryRun: false });
  assert.equal(result.value.notes, 1);

  const db = dbOf(target.home);
  const row = db.prepare('SELECT text, scope, importance, reuse_count FROM notes').get();
  db.close();
  assert.equal(row.text, sourceNote.text);
  assert.equal(row.scope, sourceNote.scope ?? 'global');
  assert.equal(row.importance, sourceNote.importance);
  assert.equal(row.reuse_count, sourceNote.reuse_count ?? 0);
});
