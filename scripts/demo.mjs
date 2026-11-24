#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * 60-second local demo.
 *
 * Boots an isolated memory in a temp directory, writes a note and a fact,
 * recalls it, and prints the result. No network, no real ~/.dsh, no service.
 * This is the fastest way to see what the storage and retrieval layers do
 * before installing anything.
 */
import { boot } from '../test/helpers.mjs';

const app = await boot({ semantic: false });
try {
  const note = await app.call('memory_write', {
    kind: 'note',
    text: 'Release-verified installs must fail closed: verify the Ed25519 manifest, require the signed commit, and reject a dirty working tree before touching the launcher.',
    scope: 'global',
    importance: 0.8,
    source: 'demo',
    problemKey: 'release verification fails open',
    solutionStatus: 'verified',
  });
  const fact = await app.call('memory_write', {
    kind: 'fact',
    subject: 'Omni Memory',
    relation: 'license',
    object: 'AGPL-3.0-only',
    scope: 'global',
    source: 'demo',
  });
  const recall = await app.call('memory_search', {
    query: 'release verification Ed25519 manifest',
    kind: 'all',
    limit: 5,
  });

  console.log('全息记忆 · 60 秒本地演示');
  console.log(`写入 note #${note.value.id}`);
  console.log(`写入 fact #${fact.value.id}`);
  console.log('');
  console.log('召回:');
  console.log(recall.text.split('\n').slice(0, 12).join('\n'));
  console.log('');
  console.log('这是隔离的临时数据库；删除进程后不留痕。真实安装见 docs/QUICKSTART.md。');
} finally {
  try { app.mod.openStore().db.close(); } catch { /* already closed */ }
}
