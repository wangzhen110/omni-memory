// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The working rules, in one place.
 *
 * MCP cannot inject into a client's system prompt, so the rules have to travel
 * as text the client will actually read: a server instruction, a prompt the
 * user can pull in, a resource the model can open, a tool that returns it, and
 * a managed block written into the project's own rule file. Same string for all
 * five — one edit, no drift.
 */

export const RULE_VERSION = 1;

export const RULES_TEXT = [
  '# 全息记忆使用规则',
  '',
  '这是一个本地长期记忆服务。它不会自己变聪明，价值取决于你是否按下面的顺序用它。',
  '',
  '## 每次开始任务',
  '1. 先调用 `memory_context`，把用户的原始请求（或当前报错）作为 `query` 传进去。',
  '2. 读返回的「用户设定」和「常驻画像」：它们约束你用什么语言、什么风格、避开什么。',
  '3. 读「与当前任务相关」的条目：命中的结论优先于重新摸索；标注 contested 的不要直接依赖。',
  '',
  '## 遇到障碍',
  '1. 先用 `memory_search` 的 `problemKey` 精确查（错误码、失败的命令、规范化后的症状）。',
  '2. 再放宽到关键词查。',
  '3. 两条都没命中，才去查文档或全网搜索。',
  '4. 解决之后立刻用 `memory_write` 沉淀：`kind=note`，写清症状、试过但失败的路径、真正有效的解法、生效的前提条件；带上 `problemKey`，把 `solutionStatus` 记为 `verified` 或 `unverified`，`evidence` 填命令输出或测试结果。',
  '',
  '## 什么时候该写',
  '- 会跨会话复用的结论：项目约定、环境配置、踩过的坑、别人的偏好。',
  '- 事实用 `kind=fact`，`subject/relation/object` 三段式；同一个 subject+relation 换了值，旧值会被自动失效，不要手动删。',
  '- 一次性、临时、能从代码或文件里直接读到的东西，不要写。',
  '- 每条都要能脱离当前对话独立成立：不要写「上面那个」「刚才说的」。',
  '',
  '## 什么时候不该写',
  '- 不要每轮都写。一次任务通常只沉淀 0–3 条真正有价值的结论。',
  '- 不要把用户的原话整段抄进来，转录层如果有宿主事件流会自己做。',
  '- 不确定是否成立的推测，标 `unverified`，不要伪装成 `verified`。',
  '',
  '## 分层',
  '- `global`：跨项目通用的规则、偏好、工具链事实。',
  '- `proj:<名>#<哈希>`：只属于当前项目目录的知识，默认就落在这一层。',
  '- 不要把一个项目的临时约定写成 global，那会污染所有项目。',
  '',
  '## 复核',
  '- 涉及删除、覆盖、对外发送、付费等不可逆动作前，先用 `memory_search` 确认记忆没有过时。',
  '- 发现记忆与当前事实冲突，用 `memory_write` 写新结论并在 `contradicts` 里填旧 id，不要默默绕过。',
].join('\n');

const MARK = 'omni-memory:rules';

/**
 * A tool that returns the rules, for clients that never open resources or
 * prompts. Same text as everything else.
 */
export function makeRulesTool() {
  return {
    name: 'memory_rules',
    description: 'Return the working rules for this memory service. Read them once per session when the client does not surface server instructions or resources.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      return { text: RULES_TEXT };
    },
  };
}

export function managedBlock(version = RULE_VERSION) {
  return [
    `<!-- ${MARK} v${version} start · 由全息记忆维护，区块内容会被覆盖，请勿手改 -->`,
    RULES_TEXT,
    `<!-- ${MARK} v${version} end -->`,
  ].join('\n');
}

/**
 * Insert or refresh the managed block in an existing rule file.
 *
 * Idempotent by design: writing the same block twice must leave the file
 * byte-identical, otherwise a hook that runs on every session start would
 * rewrite the user's file forever.
 */
export function applyManagedBlock(existing, version = RULE_VERSION) {
  const text = String(existing ?? '');
  const block = managedBlock(version);
  const startCount = (text.match(new RegExp(`<!-- ${MARK} v\\d+ start[^>]*-->`, 'g')) ?? []).length;
  const endCount = (text.match(new RegExp(`<!-- ${MARK} v\\d+ end -->`, 'g')) ?? []).length;

  // Fail closed on a hand-edited or interrupted file. Appending a second block
  // when one start marker has no end marker lets the next write swallow the
  // user's prose between the two blocks.
  if (startCount !== endCount || startCount > 1) {
    throw new Error(`managed rule markers are not paired (start=${startCount}, end=${endCount}); refusing to rewrite`);
  }

  const pattern = new RegExp(`<!-- ${MARK} v\\d+ start[^>]*-->[\\s\\S]*?<!-- ${MARK} v\\d+ end -->`);
  if (startCount === 1) {
    const next = text.replace(pattern, block);
    return { changed: next !== text, text: next };
  }

  const trimmed = text.replace(/\s+$/, '');
  return {
    changed: true,
    text: trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`,
  };
}
