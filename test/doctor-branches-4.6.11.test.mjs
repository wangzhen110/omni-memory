// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * `omni doctor` branch coverage. The command is the first thing a new install
 * runs, yet most of its branches (missing package, missing data dir, corrupt or
 * empty database, bad port, reachable-but-different service, strict mode) had
 * no test. Every case here builds its own throwaway repo/home so nothing
 * touches the developer's real memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runDoctor, formatDoctor } = await import('../hosts/shared/doctor.mjs');

const checkOf = (result, name) => result.checks.find(check => check.name === name);

test('doctor: missing repo metadata, missing data dir and skipped service checks', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'omni-doctor-repo-'));
  const home = mkdtempSync(path.join(tmpdir(), 'omni-doctor-home-'));
  try {
    const result = await runDoctor({ repo, home, port: false, task: false, strict: true });
    assert.equal(checkOf(result, 'repo').status, 'fail');
    assert.equal(checkOf(result, 'data-dir').status, 'warn');
    assert.equal(checkOf(result, 'database').status, 'warn');
    assert.equal(checkOf(result, 'semantic').status, 'warn');
    assert.equal(checkOf(result, 'http').status, 'ok');
    // On POSIX the launcher check returns a Windows-only warning before the
    // task:false skip applies, so the expected status differs by platform.
    assert.equal(checkOf(result, 'launcher').status, process.platform === 'win32' ? 'ok' : 'warn');
    assert.equal(checkOf(result, 'dsh-plugin').status, 'warn');
    assert.equal(result.counts.fail, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'fail');
    assert.equal(result.port, null);
    assert.equal(result.task, null);

    const text = formatDoctor(result);
    assert.match(text, /结果: 未通过（1 错误/);
    assert.match(text, /data-dir/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: invalid port fails and a healthy repo passes', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-doctor-home-'));
  try {
    mkdirSync(path.join(home, 'memory'));
    const bad = await runDoctor({ repo: root, home, port: 99999, task: false });
    assert.equal(checkOf(bad, 'http').status, 'fail');
    assert.match(checkOf(bad, 'http').detail, /invalid port: 99999/);
    assert.equal(checkOf(bad, 'repo').status, 'ok');
    assert.equal(checkOf(bad, 'semantic').status, 'ok');
    assert.equal(bad.version, JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8')).version);

    const pass = await runDoctor({ repo: root, home, port: false, task: false });
    assert.equal(pass.ok, true);
    assert.equal(pass.status, 'warn', 'database not created yet is only a warning');
    assert.equal(checkOf(pass, 'database').status, 'warn');
    assert.match(formatDoctor(pass), /警告不会阻止本地记忆内核运行/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctor: corrupt and empty databases fail loudly', async () => {
  for (const [name, prepare, expected] of [
    ['garbage bytes', file => writeFileSync(file, 'not a sqlite database at all'), /cannot read database read-only/],
    ['empty schema', file => { const db = new DatabaseSync(file); db.close(); }, /missing table: notes/],
  ]) {
    const home = mkdtempSync(path.join(tmpdir(), 'omni-doctor-db-'));
    try {
      mkdirSync(path.join(home, 'memory'));
      prepare(path.join(home, 'memory', 'omni.db'));
      const result = await runDoctor({ repo: root, home, port: false, task: false });
      assert.equal(checkOf(result, 'database').status, 'fail', name);
      assert.match(checkOf(result, 'database').detail, expected, name);
      assert.equal(result.ok, false, name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('doctor: reachable service with a different version is a warning', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-doctor-http-'));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, version: '9.9.9', tools: 30 }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const result = await runDoctor({ repo: root, home, port, task: false });
    assert.equal(checkOf(result, 'http').status, 'warn');
    assert.match(checkOf(result, 'http').detail, /running 9\.9\.9, package /);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
