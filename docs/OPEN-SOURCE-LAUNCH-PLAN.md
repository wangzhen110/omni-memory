# 全息记忆完全开源发布：执行结果（4.0.0）

> 状态：已完成并发布（2026-11-24）
> 基线：3.12.3 → 4.0.0

## 1. 已完成

### M1 公开可验证发布（3.12.3）

- `npm run verify:release`：读取官方 Release 的签名清单，验 Ed25519，校验 tag/version/commit，再比对签名 commit 上的 `package.json` 与启动器 SHA-256。
- `--launcher <path>`：校验镜像或第三方渠道下载的 exe。
- Release 附带 `omni-update-manifest-v2.json`、v1 清单与启动器 exe。
- 文档 `docs/VERIFY-RELEASE.md`，CI 校验。

### M2 可信首次安装（4.0.0）

- `npm run setup` 默认 `--require-release`：先验 Release 清单，再要求 HEAD 等于签名 commit、工作树干净，最后才安装。
- 任何一步失败都在写文件前退出，不覆盖正在运行的服务。
- `npm run setup:dev` 保留给已可信的本地开发检出，只做同提交 SHA-256 自洽。
- `npm run setup:dry:release` 只验证与打印计划。
- 安装器返回 `launcherIntegrity: "release-manifest-v2"` / `releaseSignatureVerified: true`，不再混淆本地哈希与发布签名。
- 文档 `docs/INSTALL-RELEASE.md` 写清 9 步校验、防什么/不防什么、镜像与离线边界。

**没有交付的部分（明确边界）**：没有做带 Authenticode 签名的独立 exe 安装器。当前“官方安装”是 **Node 可审计的发布验签路径**，不是“双击即装”。要跨过这一步需要代码签名证书与独立发布流水线；不在 4.0.0 的虚假承诺里。

### M3 开源许可与治理（4.0.0）

- `LICENSE` 切换为 **AGPL-3.0-only** 官方全文；`package.json` 的 `license` 同步。
- 52 个源码/文档文件的 SPDX 头从 `LicenseRef-Omni-Memory-Personal-Use-1.1` 迁移为 `AGPL-3.0-only`，删除 NonCommercial 行。
- `LICENSING.md`：AGPL 自由商用 + 闭源/闭源 SaaS 商业例外。
- `ATTRIBUTION.md`：AGPL 合规署名。
- 新增 `CONTRIBUTING.md`（DCO）、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`GOVERNANCE.md`。
- Issue 模板改为“商业例外申请”；README badge 与许可证段同步。

### M4 公共 QA 与上线（4.0.0）

- `npm run demo`：隔离临时库，写入 note + fact 并召回，不碰真实数据。
- `npm run qa`：黄金集 + 120 例质量套件，支持 `--json`。
- `docs/QUICKSTART.md`：5 分钟源码路径、官方安装、验证、MCP、诊断、卸载。
- `docs/PUBLIC-QA.md`：4.0.0 基线（golden recall 1.000 / MRR 0.979；quality 120/120，p50 2ms）与提交方式。
- 新增 `test/open-source.test.mjs`：许可证、治理文件、setup 默认验签、安装帮助。

## 2. 关键决策

- **许可证选 AGPL-3.0-only**：允许商用，但网络服务修改必须开源；闭源场景另售商业例外。Apache-2.0 / MIT 未采用。
- **首次安装选发布验签，不选独立 exe**：在无代码签名证书的前提下，可审计的 Node 路径比一个未签名的“安装器 exe”更诚实。
- **源码路径不承诺官方构建**：`npm run serve` 运行的就是用户检出的代码；发布验签只覆盖 Release 清单与启动器。

## 3. 残余风险

- 单把 Ed25519 私钥仍是单点；必须离线保管并准备 `keyId` 轮换。见 `docs/UPDATE-SIGNING.md`。
- 用户若从非官方渠道拿整个仓库并执行 `setup:dev`，发布验签不保护。
- 公开 QA 的 20 条语料与 120 个合成用例不是开放域基准，也不是安全审计。
- 旧提交仍保留当时的 Personal Use 1.1 声明；4.0.0 起的新提交按 AGPL。README 已写时间边界。
- 没有 Authenticode 独立安装器；这是已知缺口，不是“已完成”。

## 4. 验收

- `npm test` 438/438。
- `npm run check` 通过：438 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.0.0、syntax 56 files。
- `npm run qa -- --quality-count 120 --json` 通过：golden 24/24、quality 120/120。
- `npm run verify:release -- --tag v4.0.0` 通过。
- GitHub Release `v4.0.0` 含 v2/v1 清单与启动器 exe；生产 7788 升级到 4.0.0 并 `doctor` 0 错误。
