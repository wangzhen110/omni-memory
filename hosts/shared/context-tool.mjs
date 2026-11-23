// SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * `memory_context` — the bootstrap call.
 *
 * Inside DSH the plugin can inject a profile block into the system prompt, so the
 * model starts every turn already knowing what it knows. MCP has no such hook:
 * the server cannot write into the client's prompt. The honest substitute is one
 * tool the client is told (via server `instructions` and its own description) to
 * call before starting work, which returns the same thing the DSH section would
 * have injected: the stable profile plus whatever matches the task at hand.
 *
 * This is adapter-level code, not core. It composes two existing tools and adds
 * no new storage semantics. It also performs the cached read-path version probe,
 * so a newer cloud checkout is reported to the model before it starts work.
 */

import { checkForUpdate, formatUpdateNotice } from '../../lib/version-check.mjs';

const CONTEXT_BUDGET = 1800;

export function makeContextTool(host) {
  const run = async (name, args, toolContext) => {
    const def = host.tools.get(name);
    if (!def || typeof def.execute !== 'function') return null;
    try {
      return await def.execute(args, toolContext);
    } catch {
      return null;
    }
  };

  return {
    name: 'memory_context',
    description: 'Call this first, before any other memory tool: returns the standing user profile and the stored memories most relevant to the current task in one shot.',

    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'What the current task is about — the user request verbatim, an error message, a file path. Omit on the very first call of a session to get the profile alone.',
        },
        scope: {
          type: 'string',
          description: "Optional layer: a project scope, 'global', or 'all'. Omit to use the working directory's project layer plus global rules.",
        },
        limit: { type: 'number', description: 'Maximum recalled memories, default 5, max 10.' },
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          hits: { type: 'number' },
          update: { type: ['object', 'null'], additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },

    async execute(args = {}, toolContext = {}) {
      const versionPromise = checkForUpdate().catch(() => null);
      const limit = Math.min(10, Math.max(1, Number.isFinite(args.limit) ? Number(args.limit) : 5));
      const profileArgs = args.scope ? { scope: args.scope } : {};
      const persona = await run('memory_persona', { action: 'get' }, toolContext);
      const profile = await run('memory_profile', profileArgs, toolContext);

      const query = String(args.query ?? '').trim();
      const searchArgs = { query, limit, kind: 'all' };
      if (args.scope) searchArgs.scope = args.scope;
      const search = query ? await run('memory_search', searchArgs, toolContext) : null;
      const version = await versionPromise;
      const notice = formatUpdateNotice(version);

      const sections = [];
      if (notice) sections.push(notice);

      if (!persona || !Object.keys(persona.persona ?? {}).length) {
        // No explicit settings yet; the profile below still carries the gist.
      } else {
        sections.push('## 用户设定\n' + Object.entries(persona.persona)
          .map(([key, text]) => `- ${key}：${text}`)
          .join('\n'));
      }

      const profileText = String(profile?.text ?? '').trim();
      if (profileText && profileText !== 'memory is empty') {
        sections.push('## 常驻画像\n' + profileText);
      }

      const hits = Array.isArray(search?.hits) ? search.hits : [];
      if (hits.length) {
        const lines = hits.map(hit => {
          const layer = hit.scope && hit.scope !== 'global' ? ` · ${hit.scope}` : '';
          const flag = hit.contested ? ' · contested' : '';
          const status = hit.solutionStatus && hit.solutionStatus !== 'unverified' ? ` · ${hit.solutionStatus}` : '';
          const text = String(hit.text ?? '').replace(/\s+/g, ' ').slice(0, 220);
          return `- [${hit.kind}#${hit.id}] ${text}${layer}${status}${flag}`;
        });
        sections.push('## 与当前任务相关\n' + lines.join('\n'));
      }

      if (!sections.length) {
        return {
          text: '长期记忆为空。这是第一次使用：先正常干活，值得留下的结论再用 memory_write 写入。',
          hits: 0,
          update: version?.updateAvailable ? {
            localVersion: version.localVersion,
            remoteVersion: version.remoteVersion,
            checkedAt: version.checkedAt,
            source: version.source,
          } : null,
        };
      }

      sections.push('以上内容可能过时。涉及删除、覆盖、外部发送等不可逆动作前，先 memory_search 复核。');

      let text = sections.join('\n\n');
      if (text.length > CONTEXT_BUDGET) text = text.slice(0, CONTEXT_BUDGET);

      return {
        text,
        hits: hits.length,
        update: version?.updateAvailable ? {
          localVersion: version.localVersion,
          remoteVersion: version.remoteVersion,
          checkedAt: version.checkedAt,
          source: version.source,
        } : null,
      };
    },
  };
}
