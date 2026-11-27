# 全息记忆 4.6.18 完成报告（2026-11-27）

## 1 定位

本轮输入是 4.6.17 的外部复核（`CONSOLIDATED-REVIEW.md`，P0 0 / P1 5 / P2 13）。复核确认 4.6.17 的五处门槛都落在主路径上，但同时指出同类缺陷仍有确定性旁路：字符计数漏掉零宽/符号/组合符、门槛发生在 `SQL LIMIT` 之后、facts 允许空 object。三条都能把真规则挤出常驻画像，因此按裁决直接修，并把文档类 P2 随版改完；代码类 P2（门禁去重、TAP→evidence 绑定）排 4.7.0。

## 2 根因与修法

### 2.1 P1-01：内容字符计数漏 `Cf/S/M`

- 事实：旧实现 `filter(ch => !/\s|\p{P}|\p{Z}/u.test(ch))`。零宽空格（`Cf`）、ZWJ 家庭 emoji（`So`+`Cf`）、`★★★★`（`So`）、`￥￥￥￥`（`Sc`）都能过 2 字符写入门槛，也能过 4 字符画像门槛。
- 复核探针把纯符号串写进库后，画像前四行全是垃圾。
- 修法：只计 `[\p{L}\p{N}]`。`e` 加组合符算 1 个字母；emoji 家族算 0。
- 回归：`test/min-content-gate-4.6.17.test.mjs` 新增 6 个退化样本 + “3 个带组合符字母能写但进不了画像”。

### 2.2 P1-02：过滤晚于 `LIMIT`

- 事实：画像 `ORDER BY … LIMIT 60` 之后才做 `profileEligibleNote`；persona notes `LIMIT 40` 之后才过滤。
- 复核探针：真规则 importance 0.1 正常写入，再插 60 条内容字符为 3 的 `a00..a59`（过写入 2、过不了画像 4）→ `VERDICT=E02_REPRODUCED`，真规则消失、`included=[]`。
- 修法两层：SQL 侧先加 `length(trim(text)) >= 4` 预筛；JS 侧改分页循环（每页 60，`LIMIT ? OFFSET ?`），逐页做 scope 与 `profileEligibleNote` 过滤，凑够 60 条合格候选才进预算分配。persona notes 同样分页到 40 条合格。
- 代价：多读页数随垃圾比例线性上升；单页正文仍在内存，不会把整表载入。
- 回归：直接插入 60 条 3 字符行 + 1 条低 importance 真规则，断言真规则仍在、`included.length === 1`。

### 2.3 P1-03：facts 空 object

- 事实：facts 豁免文字门槛的理由是“正文可由三元组派生”，但旧实现只校验 `subject`；`relation` 默认 `is`，`object` 可空，渲染成 `- 空值实体 · is：` 并占预算。
- 修法：写侧 `memory_write` 的 fact 分支要求 `subject`/`relation`/`object` 都含至少 1 个内容字符，分别报 `subject is required…` / `relation is required…` / `object is required…`；画像侧 `profileFactLines` 跳过空 subject、空 object 或三元组总计 <4 内容字符的 legacy 行。
- 回归：空 object/relation 被拒；直接插入 legacy 空 object 行，断言画像不渲染。

### 2.4 P2-08：单复数与重复计数

`memory_write`、`memory_amend`、候选 accept 三处都先算 `const shortCount = contentCharCount(text)`，再按 `1 content character` / `n content characters` 拼串，不再在同一行调用两次。

## 3 文档类 P2

- **P1-04 生产复验落证**：新增 `docs/evidence/4.6.17-context.txt`，含命令、生产库路径、`db-sha256`、抓取时间与 `omni context` 全文；并在文件头写明这是 4.6.18 时的补采、不是安装当时输出。CHANGELOG 与 4.6.17 完成报告同步收窄为“画像无 `- x` 条目；note#1315 仍可搜”。
- **P1-05 包数**：干净快照 `git archive` + `npm pack --dry-run` 实测：发布提交 `7b8c0ad` = 220 items / 20,389,322 B；最终 HEAD `0dd49cd` = 222 items / 20,389,794 B；工作树 224 是多了两份未跟踪 preview。4.6.17 报告、CHANGELOG 与汇总按 220/222 修正。
- **P2-03/04/05/06 基准可证性**：`docs/BENCHMARKS.md` 标注 3.12.0 基线、补齐 `locomo10.json` 全量 SHA-256、把 mem0/Zep 数字换成有出处的写法并声明不可跨 harness 比较、§6 拆“已落地/待补”。顺带重跑并归档 4.6.18 的 session 与 turn 两档结果。
- **P2-07/12/13**：DESIGN 版本行与 §6.24 同步；COMPLETION-4.6.17 修正包数与证据清单；update-log 的 171 是记录数而非 commit 数，在汇总里写明口径。

## 4 证据（逐字取自 docs/evidence/4.6.18.json）

```
572 tests / 572 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 112480.9303
# 10k rows: seed=478ms p95=62.8ms max=65.7ms hitTotal=200 total=1826ms
# 100k rows: seed=5261ms p95=80.8ms max=81.2ms hitTotal=200 total=7001ms
# 1000-file cold 220ms · warm 167ms · budget 2000ms
```

门槛文件单跑 7/7（3 条 4.6.17 + 4 条 4.6.18）。

LoCoMo 检索-only 复跑（4.6.18，归档在 `docs/evidence/locomo-retrieval-4.6.18-session.json` 与 `-turn.json`）：

```
session: recall@10 0.7239 / any 0.7699 / nDCG 0.5680 / 38.7s
turn:    recall@10 0.3185 / any 0.3572 / nDCG 0.2107 / 241.0s
dataSha256 79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4
```

与 3.12.0 基线（session 0.7134 / turn 0.3483）相比：session 升约 1 个点，turn 降约 3 个点。这不是本轮门禁改动的效果（画像与检索路径无关），而是 3.12.0 之后检索实现变化的累积结果；如实记录，不挑好数字。turn 达标（≥0.40）仍是 4.7.0 的首要任务。

## 5 判定

- 做：P1-01/02/03 三条确定性旁路；P2-08 文案；文档类 P2 全部随版。
- 排 4.7.0：门禁规则去重到 `assertMinContent`（含 notes INSERT 旁路）、TAP→evidence 生成侧绑定与 check 重验。
- 不采纳：把字符门槛做成可配置；批量删除历史短笔记；为分数放松 1200 预算。

## 6 契约（4.6.18 更新）

1. **内容字符 = 字母 + 数字**（`\p{L}` / `\p{N}`），其余类别不计。
2. **写入 2 / 画像 4 不变**，但门槛必须在取候选之前执行；分页扫描不得退回 `LIMIT` 后过滤。
3. **facts 三元组**：subject/relation/object 三者都非空；legacy 空 object 行不渲染，不删除。
4. **错误文案**：`text is too short (1 content character)` / `(n content characters)`；候选为 `candidate text is too short … reject it instead of accepting`。

## 7 包内容

- 干净快照项数在发版后按同样方法实测并写进汇总；工作树数字不作为发布口径。
- 本轮修改：`lib/profile.mjs`、`lib/store.mjs`、`lib/tool-definitions.mjs`、`test/min-content-gate-4.6.17.test.mjs`、`package.json`、`package-lock.json`、`README.md`、`docs/{CHANGELOG,DESIGN,REFERENCE,REMEDIATION-BACKLOG,BENCHMARKS}.md`、`docs/COMPLETION-4.6.17-2026-11-27.md`、`docs/COMPLETION-4.6.18-2026-11-27.md`、`docs/evidence/4.6.17-context.txt`、`docs/evidence/locomo-retrieval-4.6.18-{session,turn}.json`、`docs/UPDATES.md`。

## 8 发布链

待发版后填写：内容提交 → update-log 提交（tag 指向）→ 证据提交 → 最终 update-log（远端 main HEAD）；tag / Release / 资产 id 与 `verify-release` 结果一并记录。

## 9 未纳入

- 门禁三处复制（tool-definitions、store、search 的 notes INSERT）与 TAP→evidence 门禁绑定：4.7.0。
- 云主机复跑本轮仍需在发版后补 `git rev-parse HEAD` 与 TAP 摘要（P2-13）。
