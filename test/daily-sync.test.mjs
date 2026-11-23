import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isNewerVersion,
  isSyncDue,
  localDateKey,
  parseVersion,
  shouldRunSync,
} from '../lib/daily-sync.mjs';

test('parseVersion accepts a leading v and rejects non-semver', () => {
  assert.deepEqual(parseVersion('v3.11.2'), { major: 3, minor: 11, patch: 2 });
  assert.deepEqual(parseVersion('3.9.5'), { major: 3, minor: 9, patch: 5 });
  assert.equal(parseVersion('v3.11'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('3.11.2.1'), null);
});

test('compareVersions compares numeric segments, not strings', () => {
  assert.equal(compareVersions('3.9.5', '3.11.2'), -1);
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('v3.11.2', '3.11.2'), 0);
  assert.equal(compareVersions('bad', '3.11.2'), null);
  assert.equal(isNewerVersion('3.11.2', '3.11.1'), true);
  assert.equal(isNewerVersion('3.11.1', '3.11.2'), false);
});

test('daily gate uses the local calendar date and only blocks a repeat', () => {
  const lateLocal = new Date(2026, 10, 23, 23, 59, 59);
  assert.equal(localDateKey(lateLocal), '2026-11-23');
  assert.equal(isSyncDue({}, '2026-11-23'), true);
  assert.equal(isSyncDue({ lastCheckDate: '2026-11-22' }, '2026-11-23'), true);
  assert.equal(isSyncDue({ lastCheckDate: '2026-11-23' }, '2026-11-23'), false);
  assert.equal(isSyncDue({ date: '2026-11-23' }, '2026-11-23'), false);
  const sameDay = { lastCheckDate: '2026-11-23', localVersion: '3.11.2', remoteVersion: '3.11.2' };
  assert.equal(shouldRunSync(sameDay, '2026-11-23', { localVersion: '3.11.2', cachedRemoteVersion: '3.11.2' }), false);
  assert.equal(shouldRunSync(sameDay, '2026-11-23', { localVersion: '3.11.2', cachedRemoteVersion: '3.11.3' }), true);
  assert.equal(shouldRunSync({ lastCheckDate: '2026-11-22' }, '2026-11-23', { localVersion: '3.11.2' }), true);
});
