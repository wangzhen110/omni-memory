# 4.6.6 完成报告 — 2026-11-26

- 基线：4.6.5，commit `6085adac`
- 触发：独立复跑再次出现 ADR-020 10k p95 456ms 假失败
- 范围：只修测试调度，不改 schema、不改检索权重、不放宽 300ms 预算。

## 结论

`--tap` 指向不存在文件时静默回退的问题已在 4.6.5 修复并实测 `TAP file missing` + exit 1。本轮处理的是另一个反复出现的问题：ADR-020 的墙钟 p95 在并发测试进程中会被 CPU/磁盘争用拉高到 456ms，连续两轮复现。产品查询本身在隔离环境下仍远低于预算。

## 修复

- `npm test` 增加 `--test-concurrency=1`，按文件串行执行。
- ADR-020 的 300ms 预算不变，10k/100k 仍在同一测试中真实查询并断言 hitTotal > 0。
- 代价是全量从约 30s 增加到约 99s；这是测试可复现性成本，不是产品性能降级。

## 验证

以下行由 `docs/evidence/4.6.6.json` 原样提供，`check-docs` 逐字核对：

- 494 tests / 494 pass / 0 fail / 0 cancelled / 0 skipped
- `# duration_ms 99356.6737`
- `# 10k rows: seed=487ms p95=61.2ms max=61.9ms hitTotal=200 total=1863ms`
- `# 100k rows: seed=5288ms p95=74.2ms max=78.3ms hitTotal=200 total=7072ms`
- `# 1000-file cold 228ms · warm 183ms · budget 2000ms`

- 串行全量墙钟约 100s，494/494，0 fail、0 skip。
- 文档门：版本 4.6.6、494 tests（TAP）、26 routes、30 MCP tools、15 OpenAPI paths、32 ADRs 一致。

## 未改

- 不降低 ADR-020 的 300ms 预算，不修改检索权重。
- 不改 schema（仍为 20）。
- 4.6.1 的 TAP 483/483 继续标 TBD。
- `--tap` 边界不再重复修改；4.6.5 已覆盖。

## 发布

- 版本：`package.json` / `package-lock.json` 4.6.6。
- tag `v4.6.6`；签名 manifest 与 Release 资产随 GitHub Release 发布。
- 生产 7788 与云主机在发布后升级到同一 commit。
