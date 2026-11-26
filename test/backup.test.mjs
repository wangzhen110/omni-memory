import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, fakeReq, fakeRes, backupPathOf, copyBackup } from './helpers.mjs';

function dbOf(home) {
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

const postWithCsrf = (url, headers = {}) => ({
  method: 'POST',
  url,
  headers: { host: '127.0.0.1', 'x-omni-csrf': '1', ...headers },
  socket: { remoteAddress: '127.0.0.1' },
});

test('export writes a portable snapshot that includes tombstones by default', async () => {
  const app = await boot();
  const active = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'BackupActive 会导出的结论' });
  const gone = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'BackupGone 已墓碑的结论' });
  await app.call('memory_forget', { kind: 'note', id: gone.value.id });
  app.fire('user/message', 'BackupChunk 一条转录', 1, 'session-backup');

  const file = backupPathOf(app, 'backup-full.json');
  const exported = await app.call('memory_export', { path: path.basename(file) });
  assert.ok(existsSync(file));
  assert.equal(exported.value.counts.notes, 2, 'audit export keeps the tombstone');
  assert.equal(exported.value.counts.chunks, 1);

  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.format, 'omni-memory-backup');
  assert.equal(snapshot.schema, app.mod.SCHEMA_VERSION);
  assert.ok(snapshot.notes.some(note => note.id === active.value.id && note.deleted_at === null));
  assert.ok(snapshot.notes.some(note => note.id === gone.value.id && note.deleted_at !== null));

  const activeOnly = backupPathOf(app, 'backup-active.json');
  const trimmed = await app.call('memory_export', { path: path.basename(activeOnly), activeOnly: true });
  assert.equal(trimmed.value.counts.notes, 1);
  const trimmedSnapshot = JSON.parse(readFileSync(activeOnly, 'utf8'));
  assert.ok(trimmedSnapshot.notes.every(note => note.deleted_at === null));
});

test('export route returns the snapshot and an attachment header on download', async () => {
  const app = await boot();
  await app.call('memory_write', { kind: 'note', scope: 'global', text: 'RouteExport 结论' });

  const plain = fakeRes();
  await app.route('/omni-memory/export').handler(fakeReq('/omni-memory/export'), plain.res);
  assert.equal(plain.state.statusCode, 200);
  assert.equal(plain.json().counts.notes, 1);

  const download = fakeRes();
  await app.route('/omni-memory/export').handler(fakeReq('/omni-memory/export?download=1'), download.res);
  assert.match(download.state.headers['content-disposition'] ?? '', /attachment/);
});

test('import is a dry run by default and dedupes on a second pass', async () => {
  const source = await boot();
  await source.call('memory_write', { kind: 'note', scope: 'global', text: 'ImportNote 一条要迁移的结论' });
  await source.call('memory_write', {
    kind: 'fact', scope: 'global', text: 'ImportEntity 状态 旧值', subject: 'ImportEntity', relation: '状态', object: '旧值',
  });
  source.fire('user/message', 'ImportChunk 一条要迁移的转录', 1, 'session-import');
  const file = backupPathOf(source, 'backup.json');
  await source.call('memory_export', { path: path.basename(file) });

  const target = await boot();
  const shared = copyBackup(source, target, 'backup.json');
  const dry = await target.call('memory_import', { path: path.basename(shared) });
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.notes, 1);
  assert.equal(dry.value.facts, 1);
  assert.equal(dry.value.chunks, 1);

  const dbBefore = dbOf(target.home);
  assert.equal(dbBefore.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
  dbBefore.close();

  const applied = await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  assert.equal(applied.value.dryRun, false);
  assert.equal(applied.value.notes, 1);

  const hits = await target.call('memory_search', { query: 'ImportNote', scope: 'all' });
  assert.ok(hits.value.hits.some(hit => hit.kind === 'note' && hit.text.includes('ImportNote')));

  const again = await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  assert.equal(again.value.skipped >= 2, true, 'a second import must skip existing rows');
});

test('export and import keep pending candidates', async () => {
  const source = await boot();
  await source.call('memory_ingest', {
    text: '记住：备份候选必须能恢复。',
    role: 'user',
    scope: 'global',
  });
  const file = backupPathOf(source, 'candidates.json');
  const exported = await source.call('memory_export', { path: path.basename(file) });
  assert.equal(exported.value.counts.candidates, 1);
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.candidates.length, 1);

  const target = await boot();
  const shared = copyBackup(source, target, 'candidates.json');
  const dry = await target.call('memory_import', { path: path.basename(shared) });
  assert.equal(dry.value.candidates, 1);

  await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  const listed = await target.call('memory_candidate', { action: 'list', status: 'all', scope: 'all' });
  assert.ok(listed.value.candidates.some(candidate => candidate.text.includes('备份候选')));

  const accepted = await target.call('memory_candidate', {
    action: 'accept',
    id: listed.value.candidates.find(candidate => candidate.text.includes('备份候选')).id,
  });
  assert.equal(accepted.value.status, 'accepted');

  await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  const after = await target.call('memory_candidate', { action: 'list', status: 'all', scope: 'all' });
  assert.equal(
    after.value.candidates.filter(candidate => candidate.status === 'pending' && candidate.text.includes('备份候选')).length,
    0,
    're-importing a stale pending snapshot must not revive a reviewed candidate',
  );
});

test('import remaps superseded_by pointers instead of keeping stale ids', async () => {
  const source = await boot();
  const oldNote = await source.call('memory_write', { kind: 'note', scope: 'global', text: 'LineageOld 旧结论' });
  const newNote = await source.call('memory_write', { kind: 'note', scope: 'global', text: 'LineageNew 新结论' });
  const db = dbOf(source.home);
  db.prepare('UPDATE notes SET superseded_by = ? WHERE id = ?').run(newNote.value.id, oldNote.value.id);
  db.close();

  const file = backupPathOf(source, 'lineage.json');
  await source.call('memory_export', { path: path.basename(file) });

  const target = await boot();
  const shared = copyBackup(source, target, 'lineage.json');
  await target.call('memory_import', { path: path.basename(shared), dryRun: false });
  const targetDb = dbOf(target.home);
  const imported = targetDb.prepare("SELECT id, text, superseded_by FROM notes ORDER BY id").all();
  targetDb.close();
  const oldRow = imported.find(row => row.text.includes('LineageOld'));
  const newRow = imported.find(row => row.text.includes('LineageNew'));
  assert.ok(oldRow && newRow);
  assert.equal(oldRow.superseded_by, newRow.id, 'pointer must target the imported replacement');
});

test('restore revives a tombstoned note and makes it searchable again', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'RestoreMe 恢复后应可搜索' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });

  const hidden = await app.call('memory_search', { query: 'RestoreMe', scope: 'all' });
  assert.equal(hidden.value.hits.filter(hit => hit.kind === 'note').length, 0);

  const restored = await app.call('memory_restore', { kind: 'note', id: written.value.id });
  assert.equal(restored.value.restored, true);

  const visible = await app.call('memory_search', { query: 'RestoreMe', scope: 'all' });
  assert.ok(visible.value.hits.some(hit => hit.kind === 'note' && hit.id === written.value.id));
});

test('restore route is POST-only and needs the CSRF header', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'RestoreRoute 结论' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });

  const get = fakeRes();
  await app.route('/omni-memory/restore').handler(
    fakeReq(`/omni-memory/restore?kind=note&id=${written.value.id}`), get.res,
  );
  assert.equal(get.state.statusCode, 405);

  const missing = fakeRes();
  await app.route('/omni-memory/restore').handler(
    { ...postWithCsrf(`/omni-memory/restore?kind=note&id=${written.value.id}`), headers: {} }, missing.res,
  );
  assert.equal(missing.state.statusCode, 403);

  const ok = fakeRes();
  await app.route('/omni-memory/restore').handler(
    postWithCsrf(`/omni-memory/restore?kind=note&id=${written.value.id}`), ok.res,
  );
  assert.equal(ok.state.statusCode, 200);
  assert.equal(ok.json().restored, true);
});

test('audit list exposes tombstones for the restore UI', async () => {
  const app = await boot();
  const written = await app.call('memory_write', { kind: 'note', scope: 'global', text: 'AuditTomb 删除后仅审计可见' });
  await app.call('memory_forget', { kind: 'note', id: written.value.id });

  const live = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=20'), live.res);
  assert.equal(live.json().notes.some(note => note.id === written.value.id), false);

  const audit = fakeRes();
  await app.route('/omni-memory/list').handler(fakeReq('/omni-memory/list?limit=20&audit=1'), audit.res);
  const row = audit.json().notes.find(note => note.id === written.value.id);
  assert.ok(row, 'audit view must show the tombstone');
  assert.ok(row.deleted_at, 'tombstone row must carry deleted_at');
});
