# 4.6.13 完成报告 — 结构评审收口三项（2026-11-27）

## 1. 版本定位

4.6.13 是结构评审后的验收可信度补丁，只收三条：画像预算漏算换行（P1-02）、
`picked` 恒真断言（P1-15）、安装烟测断言被 `catch` 吞（P1-03）。不改 schema（仍为 20），
不动检索权重与公开工具签名，不调大 1200 预算。

## 2. 根因（实测）

- `lib/profile.mjs` 的 `addLine` 只累加 `line.length`，不计 `join('\n')` 的分隔符；
  `capProfileLines` 用“行合计”判超后再 `pop`，被 pop 的行不进 `omitted`。
  行合计 1199（5 + 398×3）被判可放，拼接后为 1202，末条被静默砍掉。
- `test/global-budget-4.6.12.test.mjs` 的 `picked` 断言与实现表达式同构（都数 `- ` 行），
  等于没断言。
- `test/install-smoke.test.mjs` 的三条断言在 `try` 内，失败会被 `catch` 当作
  “动态导入失败”降级；数值检查用 `typeof`，`NaN` 也能通过。

## 3. 修复

1. `lib/profile.mjs`：`capProfileLines(lines, owners, onTrim)` 带上每条 owner；
   `addLine`/`addSection` 成本按 `line.length + (lines.length ? 1 : 0)` 计；被裁条目
   经 `onTrim` 写入 `omitted`，`included` 按实际保留集过滤，指针放不下时 `pointer:false`。
2. `test/global-budget-4.6.12.test.mjs`：`picked` 改定值断言；新增边界用例——3 条各
   396 字的不同规则，断言 `budgetUsed === text.length ≤ 1200`、渲染 2 条 + 1 指针、
   `omitted` 恰含最老一条且 `pointer:true`。
3. `test/install-smoke.test.mjs`：`try` 只包 `await import(entry)`，断言移出并在
   `mod` 存在时执行；数值改用 `Number.isFinite`；两条路径分别 `t.diagnostic`。

## 4. 逐字证据（`docs/evidence/4.6.13.json`）

```
559 tests / 559 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 113294.0324
# 10k rows: seed=494ms p95=62.2ms max=63.6ms hitTotal=200 total=1817ms
# 100k rows: seed=5527ms p95=73.9ms max=80.1ms hitTotal=200 total=7254ms
# 1000-file cold 190ms · warm 152ms · budget 2000ms
```

## 5. 判定标准

- 预算按拼接后总长计：`budgetUsed === text.length`，任何被裁条目必进 `omitted`。
- `picked` 口径固定为“渲染文本里 `- ` 开头行数（含指针）”，测试按定值断言。
- 安装烟测：只有动态导入真失败才走 MCP 降级；`NaN`/`null` 不再放行。
- 不改 schema、不改公开签名、不动 1200 预算与 300ms 检索预算。

## 6. 未纳入本轮（4.7.0）

P1-01 `scope=project` 语义分裂、P1-06、P1-08 证据门禁新鲜度、失败语义
（P1-04/P1-05）、并发阻塞（P1-10~P1-14）、发布边界（P1-07/P1-09）与全部 P2，
按 `docs/REMEDIATION-BACKLOG.md` 的 4.6.13 / 4.7.0 分栏处理。
