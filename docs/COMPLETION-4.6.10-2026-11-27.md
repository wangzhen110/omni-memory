# 全息记忆 4.6.10 完成报告

> 依据：`docs/复核报告-4.6.9-2026-11-27.md` 的 I-1 加固建议与 S-4 / S-5。本版只动安装校验的字节来源、`merge-base` 故障分类与对应测试，schema 仍为 20，检索权重不变。

## 1. 做了什么

- **安装字节绑定发布提交**：`scripts/install.mjs` 把 `installCommit` 固定成 `release.commit`，`installLauncherFromCommit()` 用 `git show <release>:package.json` 与 `git show <release>:<launcher>` 取字节，并与 manifest 的 `packageJsonSha256` / `launcherSha256` 直比，不符即报 `does not match the signed release manifest`。`HEAD` 只决定“放不放行”，不再决定“装哪个字节”——I-1 指出的单点依赖消除，措辞与实现一致。
- **`merge-base` 故障分类**：`describeHeadDelta()` 只在退出码 1 记 `not-a-descendant`；128、ENOENT、仓库损坏等统一记 `git-failed`（S-5）。
- **输出文案纠正**：发布安装打印“提交谱系: HEAD 领先发布提交 N 个 docs-only 提交；安装对象仍取发布提交 `<sha8>`”与“启动器校验: Release manifest v2 Ed25519 + 发布提交对象 SHA-256（package.json 与启动器直比 manifest）”，不再用含糊的“签名 commit SHA-256”。
- **`GIT_BIN` 信任边界**：DESIGN §6.22 写明该变量可替换 git 可执行文件（v3.11.8 起既有），门禁不防这一层，但 manifest 哈希直比仍要求发布提交字节一致（S-6）。
- **测试**：第 5 条改名为“空提交参数被拒绝”并补 `allowed === false`；新增 `test/release-delta-4.6.10.test.mjs` 4 条。
- **文档**：`DESIGN` §6.22 重写、版本表与 NFR 计数更新；`CHANGELOG` 加 `[4.6.10]`；`README` 徽章、tag、用例数与 4.6.10 版本行更新。

## 2. 测试与证据

逐字证据（`docs/evidence/4.6.10.json`）：550 tests / 550 pass / 0 fail / 0 cancelled / 0 skipped

```
# duration_ms 119681.1776
# 10k rows: seed=844ms p95=69.9ms max=70.1ms hitTotal=200 total=2414ms
# 100k rows: seed=9253ms p95=94ms max=98.1ms hitTotal=200 total=11424ms
# 1000-file cold 283ms · warm 235ms · budget 2000ms
```

新增 5 条测试：`merge-base` 128 记 `git-failed`、退出码 1 记 `not-a-descendant`、HEAD 领先时安装字节仍取自发布提交、manifest 哈希不符即拒绝。

## 3. 覆盖率

本版未改 `index.js`、`hosts/cli.mjs`、`hosts/mcp/server.mjs` 与 `release-delta.mjs` 之外的业务代码；`install-launcher.mjs` 的新增分支由上述 5 条测试覆盖（两条哈希直比、一条字节来源、两条原因码）。既有并集口径不变：`index.js` 95.99%、`hosts/cli.mjs` 74.28%、`hosts/mcp/server.mjs` 95.18%。

## 4. 取舍

- 做：从发布提交读字节 + manifest 哈希直比（加固），而不是再写一段“等价性说明”。
- 做：`merge-base` 故障单独记码；方向仍是 fail-closed。
- 不做：为 `GIT_BIN` 加不可绕过的进程隔离——超出补丁版范围，写清边界即可。
- 不做：放宽 `docs/` 之外的白名单（含根目录 `README.md`）——本轮实测改 README 会被 `non-doc-change` 拒绝，这是预期行为。
- 不做：schema、检索权重、p95 预算任何调整。

## 5. 复现

```bash
node --test test/release-delta-4.6.9.test.mjs test/release-delta-4.6.10.test.mjs
npm test
node scripts/tap-evidence.mjs
node scripts/check-docs.mjs
node scripts/verify-release.mjs --tag v4.6.10
npm run setup   # 安装对象取发布提交；HEAD 领先 docs-only 时放行
```
