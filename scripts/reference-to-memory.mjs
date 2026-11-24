// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Sync the reference manual into the store as searchable notes.
 *
 * The point is not to duplicate a file — it is to make the manual answerable by
 * `memory_search` from any host, so a fresh session can find "how do I call
 * memory_write" without being handed a document. Each `##` section becomes one
 * note; long sections are split at paragraph boundaries so no note exceeds the
 * write limit.
 *
 * Idempotent through memory_write's own dedupe: unchanged text returns
 * `deduped: true` instead of inserting a second copy.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = path.join(ROOT, 'docs', 'REFERENCE.md');
const MAX_NOTE = 2800;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');

const source = readFileSync(DOC, 'utf8');
const version = (source.match(/版本\s*([0-9.]+)\s*·/) ?? [])[1] ?? 'unknown';

function sectionsOf(text) {
  const out = [];
  let current = { title: '概览', body: [] };

  for (const line of text.split('\n')) {
    if (/^##\s+/.test(line)) {
      out.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), body: [] };
    } else if (!/^#\s+/.test(line)) {
      current.body.push(line);
    }
  }
  out.push(current);

  return out
    .map(section => ({ title: section.title, body: section.body.join('\n').trim() }))
    .filter(section => section.body.length > 60);
}

function chunked(section) {
  if (section.body.length <= MAX_NOTE) return [{ ...section, part: null }];

  const paragraphs = section.body.split(/\n{2,}/);
  const chunks = [];
  let buffer = '';
  let index = 1;

  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length > MAX_NOTE && buffer) {
      chunks.push(buffer.trim());
      buffer = '';
    }
    buffer += paragraph + '\n\n';
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks.map((body, i) => ({ ...section, part: `${i + 1}/${chunks.length}`, body }));
}

function slug(title) {
  return title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
}

process.env.OMNI_HOME = process.env.OMNI_HOME || process.env.DSH_HOME || '';
// Empty string is falsy, so index.js falls back to ~/.dsh — which is exactly the
// same default this script would pick. Kept explicit so the intent is visible.

const { bootHost } = await import(pathToFileURL(path.join(ROOT, 'hosts', 'shared', 'boot.mjs')).href);
const booted = await bootHost({ workdir: ROOT });

const write = async (toolContext, argsForWrite) => {
  const def = booted.host.tools.get('memory_write');
  if (!def) throw new Error('memory_write is not registered');
  return def.execute(argsForWrite, toolContext);
};

const project = booted.project ?? 'global';
let created = 0;
let deduped = 0;
let failed = 0;
let retired = 0;

const writtenIds = [];
const catalog = [];

for (const section of sectionsOf(source).flatMap(chunked)) {
  const heading = section.part ? `${section.title}（${section.part}）` : section.title;
  const text = `全息记忆参考手册 v${version} · ${heading}\n\n${section.body}`;

  catalog.push(heading);

  if (dryRun) continue;

  try {
    const result = await write(booted.toolContext, {
      kind: 'note',
      text,
      scope: project,
      // Deliberately low: the manual must be *searchable*, not permanently
      // injected. At 0.8 the 1200-character profile budget would be filled by
      // reference sections instead of the user's actual standing rules.
      importance: 0.35,
      source: `docs/REFERENCE.md#${slug(section.title)}`,
    });
    if (result?.deduped) deduped += 1;
    else created += 1;
    if (result?.id) writtenIds.push(Number(result.id));
  } catch (err) {
    failed += 1;
    console.error(`[memory-sync] 写入失败 ${heading}: ${err?.message ?? err}`);
  }
}

if (!dryRun) {
  const index = [
    `全息记忆参考手册 v${version} · 目录`,
    '',
    '按章节沉淀，用 memory_search 定位：',
    ...catalog.map((title, i) => `${i + 1}. ${title}`),
    '',
    '完整原文：docs/REFERENCE.md',
  ].join('\n');

  try {
    const result = await write(booted.toolContext, {
      kind: 'note',
      text: index,
      scope: project,
      importance: 0.55,
      source: 'docs/REFERENCE.md#catalog',
    });
    if (result?.deduped) deduped += 1;
    else created += 1;
    if (result?.id) writtenIds.push(Number(result.id));
  } catch (err) {
    failed += 1;
    console.error(`[memory-sync] 写入失败 目录: ${err?.message ?? err}`);
  }

  // Retire notes from earlier versions of this manual. Without this, editing a
  // section leaves the old wording searchable forever and the store slowly fills
  // with contradictory documentation.
  const home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const db = new DatabaseSync(path.join(home, 'memory', 'omni.db'));
  const stale = db.prepare(
    "SELECT id FROM notes WHERE source LIKE 'docs/REFERENCE.md#%' AND deleted_at IS NULL"
  ).all().filter(row => !writtenIds.includes(Number(row.id)));
  db.close();

  const forget = booted.host.tools.get('memory_forget');
  for (const row of stale) {
    try {
      await forget.execute({ kind: 'note', id: Number(row.id) }, booted.toolContext);
      retired += 1;
    } catch (err) {
      console.error(`[memory-sync] 退役旧笔记 #${row.id} 失败: ${err?.message ?? err}`);
    }
  }

  const facts = [
    { subject: '全息记忆', relation: '代码位置', object: ROOT },
    { subject: '全息记忆', relation: '仓库', object: 'https://github.com/wangzhen110/omni-memory' },
    { subject: '全息记忆', relation: '接口手册', object: 'docs/REFERENCE.md' },
  ];

  for (const fact of facts) {
    try {
      await write(booted.toolContext, {
        kind: 'fact',
        text: `${fact.subject} ${fact.relation} ${fact.object}`,
        subject: fact.subject,
        relation: fact.relation,
        object: fact.object,
        scope: project,
        source: 'docs/REFERENCE.md',
      });
    } catch (err) {
      failed += 1;
      console.error(`[memory-sync] 写入失败 fact: ${err?.message ?? err}`);
    }
  }
}

console.log(JSON.stringify({ version, project, sections: catalog.length, created, deduped, retired, failed, dryRun }, null, 2));
booted.host.dispose();
