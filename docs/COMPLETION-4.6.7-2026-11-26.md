# 4.6.7 完成报告（覆盖率评审补测）

- 日期：2026-11-26
- 触发：`docs/COVERAGE-REVIEW-2026-11-26.md`（源码核心 87.77% 行 / 69.20% 分支，入口层未覆盖集中）
- 结论：P0 清单 8 项中 7 项已补测并跑绿，`memory_write` raced 分支延后到 4.6.8（需双进程才可稳定复现，现写会引入 flaky）。

## 做了什么

- **请求体安全边界**：`readJsonBody` 为可单测改为导出（行为不变）。新增 strict 矩阵：`body_unavailable`/400、`body_empty`/400、`body_invalid_json`/400、`body_invalid_object`/400（数组/null/字符串/数字/布尔）、`body_too_large`/413 且断言 `resume()` 排空一次；lenient 分支全部降级为 `{}`；已 settled 的请求不再被后续帧或错误改写。
- **prompt 注入预算**：驱动真实 `apply()` 的 `systemPrompt.section`，断言 persona、项目行、召回块都计入 1200 字符预算；超限时先丢召回块，最终长度不超 `PROFILE_BUDGET`；`contested` 与 `superseded_by` 命中不注入且不计入 `recall`；`lastInjection` 的 `chars`/`recall`/`project`/`scopeId` 全部有断言。
- **dream 定时租约**：`OMNI_DREAM_INTERVAL_MS` 默认不启动；开启后按间隔取 `dream` 租约、结束后释放（再次 `acquireLease` 可立即成功），`dispose` 清掉定时器。
- **CLI `project` 族**：`show` 解析键与旧键、`init` 幂等与 `--force`、`link` 拒绝 `global` 与自链接；`link --apply` 用临时库核对——预览零改行、apply 后 `from` scope 清零、行落到 `to` scope、`scope_aliases` 写入别名。
- **CLI `rules` 写盘**：无文件且无 `--create` 只打印文本；`--create --write` 生成单个 managed block；重复写字节一致；预览不改盘；marker 不成对时跳过且正文不丢。
- **MCP stdio 主链路**：跨进程断言 `initialize` 帧、无效 JSON 的 `-32700`、未知方法 `-32601`、通知不回帧、`tools/call` 成功/工具抛错/未知工具按帧序回复、不可分发帧只记日志且 chain 继续、SIGINT 后 `stop()` 收尾。
- **`bin.mjs` 冒烟**：spawn 真实入口，exit 0、stdout 全是协议帧、stderr 无 `ExperimentalWarning`、`tools/list` 非空、`serverInfo.version` 与 `package.json` 一致。

## 验证

以下行由 `docs/evidence/4.6.7.json` 原样提供，`check-docs` 逐字核对：

- 527 tests / 527 pass / 0 fail / 0 cancelled / 0 skipped
- `# duration_ms 104956.0564`
- `# 10k rows: seed=487ms p95=72.4ms max=73.4ms hitTotal=200 total=2136ms`
- `# 100k rows: seed=5615ms p95=98.4ms max=104.9ms hitTotal=200 total=7715ms`
- `# 1000-file cold 329ms · warm 284ms · budget 2000ms`

- 新增 4 个测试文件 33 条用例；全量串行约 105s（4.6.6 为约 99s）。
- ADR-020 的 300ms 预算未放宽；10k/100k 仍真实查询并断言 `hitTotal > 0`。

## 未改 / 未做

- 不改 schema（仍为 20），不改检索权重，不改 HTTP 路由数量（26）与 MCP 工具数量（30）。
- `memory_write` 的 raced 并发分支未测：单进程事务串行，该分支不可达；需要双进程并发写同一文本才能稳定触发，先记入 `docs/REMEDIATION-BACKLOG.md`。
- `lib/store.mjs` 的 force reindex / restore、`lib/read-routes.mjs` 的 dream 路由、`doctor`/`schema` 分支等 P1 项延后到 4.6.8。
- 覆盖率评审里的“前端 JS 与未加载脚本”盲区不做 0% 记账；按 DESIGN §6.20 的口径单独处理。

## 发布

- 版本：`package.json` / `package-lock.json` 4.6.7。
- tag `v4.6.7`；签名 manifest 与 `v4.6.7` Release 资产随 GitHub Release 发布。
- 生产 7788 与云主机在发布后升级到该 tag 对应提交；精确 commit SHA 见 tag 注解与 Release 正文的“发布核对”段（报告不写自身 SHA，避免推送后 SHA 变化造成的自指失真）。

