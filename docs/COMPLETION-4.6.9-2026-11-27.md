# 全息记忆 4.6.9 完成报告

> 依据：`docs/复核报告-4.6.8四轮定稿-2026-11-27.md` §6（安装脚本是否放行 docs-only 后代）。本版只做这一项代码改动，外加一条恒真断言的真实化；schema 仍为 20。

## 1. 做了什么

- **安装校验放行 docs-only 后代**：`scripts/install.mjs` 原来硬要求 `HEAD == 发布提交`，文档提交一多就必须先 `git checkout <tag>`。现在发布提交是 `HEAD` 的祖先、且 `git diff --name-only --no-renames <release>..HEAD` 的每条路径都以 `docs/` 开头时放行：安装器从 `HEAD` 读字节（差异只含 `docs/`，与发布提交字节等价）并在同一提交内做 SHA-256 自洽校验，输出里标“领先 N 个 docs-only 提交”；签名 manifest 的 `packageJsonSha256`/`launcherSha256` 只校验发布提交对象，不直接与落盘字节比对。任何非 `docs/` 路径（含把文档改名移出 `docs/`）、非祖先关系、空 diff、缺提交参数、git 失败，全部拒绝，报错带原因码与首个越界路径。
- **判定逻辑独立成模块**：`scripts/release-delta.mjs` 的 `describeHeadDelta()`，安装脚本只调用；`--commit` 显式指定时仍须等于发布提交。
- **恒真断言真实化**：`test/entry-diagnostics-4.6.8.test.mjs` 的 `section.text({}).length >= 0` 改为校验“prompt 返回字符串，且 `lastInjection.chars` 等于渲染长度”。
- **文档**：`DESIGN` 新增 §6.22 安装校验的文档例外；`CHANGELOG` 加 `[4.6.9]`；`README` 徽章与用例数更新为 545。

## 2. 测试与证据

新增 `test/release-delta-4.6.9.test.mjs` 5 条：同提交放行、docs-only 放行并计数、源码改动拒绝、文档移出 `docs` 拒绝、缺提交参数拒绝。

逐字证据（`docs/evidence/4.6.9.json`）：545 tests / 545 pass / 0 fail / 0 cancelled / 0 skipped

```
# duration_ms 102635.4588
# 10k rows: seed=488ms p95=39.7ms max=41.6ms hitTotal=200 total=1373ms
# 100k rows: seed=5437ms p95=53.6ms max=53.8ms hitTotal=200 total=6728ms
# 1000-file cold 178ms · warm 138ms · budget 2000ms
```

## 3. 覆盖率（本地 lcov，并集口径）

- `index.js`：599/624 = **95.99%**（与 4.6.8 同值，未改其代码）
- `hosts/cli.mjs`：641/863 = **74.28%**（同值）
- `hosts/mcp/server.mjs`：217/228 = **95.18%**，`serveStdio` 段 180-228 **49/49**；与 4.6.8 的 205/228 相比，本次多覆盖 121-132 与 154、少覆盖 165——stdio 用例每次跑到的分支子集不同，属运行间波动，段覆盖与 207/208 均未退化

## 4. 取舍

- 做：安装放行（选项 B，报告推荐）、恒真断言真实化、对应文档。
- 不做：把放行条件放宽到 “docs/ 之外的白名单”（例如 `*.md` 根文件）——越宽越难解释，当前只认 `docs/`。
- 不做：为这条改动单独升 schema 或动检索权重；结果与新版本无关。
- 未改：`routeState` 的 `failed` 态断言、dream 定时器释放、`store` force/restore、`read-routes` dream、`doctor` 分支，仍在 BACKLOG 4.6.9 段（本版未做，顺延 4.6.10）。

## 5. 复现

```bash
node --test test/release-delta-4.6.9.test.mjs
npm test
node scripts/tap-evidence.mjs
node scripts/check-docs.mjs
node scripts/verify-release.mjs --tag v4.6.9
npm run setup   # 现在可以在 main HEAD（含 docs-only 提交）直接装
```
