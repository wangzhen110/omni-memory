# 4.6.8 完成报告（覆盖率重测收口）

## 1. 触发与依据

- 用户下发 `docs/覆盖率重测报告-4.6.7-2026-11-27.md`（只读重测，基线 `v4.6.7`）。
- 结论：4.6.6 报告的 `index.js 47.84%`、`all files 53.25%` 都是 Node 22 文本表“单条代表记录”口径的产物；真实并集行覆盖 `97.18%`（586/603），P0-1 三段并集 100% 命中。
- 立刻项：①补 `hosts/mcp/server.mjs` 207-208（带 id 的 dispatch 失败回帧）；②`hosts/cli.mjs` 行覆盖达 70%。
- 补测建议：租约分支、prompt 弱断言（`at`/`auto` 漏断、`routes` 恒真）、4.6.6 报告加口径限制说明。

## 2. 本轮实际改动

| 项 | 类型 | 内容 |
| --- | --- | --- |
| `routeState` 恒 `pending` | 真实缺陷 | 路由挂载状态从声明到使用从未更新；改为挂载成功写 `mounted`（`count`/`at`/`error:null`）、失败写 `failed` 并 rethrow，新增导出 `routeStateSnapshot()` |
| `project init` 只读目标 | 健壮性 | `mkdirSync` 抛 `EPERM` 时打栈退出 1；改为 `无法写入 <file>：<msg>` + 退出 2 |
| `context --json` | 一致性 | 空库路径忽略 `--json` 打印散文；改为输出工具原值 JSON |
| MCP dispatch 失败帧 | P0-5 | `tools/call explode`（带 id）→ `-32603`、无 `result`、id 回显；无 id 同帧只记日志 |
| CLI 主链路 | P0-2 | `index`/`project search`/`context`/`impact`/`sync`/`status`/`init`，以及 `write`/`search`/`ingest`/`candidates` |
| prompt 断言 | 建议③ | `routes` 由近似恒真改为 `pending`/`mounted`/`failed` 三态枚举，补 `at`/`auto` |

新增测试 13 条：`test/mcp-dispatch-error-4.6.8.test.mjs`（2）、`test/entry-diagnostics-4.6.8.test.mjs`（4）、`test/cli-project-search-4.6.8.test.mjs`（7）。`test/fixtures/mcp-stdio-harness.mjs` 增加 `explode` 工具作为 dispatch 失败入口。

## 3. 验证证据

以下行由 `docs/evidence/4.6.8.json` 原样提供，`check-docs` 逐字核对：

```
540 tests / 540 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 93308.4259
# 10k rows: seed=489ms p95=31.5ms max=32.5ms hitTotal=200 total=1208ms
# 100k rows: seed=5289ms p95=39.9ms max=40.7ms hitTotal=200 total=6280ms
# 1000-file cold 177ms · warm 124ms · budget 2000ms
```

覆盖率（本地 lcov，`--test-concurrency=1` 全量，并集口径）：

- `index.js`：599/624 = **95.99%**（448 条记录并集）
- `hosts/cli.mjs`：641/863 = **74.28%**（单记录），较 4.6.7 的 61.31% 提升 12.97pp
- `hosts/mcp/server.mjs`：205/228 = **89.91%**（并集）；`serveStdio` 段 180-228 **49/49**（含本轮把错误回显改为固定文案后新增的 2 行）
- 门槛判定：`cli.mjs` ≥70% **达成**；`server.mjs` 的 `serveStdio` 段满行 **达成**（207-208 有测试断言，源码逻辑 4.6.7 已存在）

## 4. 设计约定（已写入 DESIGN §6.21）

- 覆盖率只认并集口径：同一 `SF` 文件按行号取 `DA` max 重算；单记录数字只作趋势。
- 分支只认 `(line, branch)` 或“行内第 N 个分支”；`(line, block, branch)` 分母虚高约 9 倍，不作验收依据。
- 诊断字段必须是真实状态：`routes` 三态枚举，禁止 `!== null` 这类恒真断言。
- CLI 写盘失败是用法错误：退出 2 + 一行提示，不打栈；`--json` 必须始终可解析。
- 验收线：`index.js` 并集 ≥95%、`hosts/cli.mjs` ≥70%、`server.mjs` 的 `serveStdio` 段满行。

## 5. 取舍与延后

- **做**：两条立刻门槛、`routeState` 缺陷、两个 CLI 健壮性问题、prompt 弱断言。
- **缓**：dream `dispose` 清定时器断言（需要可观测内部探针，列入 4.6.9）；`store` force/restore、`read-routes` dream 路由、`doctor` 分支。
- **不做**：CI 固定顺序与 `server.mjs` 多次采样（当前无 CI，采样不可复现）。
- 未改 schema（仍为 20）、检索权重（0.6/0.2/0.2）、ADR-020 的 300ms 预算。

## 6. 发布

- 版本：`package.json` / `package-lock.json` 4.6.8；DESIGN 文档/插件版本 4.6.8。
- tag `v4.6.8`；签名 manifest 与 `v4.6.8` Release 资产随 GitHub Release 发布。
- 生产 7788 升级到 4.6.8；云主机 ff-only 到同一 tag 并跑 `npm run verify`。
- 发布后核对：`/health` 版本与工具数、Release 资产大小、`verify-release --tag v4.6.8` 结果见合并汇总。

## 6.5 复核整改（`docs/复核报告-4.6.8-2026-11-27.md`）

- **TAP 与最终提交对齐**：本轮 TAP `capturedAt` 为 `2026-11-27T01:09:21.327Z`，晚于代码提交 `db7a491`（`00:54:36Z`）；TAP 里的跨平台用例已是新名「an unwritable target」，不再包含 `(drive root)` 的旧逻辑。
- **两个 manifest 都按 `db7a491` 重签**：此前 `sign-release` 默认只写 v2，v1 资产是 4.6.7 残留；本次分别执行 `--schema v2` 与 `--schema v1`。
- **MCP 错误回显改为固定文案**：dispatch 失败只回 `internal error`，内部错误文本仅写本地日志，避免把内部路径带回 stdio 客户端。
- **server 覆盖率数字纠正**：并集 205/228 = 89.91%，`serveStdio` 段 180-228 49/49；旧稿的 216/226 是口径错误。

## 7. 复现

```bash
npm test
npm run verify
node --test --experimental-test-coverage --test-concurrency=1 \
  --test-reporter=lcov --test-reporter-destination=.coverage-4.6.8.lcov "test/*.test.mjs"
node scripts/tap-evidence.mjs
node scripts/check-docs.mjs
```


