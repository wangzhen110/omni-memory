// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Shared boot for every non-DSH adapter.
 *
 * All three entry points — MCP stdio, MCP/HTTP daemon, CLI — need the same
 * three things: a host context, the plugin applied to it, and a project layer
 * registered for the working directory. Doing that once here keeps the adapters
 * to their own transport code.
 *
 * Import order matters: `index.js` resolves the store path when it is evaluated,
 * so callers must finish setting the environment before calling `bootHost`.
 */

import path from 'node:path';

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function defaultSessionId(workdir) {
  return `host-${fnv1a(path.resolve(workdir))}`;
}

/**
 * @param {object} options
 * @param {string} [options.workdir]  directory whose name becomes the project layer
 * @param {string} [options.sessionId] stable scope id; defaults to a hash of workdir
 * @param {object} [options.services] extra host services (`llm`, `systemPrompt`, `webServer`)
 * @param {boolean} [options.attach=true] register the project layer (opens the store)
 */
export async function bootHost({ workdir = process.cwd(), sessionId, services = {}, attach = true } = {}) {
  const { apply, attachSession } = await import('../../index.js');
  const { createHost } = await import('./headless.mjs');
  const { makeContextTool } = await import('./context-tool.mjs');

  const resolvedWorkdir = path.resolve(workdir);
  const id = String(sessionId ?? '').trim() || defaultSessionId(resolvedWorkdir);

  const host = createHost({ services });
  apply(host.ctx);

  const project = attach ? attachSession(id, resolvedWorkdir) : null;
  if (attach) {
    const { makeRulesTool } = await import('./rules.mjs');
    host.ctx.tools.register(makeContextTool(host));
    host.ctx.tools.register(makeRulesTool());
  }

  const toolContext = {
    agent: { id },
    session: { id, cwd: resolvedWorkdir },
    scope: { id },
  };

  return { host, project, sessionId: id, workdir: resolvedWorkdir, toolContext };
}
