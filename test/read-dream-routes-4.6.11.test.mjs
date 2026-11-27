// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Dream routes were the largest zero-coverage block in lib/read-routes.mjs
 * (996-1038). These cases drive them over the real standalone HTTP adapter so
 * method guards, noteId parsing, the store call and the replace/rollback pair
 * are all exercised, not just the library functions underneath.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('dream routes: replace/rollback round-trip and their refusals', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'omni-dream-routes-'));
  process.env.OMNI_HOME = home;
  process.env.OMNI_VERSION_CHECK_DISABLED = '1';
  process.env.OMNI_DISABLE_SEMANTIC = '1';

  const { startHttpServer } = await import('../hosts/http/server.mjs');
  const server = await startHttpServer({ workdir: root, port: 0, version: 'test', log: () => {} });
  const base = server.url;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omni-csrf': '1' },
    body: JSON.stringify(body ?? {}),
  });

  try {
    // A chunk whose source is the exact pointer the note will cite.
    const ingest = await (await post('/omni-memory/ingest', {
      text: '部署方式最终选择裸机进程方案，便于直接调进程',
      role: 'assistant',
      sessionId: 'route11',
      source: 'session:route11#1',
    })).json();
    assert.equal(ingest.ok, true, JSON.stringify(ingest));

    const written = await (await post('/omni-memory/tool', {
      name: 'memory_write',
      arguments: {
        kind: 'note',
        text: '部署方式最终选择 Docker 容器方案',
        source: 'session:route11#1',
        scope: 'global',
        importance: 0.9,
      },
    })).json();
    assert.equal(written.ok, true, JSON.stringify(written));
    const noteId = Number(written.value.id);
    assert.ok(noteId > 0);

    const replaced = await (await post(`/omni-memory/dream/replace?noteId=${noteId}`, {})).json();
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.equal(replaced.oldId, noteId);
    assert.equal(typeof replaced.replacementId, 'number');

    const rolled = await (await post(`/omni-memory/dream/rollback?noteId=${noteId}`, {})).json();
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    assert.equal(rolled.restored, true);

    const again = await (await post(`/omni-memory/dream/rollback?noteId=${noteId}`, {})).json();
    assert.equal(again.restored, false);
    assert.equal(again.reason, 'not superseded');

    // A missing / already-dreamed note is a 400 with the store's own message.
    const missing = await post('/omni-memory/dream/replace?noteId=99999999', {});
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.match(missingBody.error, /note not found/);

    // No noteId anywhere is rejected before touching the store.
    const noId = await post('/omni-memory/dream/replace', {});
    assert.equal(noId.status, 400);
    assert.equal((await noId.json()).error, 'noteId required');

    // Method guard on both mutating routes.
    for (const route of ['/omni-memory/dream/replace', '/omni-memory/dream/rollback']) {
      const response = await fetch(`${base}${route}?noteId=1`);
      assert.equal(response.status, 405);
      assert.match((await response.json()).error, /requires POST/);
    }

    // Proposals list is readable and empty on a fresh store.
    const proposals = await (await fetch(`${base}/omni-memory/dream/proposals`)).json();
    assert.equal(proposals.ok, true);
    assert.ok(Array.isArray(proposals.proposals ?? proposals.value ?? proposals.items ?? proposals));

    // scope=all takes the cross-scope audit path instead of the project filter.
    const allScope = await post(`/omni-memory/dream/rollback?noteId=${noteId}&scope=all`, {});
    assert.equal(allScope.status, 200);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
