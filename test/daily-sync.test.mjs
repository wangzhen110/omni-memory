import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isNewerVersion,
  isSyncDue,
  localDateKey,
  parseVersion,
} from '../lib/daily-sync.mjs';

test('parseVersion accepts a leading v, prerelease and build metadata', () => {
  assert.deepEqual(parseVersion('v3.11.2'), { major: 3, minor: 11, patch: 2, prerelease: [] });
  assert.deepEqual(parseVersion('3.9.5'), { major: 3, minor: 9, patch: 5, prerelease: [] });
  assert.deepEqual(parseVersion('3.11.5-rc.1'), { major: 3, minor: 11, patch: 5, prerelease: ['rc', '1'] });
  assert.deepEqual(parseVersion('3.11.5+build.7'), { major: 3, minor: 11, patch: 5, prerelease: [] });
  assert.equal(parseVersion('v3.11'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('3.11.2.1'), null);
  assert.equal(parseVersion('3.11.2-'), null);
});

test('compareVersions compares numeric segments and prereleases, not strings', () => {
  assert.equal(compareVersions('3.9.5', '3.11.2'), -1);
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('v3.11.2', '3.11.2'), 0);
  assert.equal(compareVersions('3.11.5-rc.1', '3.11.5'), -1);
  assert.equal(compareVersions('3.11.5-rc.2', '3.11.5-rc.1'), 1);
  assert.equal(compareVersions('bad', '3.11.2'), null);
  assert.equal(isNewerVersion('3.11.2', '3.11.1'), true);
  assert.equal(isNewerVersion('3.11.1', '3.11.2'), false);
  assert.equal(isNewerVersion('3.11.5', '3.11.5-rc.1'), true);
});

test('daily gate uses the local calendar date and only blocks a repeat', () => {
  const lateLocal = new Date(2026, 10, 23, 23, 59, 59);
  assert.equal(localDateKey(lateLocal), '2026-11-23');
  assert.equal(isSyncDue({}, '2026-11-23'), true);
  assert.equal(isSyncDue({ lastCheckDate: '2026-11-22' }, '2026-11-23'), true);
  assert.equal(isSyncDue({ lastCheckDate: '2026-11-23' }, '2026-11-23'), false);
  assert.equal(isSyncDue({ date: '2026-11-23' }, '2026-11-23'), false);
});

test('a same-day failure never reopens the gate automatically', () => {
  const failed = {
    lastCheckDate: '2026-11-23',
    action: 'blocked-dirty',
    localVersion: '3.11.4',
    remoteVersion: '9.9.9',
    attemptsToday: 3,
  };
  // The update script must be run again only with an explicit --force.
  assert.equal(isSyncDue(failed, '2026-11-23'), false);
  assert.equal(isSyncDue(failed, '2026-11-24'), true);
});
