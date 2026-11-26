# 4.6.5 完成报告 — 2026-11-26

- 基线：4.6.4，commit `1407953f`，tag `v4.6.4`
- 触发：`docs/复核报告-4.6.4-2026-11-26.md`
- 范围：只收口报告数字证据链、`--tap` 边界与语义门回归；不改 schema、不改检索权重、不放宽 ADR-020 预算。

## 复核结论

4.6.4 的三项代码修复、4.6.3 报告勘误与发布链均属实。复核指出的问题集中在流程，而不是代码：

- 4.6.4 报告的 `duration_ms 28820.5475` 与 ADR-020 的 `5331/122、5376/63` 来自另一次未留痕运行，不是当次 TAP；本轮已按 14:57:46 快照改为 `29994.0467` 与 `5679/143.1、5389/89.9`。
- 报告“发布”段原为占位符；本轮补上了 commit、tag、Release、生产与云主机结果。
- 显式 `--tap` 指向不存在文件时会静默回退到声明数，属实。
- 新增 DESIGN 语义门只有手工验证，没有自动化负向回归，属实。
- 15:07 的并发复跑 490/492、p95 456ms 属于环境争用假失败；300ms 产品预算不放宽，也不改成串行全量。

## 本轮修复

- **证据文件**：新增 `scripts/tap-evidence.mjs`，把 TAP 的汇总、`# duration_ms`、ADR 诊断行、1000 文件索引行和快照时间写入 `docs/evidence/<version>.json`。
- **报告校验**：`check-docs` 新增 `completion report quotes archived TAP evidence`，完成报告必须逐字引用证据文件中的汇总、时长、ADR 与索引行；手抄数字会失败。
- **`--tap` 边界**：显式传入路径但文件不存在时立即报 `TAP file missing`，不再回退到声明数。
- **诊断修正**：TAP 摘要不完整时只报 `TAP summary is complete`，不再附带误导性的 `0 failure(s)`。
- **语义门回归**：抽出 `lib/design-contract.mjs`，新增旧措辞拒绝与当前措辞放行两条自动化断言。

## 验证

以下四行由 `docs/evidence/4.6.5.json` 原样提供，`check-docs` 会逐字核对：

- 494 tests / 494 pass / 0 fail / 0 cancelled / 0 skipped
- `# duration_ms 30002.3245`
- `# 10k rows: seed=5863ms p95=130.2ms max=168.2ms hitTotal=200 total=8581ms`
- `# 100k rows: seed=5382ms p95=68.9ms max=77.7ms hitTotal=200 total=6846ms`
- `# 1000-file cold 1080ms · warm 914ms · budget 2160ms`

- 门禁回归：8/8 通过（原 6 条 + `--tap` 缺文件 + DESIGN 语义正负断言）。
- `npm run check`：版本 4.6.5、494 tests（TAP）、26 routes、30 MCP tools、15 OpenAPI paths、32 ADRs 一致。

## 未改

- 不恢复或改写 4.6.2/4.6.3/4.6.4 的 tag 与 Release 资产；4.6.5 另行打 tag。
- 不因并发 p95 假失败降低 ADR-020 的 300ms 预算，也不把性能测试改成串行全量。
- 不把测试钩子包装成抗篡改安全边界。
- 4.6.1 的 TAP 483/483 继续标 TBD，不用本轮 494 反推。

## 发布

- 版本：`package.json` / `package-lock.json` 4.6.5。
- tag `v4.6.5`；签名 manifest 与 Release 资产随 GitHub Release 发布。
- 生产 7788 与云主机在发布后升级到同一 commit。

