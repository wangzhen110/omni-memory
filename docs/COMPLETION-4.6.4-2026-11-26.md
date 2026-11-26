# 4.6.4 完成报告 — 2026-11-26

- 基线：4.6.3，commit `c4da9313`，tag `v4.6.3`
- 触发：`docs/复核报告-4.6.3-2026-11-26.md`
- 范围：只收口 4.6.3 复核提出的文档口径与测试门禁盲区；不改 schema、不改检索权重、不放宽 ADR-020 预算。

## 复核结论

复核对 4.6.3 四项代码修复、负向实测与发布链的判断成立。需要纠正的是 4.6.3 完成报告的验证段：`约 30.2s` 与 `cold 925ms / warm 883ms / budget 2000ms` 不是 14:39:57 那份 TAP 的数字；同一份 TAP 的原文是 `30.634s` 与 `cold 9445ms / warm 6229ms / budget 18890ms`。`486/486` 是该快照的事实，不是任意并发时刻的稳定状态；复核在 14:49 复跑得到 484/486 + ADR-020 p95 443.9ms，属于争用假失败，隔离单文件复跑正常。

复核新发现的三项均属实：

1. `docs/DESIGN.md` 的测试钩子段仍写 `NODE_TEST_CONTEXT` “存在时生效”，与 6.16 和代码的白名单直接矛盾，且 `check-docs` 没有语义校验。
2. `.test-results.tap` 存在但缺 `# tests` 时，`check-docs` 会静默回退到声明数，单独跑 `check:docs` 可能放过截断 TAP。
3. 4.6.3 的门禁负向实验是手工实测，没有自动化回归。

## 本轮修复

- **DESIGN 口径**：测试钩子段落改为“`NODE_TEST_CONTEXT` 为 `child` / `child-vN` 时生效”，并明写“不是抗篡改安全边界”；新增 `check-docs` 语义门，旧的“存在时生效”表述会直接失败。
- **TAP 缺摘要 fail-closed**：`check-docs` 区分“文件不存在”和“文件存在但无 `# tests`”；后者以 `TAP summary is complete` 失败，不再回退到声明数。
- **门禁回归**：新增 `test/gates-4.6.4.test.mjs` 6 条，覆盖完整摘要放行、重复 `# tests`、plan 不等于 `# tests`、多个 plan、缺 `# tests`、低于声明数。
- **报告勘误**：4.6.3 完成报告的时长与 1000 文件索引改回 TAP 快照原文；全绿加 `14:39:57` 快照限定，并并列记录 484/486 的并发观测。

## 验证

- `npm test`：492 tests / 492 pass / 0 fail / 0 cancelled / 0 skipped，`duration_ms 29994.0467`（14:57:46 的 `.test-results.tap` 快照）。
- ADR-020：10k `seed=5679ms p95=143.1ms max=147.3ms`；100k `seed=5389ms p95=89.9ms max=108.9ms`；均低于 300ms 预算。
- `npm run check`：版本 4.6.4、492 tests（TAP）、26 routes、30 MCP tools、15 OpenAPI paths、32 ADRs 全部一致；新增 `TAP summary is complete` 与 `DESIGN test hook matches child-only contract` 均通过。
- 新增门禁用例单跑：6/6 通过，TAP `duration_ms 898.8903`，墙钟约 1.16s。
- 15:07 的并发复跑为 490/492、1 fail（ADR-020 10k p95 456ms）+ 1 skip；该失败是争用假失败，不改变 300ms 预算。

## 未改

- 不恢复或改写 4.6.2/4.6.3 的 tag 与 Release 资产；4.6.4 另行打 tag。
- 不因并发 p95 假失败降低 ADR-020 的 300ms 预算，也不把性能测试改成串行全量。
- 不把测试钩子包装成抗篡改安全边界。
- 4.6.1 的 TAP 483/483 继续标 TBD，不用本轮 492 反推。

## 发布

- 版本：`package.json` / `package-lock.json` 4.6.4。
- commit `1407953f`，tag `v4.6.4`（annotated 对象 `adc9135`），Release id `459059413`，签名 manifest 已上传并通过 `verify-release`。
- 生产 7788 已升级：`/health` 返回 `4.6.4`、30 tools；doctor 0 错误 0 警告。
- 云主机 `/home/user/omni-memory-vm` 已快进到 `1407953f`：492 tests / 489 pass / 3 skip / 0 fail。
- Release 正文的测试口径在 4.6.5 一并修正为带快照时间的表述。

> 复核勘误：本报告初稿的 `28820.5475` 与 `5331/122、5376/63` 来自另一次未留痕运行，不是 14:57:46 的 TAP；已按该快照原文更正。4.6.5 起报告测量值必须由 `docs/evidence/<version>.json` 提供并被 `check-docs` 校验。
