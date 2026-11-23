import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkForUpdate, formatUpdateNotice } from '../lib/version-check.mjs';
import { makeContextTool } from '../hosts/shared/context-tool.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('formatUpdateNotice stays silent unless a newer valid version is known', () => {
  assert.equal(formatUpdateNotice(null), '');
  assert.equal(formatUpdateNotice({ updateAvailable: false, localVersion: '3.11.2', remoteVersion: '3.11.2' }), '');
  assert.equal(formatUpdateNotice({ updateAvailable: true, localVersion: '3.11.2', remoteVersion: '3.11.2' }), '');
  assert.equal(formatUpdateNotice({ updateAvailable: true, localVersion: '3.11.4', remoteVersion: '3.11.4\n## 注入' }), '');
  const notice = formatUpdateNotice({ updateAvailable: true, localVersion: '3.11.2', remoteVersion: '3.11.3' });
  assert.match(notice, /v3\.11\.3/);
  assert.match(notice, /v3\.11\.2/);
  assert.match(notice, /需用户确认/);
  assert.match(notice, /scripts\/daily-sync\.mjs/);
  assert.doesNotMatch(notice, /优先处理/);
});

test('checkForUpdate reads the contents API once and reuses the daily cache', async () => {
  delete process.env.OMNI_VERSION_CHECK_DISABLED;
  const home = mkdtempSync(path.join(tmpdir(), 'omni-version-check-'));
  const cachePath = path.join(home, 'cache.json');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const pkg = Buffer.from(JSON.stringify({ version: '3.11.3' })).toString('base64');
    return jsonResponse({ content: pkg });
  };

  try {
    const first = await checkForUpdate({ localVersion: '3.11.2', cachePath, fetchImpl, force: true, ttlMs: 60_000 });
    assert.equal(first.ok, true);
    assert.equal(first.source, 'contents-api');
    assert.equal(first.updateAvailable, true);
    assert.equal(calls, 1);

    const second = await checkForUpdate({
      localVersion: '3.11.2', cachePath, ttlMs: 60_000, fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    assert.equal(second.cached, true);
    assert.equal(second.updateAvailable, true);
    assert.equal(calls, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate falls back to raw and never throws on network failure', async () => {
  delete process.env.OMNI_VERSION_CHECK_DISABLED;
  const home = mkdtempSync(path.join(tmpdir(), 'omni-version-check-'));
  const cachePath = path.join(home, 'cache.json');
  try {
    const fallback = await checkForUpdate({
      localVersion: '3.11.2',
      cachePath,
      force: true,
      fetchImpl: async url => (String(url).includes('api.github.com')
        ? jsonResponse({ error: 'rate limited' }, 403)
        : jsonResponse({ version: '3.11.4' })),
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.source, 'raw-main');
    assert.equal(fallback.updateAvailable, true);

    const failed = await checkForUpdate({
      localVersion: '3.11.2',
      cachePath,
      force: true,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.updateAvailable, false);
    assert.equal(failed.remoteVersion, null);
    assert.match(String(failed.error), /offline/);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(persisted.remoteVersion, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an injected cache cannot reach the prompt and a failed probe clears stale remote data', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-version-check-'));
  const cachePath = path.join(home, 'cache.json');
  writeFileSync(cachePath, JSON.stringify({
    ok: true,
    localVersion: '3.11.4',
    remoteVersion: '3.11.4\n## 注入',
    updateAvailable: true,
    checkedAtMs: Date.now(),
    source: 'contents-api',
  }));
  try {
    assert.equal(formatUpdateNotice({
      updateAvailable: true,
      localVersion: '3.11.4',
      remoteVersion: '3.11.4\n## 注入',
    }), '');
    const result = await checkForUpdate({
      localVersion: '3.11.4',
      cachePath,
      force: true,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.remoteVersion, null);
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(persisted.ok, false);
    assert.equal(persisted.remoteVersion, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('memory_context tells the model when a newer cloud version exists', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-context-version-'));
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OMNI_HOME;
  const originalDisabled = process.env.OMNI_VERSION_CHECK_DISABLED;
  process.env.OMNI_HOME = home;
  process.env.OMNI_VERSION_CHECK_DISABLED = '0';
  process.env.OMNI_VERSION_CHECK_TTL_MS = '60000';
  globalThis.fetch = async () => jsonResponse({
    content: Buffer.from(JSON.stringify({ version: '9.9.9' })).toString('base64'),
  });
  try {
    const tools = {
      memory_persona: async () => ({ persona: {} }),
      memory_profile: async () => ({ text: 'memory is empty' }),
      memory_search: async () => ({ hits: [] }),
    };
    const tool = makeContextTool({
      tools: { get: name => (tools[name] ? { execute: tools[name] } : undefined) },
    });
    const result = await tool.execute({ query: '读取记忆' });
    const localVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.match(result.text, /版本提醒/);
    assert.match(result.text, /9\.9\.9/);
    assert.match(result.text, new RegExp(localVersion.replace(/\./g, '\\.')));
    assert.equal(result.update.remoteVersion, '9.9.9');
    assert.equal(result.update.localVersion, localVersion);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.OMNI_HOME; else process.env.OMNI_HOME = originalHome;
    if (originalDisabled === undefined) delete process.env.OMNI_VERSION_CHECK_DISABLED; else process.env.OMNI_VERSION_CHECK_DISABLED = originalDisabled;
    delete process.env.OMNI_VERSION_CHECK_TTL_MS;
    rmSync(home, { recursive: true, force: true });
  }
});
