# 4.6.15 完成报告 — 早退预检、facts 计费与契约对齐（2026-11-27）

## 1. 版本定位

4.6.15 回应 4.6.14 复核汇编的 2 条 P1（均为“契约声明失实”）与 7 条 P2。
不改 schema（仍为 20），预算仍 1200，不动检索权重；`memory_profile` **输入签名不变**，
输出在 4.6.14 已新增 `included`（本版只补 schema 与文档口径）。

## 2. 根因与修法

### 复核项 P1-01：早退预检只看首条，短条目被超长首条带走

- 旧：`addSection` 的整节预检 `cheapestRowCost` 只取 `items[0]`。实测：全局锚点 1162 字占满后，
  项目节首条 2005 字（指针 34 字放不下）、次条 12 字短规则本可容纳，但整节被早退，短规则既不渲染也不进文本。
- 新：`cheapestRowCost` 对**全体条目**取 `1 + min(正文, 指针)` 的最小值；能开标题就进入逐条循环。
  新增“超长首条 + 可容纳短次条”（短规则渲染、超长条 `pointer:false`）与“整节连标题都打不开”
  两条仓库内回归用例。

### 复核项 P1-02：`included` 的“公开 API 可验证”声明失实

- 事实：MCP `tools/call` 只回渲染文本，`output.schema` 只声明 `text/stats`；HTTP `/omni-memory/tool`
  与 CLI `--json` 才回完整 `value`。
- 修法（选最小改动）：`output.schema` 补 `picked/budget/budgetUsed/included/omitted`；
  文档收窄为“完整字段在 HTTP 与 CLI，MCP 仅文本”，不扩张 MCP 契约（结构化返回排 4.7.0）。

### P2 收口

- **P2-03 facts 漏计 `- `**：`profileFactLines` 成本改 `正文 + 3`（`- ` 两字符 + 分隔符）；
  `buildProfileText` 先预检“标题 + 第一条事实”再写 `相关事实：`，`capProfileLines` 也会剥掉孤立标题。
- **P2-07 `cachedProfile` 全吞异常**：`catch` 打印 `projectKey` 与错误到 stderr，保留上次可用文本，不再缓存空串。
- **P2-04 早退分支无回归**：两条新用例覆盖 early-heading/early-pointer；烟测白名单抽成
  `isPathLikeImportError()` 并加表驱动测试（5 个路径类错误码 + `Cannot find` 文案 + `TypeError` 不降级）。
- **P2-01 包数过期**：统一为 `238 → 210`（4.6.14 干净 HEAD；工作树含未跟踪报告时 212），删掉 208 旧口径。
- **P2-02 838 残留**：4.6.13 条目改标“历史无落证值，4.6.15 撤销”，不再解释为“4 位 id 定值”。
- **P2-05/08/09/10/11/12**：`included` 明确为 number 数组（`omitted` 为对象数组）；
  同一 `P1-01` 编号加限定词（复核项/基线）；改“输入签名不变、输出新增 included”；
  本报告重编号并写明六条契约；包排除表述收窄（`WEB-UI-*` 未覆盖小写 preview、`COMPLETION-*` 仍在包内）；
  VM 复跑与最终 HEAD 的时序注明“测试在发布提交，随后 reset 到仅含文档的最终 HEAD”。

## 3. 逐字证据（`docs/evidence/4.6.15.json`）

```
564 tests / 564 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 113964.0819
# 10k rows: seed=487ms p95=46.9ms max=49.1ms hitTotal=200 total=1531ms
# 100k rows: seed=5282ms p95=65.6ms max=73.2ms hitTotal=200 total=6795ms
# 1000-file cold 196ms · warm 127ms · budget 2000ms
```

单文件：`node --test test/global-budget-4.6.12.test.mjs` 7/7；`node --test test/install-smoke.test.mjs` 2/2。

## 4. 判定标准

- 超长首条 + 可容纳短次条：短条目必须渲染，超长条进 `omitted{pointer:false}`，`picked` 计实测行数。
- facts：不出现孤立 `相关事实：`；超限事实跳过而不是终止。
- `memory_profile` schema 与文档一致：结构化字段只在 HTTP/CLI 取到，MCP 仅文本。
- 只有路径/解析类导入错误允许降级到 MCP。
- 不改 schema、预算仍 1200、输入签名不变。

## 5. 设计契约（六条）

1. **不饿死**：条目放不下时继续扫描；整节预检按全体条目的最小成本，不得只看首条。
2. **留指针**：放不下的长 note 留 `- note#<id> 超长已省略（memory_search 取回）`，指针计入预算。
3. **按拼接总长计**：`budgetUsed === text.length`；首行不付分隔符，之后每行计 1 个 `\n`（n 行共 n−1 个）；
   facts 按 `正文 + 3`。
4. **`omitted` 契约**：只承诺被裁的 **note 条目**；facts/标题无 id 不入；整节打不开时逐条记 `{pointer:false}`。
5. **`picked` 口径**：`- ` 开头行数（含指针行），测试按定值断言。
6. **可观测范围**：完整字段在 HTTP `/omni-memory/tool` 与 CLI `--json`；MCP `tools/call` 仅渲染文本。

## 6. 未纳入本轮（目标 4.7.0）

- **基线 P1-01**（`scope=project` 语义与跨项目记忆泄漏，按数据隔离定级）、P1-06、P1-08（evidence 增 `head`、
  只对最新版本强制）、失败语义、并发阻塞、发布边界、剩余 P2。
- MCP `structuredContent` 扩张、P2-11 里未覆盖的精确排除规则（`COMPLETION-*`、`REVIEW-*`、覆盖率报告）
  会改变包哈希，排 4.7.0。
