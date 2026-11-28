# 全息记忆 4.6.21 完成报告（2026-11-28）

## 1 定位

本轮输入是 4.6.20 的外部复核（P0 0 / P1 4 / P2 9）。四条 P1 都不在功能层：一条是新增测试的假阳性，三条是上一版自己写的发版清单与门禁。4.6.20 补了 install 回退锁，但「回退到 plan.home」那条靠 doctor 段的同名输出通过——删掉 `plan.home` 回退仍全绿，属恒真断言同型；发版清单把「每个数字都要有出处」「VM 落证 + 最终 HEAD」写成硬规则，而 4.6.20 既没归档出处，也没有在最终 HEAD 上跑过 `npm run check`。本轮按裁决直接修，不重签 4.6.20。

## 2 P1-A：install 第 2 条用例假阳性

- 事实：`human()` 输出两行 `数据根目录`——安装摘要行（`scripts/install.mjs:135`）与 `formatDoctor()` 的 doctor 行（`hosts/shared/doctor.mjs:326`）。4.6.20 用例 2 只断言全文里出现 `/数据根目录: D:\\.dsh-alt/`，而测试把 `doctor.home` 填成同一个值，于是匹配来自 doctor 行。变异（删 `plan.home` 回退）后 5/5 仍绿。
- 修法：新增 `installLine()`，只取**第一次出现**的那一行并整行相等比较；`doctor.home` 固定为 `D:\\doctor-home`，与 `plan.home` 不同值；补 `doesNotMatch(/undefined/)`。
- 三条分支的期望值现在是：有 `result.home` → 该值；只有 `plan.home` → `plan.home`；都没有 → `未解析（doctor 使用默认 ~/.dsh）`。
- 变异复验：把 `:135` 改成 `result.home ?? '…'`（删 `plan.home` 回退）→ `not ok 2`，恢复后 6/6。

## 3 P2-L1：`计划任务` 回退补锁

4.6.20 唯一改到运行态字符串就是这条，却没有断言。新增一条覆盖四种输入：`result.task` 有值、只有 `plan.task`、`noTask: true`、两者都缺（打印「未解析」），并统一断言不含 `计划任务: undefined`。

需要说明的口径：真实 CLI 路径上 `base.task` 总被赋值，`plan.task` 回退在 CLI 上不可达（工程评审 M4 亦验证）。这条用例锁的是 `human()` 这个可导入纯函数的防御，不是线上路径——本轮修的是测试缺口，不是线上 bug。

## 4 P1-C / P1-D：发版清单改成可执行

- 规则 3 原来写「每个数字（测试数、包数、Release id、资产 id、tag object）都要能在 `docs/evidence/` 或 `npm run check` 输出里找到出处」。实测 `grep` 对这些数字零命中——它们只在 GitHub API 与 `npm pack` 的当场输出里。现在按类型指定：测试数→`evidence/<版本>.json`；包数→归档的 `-pack.json`；Release/资产/tag object→归档的 `-release-api.txt`。
- 规则 1 原来强制写「VM 停 `<有落证的 sha>`；最终 HEAD `<新 sha>` 只多 `<N>` 条 docs 提交」。这与 4.6.20 刻意去掉漂移 HEAD 的写法冲突。现在只写时点表述与 `git diff` 为空，不写「最终 HEAD `<sha>`」。
- 命令数统一成「4 条 npm 命令 + 1 条前置脚本」，并写清 push 后必须 `git reset --hard origin/main` 再跑 update-log——这是 4.6.20 门禁在发布 HEAD 变红（P1-B）的根因。

## 5 P1-B：发布 HEAD 上的门禁

4.6.20 的 `npm run check` 在远端 main 上 exit 1，报 `docs/UPDATES.md is missing 1 commit(s): d0379d53`。根因是 push 会改写提交 SHA：UPDATES 记的是本地 `bad8a995`，远端历史里是 `d0379d5`。本轮把正确顺序写进清单第 4 节，并在本版自己身上执行：push 内容提交 → `git fetch && git reset --hard origin/main` → `npm run update-log` → 提交这一条 → 在最终 HEAD 复跑 `npm run check` 到 exit 0。update-log 提交本身不进 UPDATES，所以不会无限重跑。

## 6 P2 收口

- **P2-L4**：CHANGELOG 4.6.20 的 `result.plan.home` / `result.plan.task` 改为 `result.plan?.home` / `result.plan?.task`，与代码可选链一致。
- **P2-L7**：`docs/evidence/<版本>.json` 的 `summaryLine` 旁新增 `summaryLineNote`，明写它由分列行拼出、不是 TAP 字面行；逐字引文以 TAP 分列行为准。
- **P2-L8**：`scripts/tap-evidence.mjs` 增加 `commitSha` / `commitShaSource`，默认 `git rev-parse HEAD`，可 `--commit` 显式指定，取不到写 `null` + `unresolved` 不抛错。4.6.21 的 evidence 绑定 `91d9b76b`。
- **P2-L9**：补归档 `docs/evidence/4.6.20-release-api.txt`（tag/ref/Release/资产上传的原始 JSON + `verify:release` 输出 + 临时 deploy key 的 POST/DELETE 状态码与 id）。其中 204 响应体当天未保存，文件里已注明这是补记。
- **P2-L2**：口径收窄为「没有写入、调度、排序行为变更；只有一处文案层防御与两处脚本/文档改动」，不再说「没有行为变更」。
- **P2-L3**：两次 `boot()` 保留。合并只省一次进程启动，但会让「文案断言」与「正常写入」的失败信号粘在一起，收益不抵定位成本。
- **P2-L6**：本轮汇总按实计口径写「4 条实质 docs 改动 + 4 条 update-log」。

## 7 证据（取自 docs/evidence/4.6.21.json）

```
585 tests / 585 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 115250.0089
# 10k rows: seed=479ms p95=62.5ms max=63.4ms hitTotal=200 total=1736ms
# 100k rows: seed=5203ms p95=63.9ms max=65.2ms hitTotal=200 total=6598ms
# 1000-file cold 244ms · warm 191ms · budget 2000ms
```

evidence 绑定 `commitSha 91d9b76b`（`commitShaSource: flag`）。首行是汇总行，TAP 字面为 `# tests 585` 等分列行——这也是本版新加 `summaryLineNote` 的原因。

## 8 未纳入

- 不重签 4.6.20：四条 P1 全在测试与文档层，代码行为与发布包未变。
- 4.7.0 积压不动：分页 keyset + 只读事务、turn 检索 0.318→0.40、门禁三处收拢、TAP→evidence 生成侧绑定。
- install 用例 2 的 doctor 行重复输出本身保留：它是 `human()` 的真实输出，收窄它属于改产品文案，不属本轮。

## 9 发布链

见发版后补写；按清单第 4 节顺序执行，最终 HEAD 的 `npm run check` 必须 exit 0。
