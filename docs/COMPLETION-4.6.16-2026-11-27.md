# 4.6.16 完成报告 — 循环内指针预留与契约口径收窄（2026-11-27）

## 1. 版本定位

4.6.16 回应 4.6.15 复核汇编的 2 条 P1 与 11 条 P2（去重后）。两条 P1 都成立：

- **复核项 P1-01（ENG-09）**：4.6.15 只修了“整节预检”，循环内仍按原序写 32 字指针，排在后面的短行被 `pointer:false` 淘汰；
- **复核项 P1-02（架构）**：4.6.15 把可验证范围写成“HTTP 与 CLI `--json`”，但 CLI 没有 `memory_profile` 命令。

本轮按主理人建议 A+A+A 执行：P1-01 改代码并补 L=1151 回归，P1-02 收窄 7 处文档，8 条文档类 P2 一并改，3 条代码类 P2 登记 4.7.0。不改 schema（仍为 20）、预算仍 1200、无公开形状变化。

## 2. 根因与修法

### 复核项 P1-01：循环内指针抢占短行额度

- 旧：`lib/profile.mjs` 的 `addSection` 预检已按全体条目取 min（4.6.15 修的），但循环里 `addLine(pointer)` 只看指针自己放不放得下。
  超长行先写 32 字指针占掉额度，后面 11 字的短行就只剩 `pointer:false`。
- 复现（自建探针，隔离库）：锚点到 `used=1146..1159`、节内先后为 2002 字超长行（新）与 11 字短行（旧）时，
  修复前 `short:false / hugePointer:true / included:[anchor] / omitted:[{pointer:true},{chars:11,pointer:false}]`；
  窗口外 L=1145（两行都装得下）与 L=1160（指针装不下）短行正常。连续取值确定性复现。
- 新：先算 `pendingCheapest`（同一行成本在剩余条目上的后缀最小值），写指针前要求
  `used + 指针成本 + 剩余最便宜行成本 <= 1200`；不满足就记 `pointer:false` 继续扫描。
  修复后 1146..1159 全部 `short:true`，`hugePointer:false`，`budgetUsed` 停在 1170–1181。

### 复核项 P1-02：`included` 的 CLI 那半仍失实

- 事实核验：`hosts/cli.mjs` 命令表无 `memory_profile`；`omni context --json` 序列化的是 `memory_context`
  （`hosts/shared/context-tool.mjs` 只返回 `text/hits/project/update`），内部虽调 `memory_profile` 但只取 `profile?.text`。
- 修法：文档收窄为“完整字段只在 HTTP `POST /omni-memory/tool` 可验证；CLI 与 MCP `tools/call` 仅文本”，
  涉及 `DESIGN.md` §5.1 与 §6.24、`CHANGELOG.md`、`COMPLETION-4.6.15`、`REMEDIATION-BACKLOG.md` 共 7 处。
  给 CLI 透传五字段会扩 `memory_context` 公开形状，与 MCP `structuredContent` 一并排 4.7.0。

### P2 收口（文档类 8 条）

- **#1 包数口径**：`238 → 210` 为 4.6.14 干净 HEAD；4.6.15 干净 HEAD 214、工作树 216；4.6.14 报告里的 `208` 加勘误行。
- **#2 4.6.14 快照**：双 `## 6`、“四条契约”、`BACKLOG` 838 时点三处，统一在该报告顶部加勘误段，不改历史正文。
- **#3 回归注释**：两条用例里的 1166/26/34 与实测 1165/27/32 不符，改成“标题 + 分隔符 + 正文”的逐项成本账。
- **#7 DESIGN §5.1**：`memory_profile` 出参补 `picked/budgetUsed/included/omitted`。
- **#8 P2-16 限定词**：汇总与完成报告统一写“P2-16（evidence 增 `head`、只对最新版本强制）”。
- **#9 VM SKIP 逐字**：4.6.15 汇总与完成报告里的 `...` 换成完整原始行。
- **#10 `vm.txt` 出处**：表头改标云主机路径与 reset commit `d1f9bd4`。
- **#11 838 时点**：统一为“自 4.6.14 起撤销”。

## 3. 逐字证据（`docs/evidence/4.6.16.json`）

```
565 tests / 565 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 115637.1554
# 10k rows: seed=494ms p95=64.1ms max=69.8ms hitTotal=200 total=1992ms
# 100k rows: seed=5473ms p95=79ms max=79.4ms hitTotal=200 total=7313ms
# 1000-file cold 285ms · warm 210ms · budget 2000ms
```

单文件：`node --test test/global-budget-4.6.12.test.mjs` **8/8**（新增 L=1151 窗口用例）。
变异核验：把预留项改回 0，该文件 7 pass / 1 fail，唯一失败即新用例。

## 4. 判定标准

- L=1146..1159 窗口内：短行必须渲染，超长行 `pointer:false` 且进 `omitted`。
- 窗口外：两行都装得下时指针照常写；指针装不下时短行仍渲染。
- `budgetUsed === text.length`、`<= 1200`；`picked` 计实测 `- ` 行数。
- 契约为“整节预检”和“循环分配”两道闸，缺一不可。
- 不改 schema、预算仍 1200、输入签名不变。

## 5. 设计契约（六条，`docs/DESIGN.md` §6.24）

1. **不饿死**：条目放不下时继续扫描；整节预检按全体条目最小成本，循环内写指针前还要为剩余最便宜行预留。
2. **留指针**：放不下的长 note 留 `- note#<id> 超长已省略（memory_search 取回）`，指针计入预算；但不得抢占后面短行的额度。
3. **按拼接总长计**：`budgetUsed === text.length`；首行不付分隔符，之后每行计 1 个 `\n`（n 行共 n−1 个）；facts 按 `正文 + 3`。
4. **`omitted` 契约**：只承诺被裁的 note 条目；facts/标题无 id 不入；整节打不开时逐条记 `{pointer:false}`。
5. **`picked` 口径**：`- ` 开头行数（含指针行），测试按定值断言。
6. **可观测范围**：完整字段只在 HTTP `/omni-memory/tool`；CLI `context --json` 与 MCP `tools/call` 仅文本。

## 6. 未纳入本轮（目标 4.7.0）

- 代码类 P2：`cachedProfile` 失败退避与 stack（ENG-11）、`omitted.items` 子字段声明（ENG-12）、烟测白名单显式 `SyntaxError -> false` 断言（ENG-14）。
- 透传 CLI 五字段（会扩 `memory_context` 公开形状）、MCP `structuredContent`。
- 基线 P1-01（`scope=project` 语义与跨项目记忆泄漏）、P1-06、P1-08（evidence 增 `head`、只对最新版本强制）、失败语义、并发阻塞、发布边界。

## 7. 包内容

`npm pack --dry-run` 干净 HEAD **218 files**：4.6.14 为 210、4.6.15 发布提交 214、4.6.15 最终 HEAD（含两份证据）216，本轮新增完成报告与 `4.6.16.json` 后为 218。
