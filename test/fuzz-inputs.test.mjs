// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Fuzz the two surfaces that consume arbitrary untrusted strings with no
 * model in the loop: the MCP JSON-RPC dispatcher and the transcript
 * sentence splitter. Properties here assert absence of crashes and stable
 * output contracts over hundreds of adversarial inputs, not just examples.
 *
 * fast-check generates the inputs; no native instrumentation is needed, so
 * the runtime stays dependency-free. These are dev-only test dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { createProtocol, RPC } from '../hosts/mcp/server.mjs';
import {
  candidateSentences,
  extractCandidateTexts,
  MAX_CANDIDATES_PER_CHUNK,
} from '../lib/capture-rules.mjs';

const RUNS = 150;

// A minimal host: tool calls never touch a real store. Unknown tools return
// an isError result, which is exactly how the protocol treats untrusted names.
const host = {
  tools: {
    get: () => undefined,
    list: () => [],
  },
};
const protocol = createProtocol({
  host,
  serverInfo: { name: 'fuzz-probe', version: '0' },
  rulesText: 'rules',
});

const METHODS = [
  'initialize', 'ping', 'tools/list', 'tools/call', 'prompts/list',
  'prompts/get', 'resources/list', 'resources/templates/list',
  'resources/read', 'logging/setLevel', 'notifications/initialized',
  'notifications/cancelled', '__proto__', 'constructor', '', 'unknown.method',
];

// ---------------------------------------------------------------------------
// F1. The real stdio path is: JSON.parse(raw line) -> dispatch(message) inside
//     a .catch that logs and replies RPC.internal. Model that wrapper here:
//     no matter which JSON value arrives, the transport must never emit an
//     uncaught exception, and any emitted frame must be protocol-valid.
//     `handle` itself does not add `jsonrpc`; serveStdio's write() does.
// ---------------------------------------------------------------------------
async function dispatchLikeStdio(message) {
  let reply;
  try {
    reply = await protocol.handle(message);
  } catch (err) {
    reply = { id: null, error: { code: RPC.internal, message: String(err?.message ?? err) } };
  }
  // serveStdio's write() adds jsonrpc; a falsy reply (notification) is not sent.
  return reply ? { jsonrpc: '2.0', ...reply } : reply;
}

test('fuzz: MCP dispatcher survives arbitrary JSON-RPC values', async () => {
  const msgArb = fc.oneof(
    fc.record({
      jsonrpc: fc.constant('2.0'),
      id: fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
      method: fc.oneof(...METHODS.map(fc.constant)),
      params: fc.oneof(
        fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue({ maxDepth: 3 })),
        fc.array(fc.jsonValue({ maxDepth: 2 })),
        fc.string({ maxLength: 400 }),
        fc.constant(null),
      ),
    }),
    fc.jsonValue({ maxDepth: 3 }),
    fc.constant(null),
    fc.string({ maxLength: 200 }),
  );

  await fc.assert(
    fc.asyncProperty(msgArb, async (message) => {
      const frame = await dispatchLikeStdio(message);
      if (frame === null || frame === undefined) return; // notifications stay silent
      assert.equal(frame.jsonrpc, '2.0', 'every emitted frame is v2');
      assert.ok(Object.prototype.hasOwnProperty.call(frame, 'result') ||
                Object.prototype.hasOwnProperty.call(frame, 'error'), 'frame carries result or error');
      if (message && typeof message === 'object' && 'id' in message && frame.id !== null) {
        assert.equal(frame.id, message.id, 'reply echoes the request id');
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// F2. tools/call with a hostile name or params must be contained: an empty
//     name is invalidParams; an unknown name is an isError tool result. Neither
//     path may execute anything or throw. The name is attacker-controlled.
// ---------------------------------------------------------------------------
test('fuzz: tools/call with arbitrary names returns a contained result', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 120 }),
      fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.constant(null)),
      async (name, args) => {
        const reply = await dispatchLikeStdio({
          jsonrpc: '2.0', id: 7, method: 'tools/call',
          params: { name, arguments: args },
        });
        assert.equal(reply.id, 7);
        if (!String(name)) {
          assert.equal(reply.error?.code, RPC.invalidParams, 'empty name is invalidParams');
        } else {
          assert.equal(reply.error, undefined, 'unknown tool is not a JSON-RPC error');
          assert.equal(reply.result?.isError, true, 'unknown tool is an isError result');
        }
      },
    ),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// F3. The sentence splitter consumes raw transcript text. It must not throw,
//     must dedupe, and every emitted candidate must stay in the documented
//     8..400 window and exclude bare URLs / bare paths.
// ---------------------------------------------------------------------------
test('fuzz: candidateSentences holds its output contract', () => {
  const textArb = fc.oneof(
    fc.string({ maxLength: 2000 }),
    fc.string({ unit: fc.constantFrom('。', '！', '？', '.', '!', '?', '\n', '\r', '#', '>', '-', '*', ' '), maxLength: 600 }),
    fc.constantFrom(
      '', '   ', '```code```', 'https://example.com/a/b',
      '# heading\n- item\n1. step', '记住这个。 Always back up. Never skip.',
      'a'.repeat(10000),
      // Guaranteed-duplicate sentences so the dedup contract is actually
      // exercised (random text almost never repeats an eligible sentence).
      '务必每次部署前备份数据库配置。务必每次部署前备份数据库配置。务必每次部署前备份数据库配置。',
    ),
  );
  fc.assert(
    fc.property(textArb, (text) => {
      let out;
      assert.doesNotThrow(() => { out = candidateSentences(text); }, 'splitter must not throw');
      assert.ok(Array.isArray(out), 'returns an array');
      assert.equal(new Set(out).size, out.length, 'no duplicate candidates');
      for (const sentence of out) {
        assert.ok(sentence.length >= 8 && sentence.length <= 400, `length in 8..400, got ${sentence.length}`);
        assert.ok(!/^https?:\/\//i.test(sentence), 'bare URLs excluded');
        assert.ok(!/^[a-z0-9_\-./\\]+$/i.test(sentence), 'bare paths excluded');
        assert.equal(sentence, sentence.trim(), 'trimmed');
        assert.ok(!/\s{2,}/u.test(sentence), 'whitespace collapsed');
      }
    }),
    { numRuns: RUNS },
  );
});

// ---------------------------------------------------------------------------
// F4. Candidate extraction must ignore non-conversation roles, cap output,
//     and keep confidence in [0,1] for any text. Guards scoring regressions.
// ---------------------------------------------------------------------------
test('fuzz: extractCandidateTexts respects role, cap and score bounds', () => {
  const textArb = fc.oneof(
    fc.string({ maxLength: 1200 }),
    fc.constantFrom(
      '记住：默认用 node 24。务必备份数据库。'.repeat(20),
      'remember: always back up. must verify. never skip tests.'.repeat(20),
      '问题 错误 失败 步骤 配置 版本 路径 端口 命令 测试 部署 安装 升级 回滚',
    ),
  );
  fc.assert(
    fc.property(textArb, fc.oneof(fc.constant('user'), fc.constant('assistant'), fc.constant('tool'), fc.string({ maxLength: 10 })), (text, role) => {
      let out;
      assert.doesNotThrow(() => { out = extractCandidateTexts(text, role); }, 'extractor must not throw');
      assert.ok(Array.isArray(out));
      if (role !== 'user' && role !== 'assistant') {
        assert.equal(out.length, 0, 'non-conversation roles yield no candidates');
        return;
      }
      assert.ok(out.length <= MAX_CANDIDATES_PER_CHUNK, 'per-chunk cap respected');
      for (const candidate of out) {
        assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1, `confidence in [0,1], got ${candidate.confidence}`);
        assert.ok(candidate.text.length >= 8 && candidate.text.length <= 400);
      }
    }),
    { numRuns: RUNS },
  );
});
