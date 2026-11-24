// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * The managed rule block is written by a hook that may run on every session
 * start. If it were not idempotent, it would rewrite the user's rule file forever
 * and produce an ever-growing diff. These tests pin that down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RULES_TEXT, managedBlock, applyManagedBlock } from '../hosts/shared/rules.mjs';

test('rules: writing the block twice leaves the file byte-identical', () => {
  const first = applyManagedBlock('').text;
  const second = applyManagedBlock(first).text;
  assert.equal(second, first);
  assert.equal(applyManagedBlock(first).changed, false);
});

test('rules: the block is appended after existing content, not over it', () => {
  const existing = '# 我的项目规则\n\n- 用中文回答\n';
  const result = applyManagedBlock(existing);
  assert.ok(result.text.startsWith(existing.trim()));
  assert.ok(result.text.includes('全息记忆使用规则'));
  assert.ok(result.text.indexOf('全息记忆使用规则') > result.text.indexOf('用中文回答'));
});

test('rules: an outdated block is replaced in place', () => {
  const stale = '# 项目规则\n\n<!-- omni-memory:rules v0 start · 旧版本 -->\n旧规则内容\n<!-- omni-memory:rules v0 end -->\n\n末尾内容\n';
  const result = applyManagedBlock(stale);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('旧规则内容'));
  assert.ok(result.text.includes('全息记忆使用规则'));
  assert.ok(result.text.includes('末尾内容'));
  assert.equal(result.text.match(/omni-memory:rules/g).length, 2);
});

test('rules: unpaired managed markers fail closed instead of swallowing prose', () => {
  assert.throws(
    () => applyManagedBlock('# 项目规则\n\n<!-- omni-memory:rules v3 start · 只有开头 -->\n用户写的规则\n'),
    /not paired/,
  );
  assert.throws(
    () => applyManagedBlock('# 项目规则\n\n用户写的规则\n<!-- omni-memory:rules v3 end -->\n'),
    /not paired/,
  );
});

test('rules: the exported text stays self-consistent', () => {
  assert.ok(RULES_TEXT.includes('memory_context'));
  assert.ok(RULES_TEXT.includes('memory_write'));
  assert.ok(RULES_TEXT.includes('problemKey'));
  assert.ok(managedBlock().includes(RULES_TEXT));
});
