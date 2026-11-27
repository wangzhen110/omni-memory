# 4.6.14 完成报告 — 画像整节丢弃与残留 P2（2026-11-27）

## 1. 版本定位

4.6.14 是 4.6.13 复核汇编后的收口补丁：修掉唯一 P1 残留（`addSection` 早退整节静默丢弃），
并处理可低成本验证的 P2（事实行分隔符、`included`、烟测降级范围、包内容、文档口径）。
不改 schema（仍为 20），不动检索权重、1200 预算与公开工具签名。

## 2. 根因（实跑复现）

- `lib/profile.mjs` 的 `addSection` 在“标题 + 首条正文”放不下时直接 `return`，整节 note 消失，
  `omitted` 为空。隔离库探针：最新 2005 字笔记 + 两条 150 字短规则 → `text='' / picked=0 / omitted=[]`。
  基线 `d84cb1c` 即存在，非 4.6.13 新引入，但 4.6.13 的预检多计 1 字符使该路径更易触发。
- `profileFactLines` 同源：事实行不计 `\n`，超限用 `break`，后面的短事实被带走。
- `capProfileLines` 的 `onTrim` 在生产路径因 `addLine` 已保证 ≤1200 而不可达，缺少直接单测。
- `memory_profile` 计算了 `report.included` 却不返回；安装烟测对任何导入异常都无条件降级。

## 3. 修复

1. `addSection`：预检改为“标题 + min(首条正文, 首条指针)”；放得下标题就进入正常循环
   （超长条留指针并记 `omitted`）；连指针都放不下时逐条写 `{id,chars,pointer:false}` 再返回。
2. `profileFactLines`：成本 = 行长 + 1 个分隔符，超限 `continue`。
3. `memory_profile`：返回 `included`（仍在屏幕上的 note id）。
4. `install-smoke`：仅 `ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`/`ERR_UNSUPPORTED_DIR_IMPORT` 等
   路径类错误降级到 MCP，其它导入异常直接抛出。
5. `package.json`：排除过期内部报告，`npm pack` 238 → 208 files。

## 4. 逐字证据（`docs/evidence/4.6.14.json`）

```
561 tests / 561 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 113312.4851
# 10k rows: seed=502ms p95=56.1ms max=59.1ms hitTotal=200 total=1706ms
# 100k rows: seed=5319ms p95=65.1ms max=66.2ms hitTotal=200 total=6815ms
# 1000-file cold 277ms · warm 233ms · budget 2000ms
```

单文件：`node --test test/global-budget-4.6.12.test.mjs` 5/5；`node --test test/install-smoke.test.mjs` 1/1。

## 5. 判定标准

- 最新超长 note 不再导致整节消失：短规则仍渲染，超长条留指针并进 `omitted`。
- `omitted` 契约收窄为“被裁的 note 条目”；facts/标题无 id，不入 `omitted`。
- `budgetUsed === text.length`；`picked` ＝ `- ` 行数（含指针）。
- 只有路径/解析类导入错误允许降级到 MCP；其它打包缺陷必须失败。
- 不改 schema、不改公开签名、不动 1200 预算与 300ms 检索预算。

## 6. 本轮已处理的 P2

P2-03（契约收窄）、P2-05（分隔符口径）、P2-06（`capProfileLines` 直接单测）、P2-07（`included`）、
P2-08（烟测降级）、P2-09（事实行）、P2-10（去掉无落证 838）、P2-11（NFR-12 与日期）、
P2-12（“四条契约”与 BACKLOG 分栏措辞）、P2-13（3/598 标 4.6.12 历史口径）、P2-15（包排除）。

## 7. 未纳入本轮（目标 4.7.0）

P2-01/P2-02 的措辞修订随本报告落地；P2-14 的 4.6.13 原始 VM 留证不回填，改为 4.6.14 起留
`docs/evidence/4.6.14-vm.txt`；P2-16（evidence 增 `head`、只对最新版本强制）与 P1-08 同批排 4.7.0。
`scope=project` 语义与跨项目隔离（原 P1-01 系列）仍排 4.7.0，风险性质为“跨项目记忆泄漏”，
不只“可见结果变化”。
