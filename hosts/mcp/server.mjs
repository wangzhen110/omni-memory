// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The MCP protocol core, transport-independent.
 *
 * Two transports use it: stdio (mcp/bin.mjs) and Streamable HTTP (http/server.mjs).
 * Keeping the method table here means a client sees exactly the same answers
 * whichever door it came in through.
 *
 * Protocol rules that matter:
 *  - a request has an id; a notification does not and never gets a reply
 *  - stdout carries protocol frames only; every log goes to stderr
 *  - errors use JSON-RPC codes, tool failures use `isError` inside the result
 */

import { createInterface } from 'node:readline';

const DEFAULT_PROTOCOL = '2025-06-18';const KNOWN_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

export const RULES_URI = 'omni://rules';

function okResult(id, result) { return { id, result }; }
function errorResult(id, code, message) { return { id, error: { code, message } }; }

export function createProtocol({ host, toolContext = {}, serverInfo, instructions = '', rulesText = '' }) {
  function renderedContent(def, args, value) {
    try {
      if (def.output && typeof def.output.render === 'function') {
        const rendered = def.output.render(args, value);
        if (Array.isArray(rendered) && rendered.length) {
          return rendered.map(block => (block && typeof block === 'object' && block.type === 'text')
            ? { type: 'text', text: String(block.text ?? '') }
            : { type: 'text', text: String(block ?? '') });
        }
        if (typeof rendered === 'string') return [{ type: 'text', text: rendered }];
      }
    } catch (err) {
      // Rendering is cosmetic; never let it swallow a successful tool call.
      console.error(`[omni] render failed for ${def.name}: ${err?.message ?? err}`);
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text: text ?? '' }];
  }

  async function callTool(name, args) {
    const def = host.tools.get(name);
    if (!def) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    try {
      const value = await def.execute(args ?? {}, toolContext);
      return { content: renderedContent(def, args ?? {}, value) };
    } catch (err) {
      return { content: [{ type: 'text', text: `error: ${err?.message ?? String(err)}` }], isError: true };
    }
  }

  function ruleMessages(task) {
    const parts = [rulesText];
    if (task && String(task).trim()) {
      parts.push(`\n---\n\n当前任务：${String(task).trim()}\n\n先调用 memory_context，把上面的任务原文作为 query 传进去。`);
    }
    return [{ role: 'user', content: { type: 'text', text: parts.join('\n') } }];
  }

  async function handle(message) {
    const { id, method, params } = message;
    // JSON-RPC notifications are messages WITHOUT an id member. `id: null` is a
    // legal request id, not a notification; treating it as one made ping hang.
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const isRequest = hasId && id !== undefined;
    const reply = result => (isRequest ? okResult(id, result) : null);
    const reject = (code, text) => (isRequest ? errorResult(id, code, text) : null);

    switch (method) {
      case 'initialize': {
        const requested = String(params?.protocolVersion ?? '');
        const protocolVersion = KNOWN_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
        return reply({
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo,
          instructions,
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({
          tools: host.tools.list().map(def => ({
            name: def.name,
            description: def.description ?? '',
            inputSchema: def.parameters ?? { type: 'object', properties: {} },
          })),
        });

      case 'tools/call': {
        const name = String(params?.name ?? '');
        if (!name) return reject(RPC.invalidParams, 'tools/call needs a name');
        return reply(await callTool(name, params?.arguments ?? {}));
      }

      case 'prompts/list':
        return reply({
          prompts: [{
            name: 'omni-bootstrap',
            title: '全息记忆 · 工作规则',
            description: '把长期记忆的使用规则和当前任务一起交给模型，客户端不支持自动注入时的首选做法。',
            arguments: [{
              name: 'task',
              description: '当前任务的原始描述；留空则只返回规则。',
              required: false,
            }],
          }],
        });

      case 'prompts/get': {
        const name = String(params?.name ?? '');
        if (name !== 'omni-bootstrap') return reject(RPC.invalidParams, `unknown prompt: ${name}`);
        return reply({
          description: '全息记忆工作规则',
          messages: ruleMessages(params?.arguments?.task),
        });
      }

      case 'resources/list':
        return reply({
          resources: [{
            uri: RULES_URI,
            name: 'Omni memory 工作规则',
            description: '何时读记忆、何时写记忆、怎么写才有效。',
            mimeType: 'text/markdown',
          }],
        });

      case 'resources/templates/list':
        return reply({ resourceTemplates: [] });

      case 'resources/read': {
        const uri = String(params?.uri ?? '');
        if (uri !== RULES_URI) return reject(RPC.invalidParams, `unknown resource: ${uri}`);
        return reply({
          contents: [{ uri: RULES_URI, mimeType: 'text/markdown', text: rulesText }],
        });
      }

      case 'logging/setLevel':
        return reply({});

      default:
        return isRequest ? errorResult(id, RPC.methodNotFound, `method not found: ${method}`) : null;
    }
  }

  return { handle, callTool };
}

/* ------------------------------------------------------------------ */
/* stdio transport                                                     */
/* ------------------------------------------------------------------ */

export function serveStdio({ host, toolContext = {}, serverInfo, instructions = '', rulesText = '', log = () => {} }) {
  const protocol = createProtocol({ host, toolContext, serverInfo, instructions, rulesText });

  const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

  const dispatch = async message => {
    const reply = await protocol.handle(message);
    if (reply) write({ jsonrpc: '2.0', ...reply });
  };

  let chain = Promise.resolve();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', line => {
    const raw = line.trim();
    if (!raw) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: RPC.parse, message: 'invalid JSON' } });
      return;
    }

    chain = chain.then(() => dispatch(message)).catch(err => {
      log(`dispatch failed: ${err?.message ?? err}`);
      if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined) {
        // Never echo the internal failure text to the client: the detail is in
        // the local log above, and a protocol client only needs the code.
        write({ jsonrpc: '2.0', id: message.id, error: { code: RPC.internal, message: 'internal error' } });
      }
    });
  });

  const closed = new Promise(resolve => {
    rl.on('close', resolve);
    process.stdin.on('end', resolve);
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });

  return {
    closed,
    async stop() {
      rl.close();
      await chain;
    },
  };
}
