# 4.6.12 完成报告 — 全局段预算饿死修复（2026-11-27）

## 1. 版本定位

4.6.12 是行为修复补丁：不改 schema（仍为 20），不动检索权重，只修“常驻画像”
全局段的预算分配缺陷，并补写入提示与可观测字段。

## 2. 根因（实测）

- `PROFILE_BUDGET = 1200` 字符，全局段与项目段共用，按 importance/time 顺序整条取舍。
- 生产库实测：note#1321（284 字）先入选，note#1320（1077 字）放不下；旧实现用
  `break` 跳出整段，导致其后的短规则全部丢失。当前全局段只留 1 条、只用 292/1200
  字符，908 字符额度空转。
- 排序与长 note 数量一变，段内容就无声变化，表现为“时有时无”。

## 3. 修复

1. `lib/profile.mjs`：放不下的条目改为继续扫描（`continue`），不再饿死后续短规则；
   放不下的长 note 在额度允许时留一条紧凑指针 `- note#<id> 超长已省略（memory_search 取回）`。
   facts 行同样改为跳过而不终止。
2. `memory_profile` 新增 `budgetUsed` 与 `omitted: [{id, chars, pointer}]`，保留
   `picked`/`budget`，可直接看到“留了哪些、省了哪些”。
3. `memory_write` 在 `scope=global` 且文本 > 400 字时返回非阻断
   `promptBudgetHint`，提示“头条 + 细则分层”，不拒绝写入。

## 4. 逐字证据（`docs/evidence/4.6.12.json`）

```
558 tests / 558 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 110932.5488
# 10k rows: seed=489ms p95=54.1ms max=55.9ms hitTotal=200 total=1750ms
# 100k rows: seed=5409ms p95=70.4ms max=73.3ms hitTotal=200 total=7020ms
# 1000-file cold 247ms · warm 154ms · budget 2000ms
```

## 5. 判定标准

- 同一库同一排序下，短规则不再被长规则连带丢弃；长规则至少留下指针。
- `budgetUsed ≤ 1200`；`omitted` 只包含真正放不下的条目；指针占位计入预算。
- 写入提示只提示、不阻断；短全局 note 不产生提示。
- 生产复测（装 4.6.12 后，`docs/evidence/4.6.12-install-release.txt`）：全局段
  `picked=3 / budgetUsed=598 / budget=1200 / omitted=[]`。复测时库已比根因测量时新增
  三条高优先级规则，排序头部被占满且均能整条放下，故未触发指针；模拟同一库同排序的
  修复前/后对照仍为 1 条 292 字符 → 6 条 1150 字符（`test/global-budget-4.6.12.test.mjs`
  固化该行为）。

## 6. 取舍

- **不调大 1200**：每轮注入成本线性上涨，且不解决长短条目互相饿死。
- **不截断长规则正文**：半句规则比指针更危险，统一用“指针 + search 取回”。
- **不新增配置项**：预算仍是常量，避免多一个可漂移的口径。
- 三层结构（偏好最简 / 头条常驻 / 细则 search）继续有效，本次只修分配缺陷。

## 7. 复现

```
npm test
node --test test/global-budget-4.6.12.test.mjs
```
