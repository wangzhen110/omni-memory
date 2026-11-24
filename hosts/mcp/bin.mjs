// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * omni-mcp — the standalone MCP entry point (stdio).
 *
 * Startup order matters: the store path is resolved when index.js is imported,
 * so the environment has to be settled before bootHost runs. Nothing is written
 * to stdout except protocol frames; all logging goes to stderr.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// node:sqlite still emits an ExperimentalWarning on Node 22/23. It is harmless,
// but every MCP client surfaces stderr as a "server error" banner, so keep it
// out of the log and let real warnings through.
process.removeAllListeners('warning');
process.on('warning', warning => {
  if (warning && warning.name !== 'ExperimentalWarning') {
    console.error(`[omni-mcp] ${warning.message ?? warning}`);
  }
});

const log = message => console.error(`[omni-mcp] ${message}`);

const workdir = path.resolve(process.env.OMNI_PROJECT_DIR || process.cwd());
const home = process.env.OMNI_HOME || process.env.DSH_HOME || path.join(homedir(), '.dsh');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const { bootHost } = await import('../shared/boot.mjs');
const { serveStdio } = await import('./server.mjs');
const { RULES_TEXT } = await import('../shared/rules.mjs');

const { host, project, sessionId, toolContext } = await bootHost({
  workdir,
  sessionId: process.env.OMNI_SESSION_ID,
});

log(`store ${path.join(home, 'memory', 'omni.db')} · project ${project ?? 'global'} · ${host.tools.size()} tools · session ${sessionId}`);

const instructions = [
  '全息记忆 (Omni memory) — 本地长期记忆服务，数据全部存放在 SQLite。',
  '开始任务前先调用 memory_context（带上用户原始请求或当前报错），拿到画像与相关记忆；',
  '遇到报错先 memory_search 用 problemKey 查已沉淀解法，没有命中再向外部求助；',
  '解决后用 memory_write 沉淀「症状 / 失败尝试 / 有效解法 / 前提条件」，带 problemKey 与 solutionStatus。',
  '完整规则：prompts/get name=omni-bootstrap，或 resources/read uri=omni://rules，或调用 memory_rules。',
].join('\n');

const server = serveStdio({
  host,
  toolContext,
  serverInfo: { name: 'omni-memory', version: pkg.version },
  instructions,
  rulesText: RULES_TEXT,
  log,
});

const shutdown = () => {
  try { host.dispose(); } catch { /* best effort */ }
};

process.on('exit', shutdown);

await server.closed;
await server.stop();
shutdown();
