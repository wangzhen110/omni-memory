// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Fixture for test/mcp-stdio-4.6.7.test.mjs: a real stdio MCP server around a
 * stub host, so the transport (frames, error replies, chain, shutdown) can be
 * driven from a parent process without a database.
 */
import { serveStdio } from '../../hosts/mcp/server.mjs';

const tools = new Map([
  ['ok', {
    name: 'ok',
    description: 'returns a value',
    execute: async (args) => ({ echoed: args?.value ?? null }),
  }],
  ['boom', {
    name: 'boom',
    description: 'always throws',
    execute: async () => { throw new Error('intentional failure'); },
  }],
]);

const host = {
  tools: {
    get: name => tools.get(name),
    list: () => [...tools.values()],
    size: () => tools.size,
  },
};

const server = serveStdio({
  host,
  toolContext: {},
  serverInfo: { name: 'omni-memory', version: 'test' },
  instructions: 'test rules',
  rulesText: 'test rules',
  log: message => console.error(`[harness] ${message}`),
});

await server.closed;
await server.stop();
