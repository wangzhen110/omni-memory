# 全息记忆完全开源发布计划

> 状态：执行中（2026-11-24）
> 目标：从「源码公开、仅限个人非商业使用」转为 OSI 认可的开源项目，同时保留可验证发布、可信安装与公开 QA。

## 1. 目标与非目标

**目标**

1. 许可证切换为 OSI 认可的开源许可证，并处理历史提交与现有版权头。
2. 发布物可独立验证：签名清单、可复现构建、公开校验命令。
3. 首次安装有明确信任路径，不再把 `npm run setup` 的本地哈希自校验当成发布签名。
4. 陌生人能在 5 分钟内跑通，并有公开、可复现的检索质量与性能结果。
5. 建立最小开源治理：贡献指南、安全策略、行为准则、发布流程。

**非目标**

- 不重写历史提交；旧提交保留当时的许可证声明。
- 不在本阶段把项目发布到 npm 或改动包名，除非发布路径确定。
- 不承诺 macOS/Linux 的完整安装体验；先保持 Windows x64 主路径，其他平台给源码运行方式。

## 2. 现状基线

- 仓库已公开，但 `LICENSE` 是 **Personal Use 1.1**，不是 OSI 开源许可；源码头、README、ATTRIBUTION、LICENSING、商业授权模板均绑定该许可，约 58 个文件带许可头。
- 已有 Ed25519 发布清单、v1/v2 manifest、签名发布脚本、`daily-sync --apply` 验签与提交谱系校验。
- Windows 启动器可复现构建：固定 PE 时间戳与 MVID，`check-launcher` 重建比对 SHA-256。
- `npm run setup` 只校验同提交 `package.json` 声明的启动器哈希，不验 Release 签名；从恶意 fork/镜像执行 setup 的持久化风险仍在。
- 仓库身份是 `@local/omni-memory`、`private:true`，没有 npm 通道。
- 缺少 `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、公开发布验证文档、公开 QA harness。
- CI 已有 Ubuntu/Windows × Node 22.13/24 测试矩阵和容器构建。

## 3. 工作流

### A. 许可证与治理

- 选定 OSI 许可证。推荐 **AGPL-3.0-only**（允许商用，但网络服务修改必须开源），可另售商业例外；若优先采用率则用 **Apache-2.0**，若只要最宽松则用 **MIT**。
- 全量替换 `LICENSE`、`package.json` 的 `license`、58 个源码/文档许可头、README/ATTRIBUTION/LICENSING/Issue 模板。
- 新增 `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`GOVERNANCE.md`。
- 明确贡献者许可：DCO 或 CLA；默认建议 DCO，降低贡献门槛。

### B. 供应链与安装信任

- 公开发布验证命令：用户可对任意 Release 验签、校验 `package.json`、启动器哈希和提交。
- Release 附带启动器 exe 资产，用户可本地比对。
- 首次安装两条路径：
  1. **源码路径**：clone → `npm ci` → `npm run setup:source`，明确说明这是从源码构建，不依赖发布签名。
  2. **官方安装器**：独立签名安装器，内置固定公钥，先验 Release manifest 再安装；安装器自身用 Authenticode 或发布哈希/签名校验。
- `npm run setup` 退回开发者便利入口，不再对外宣称安全安装。
- 私钥离线保存；准备 `keyId` 轮换、吊销和 overlap 窗口。

### C. 可复现构建

- 启动器已可复现；补充源码归档（固定 mtime/uid/gid）与 SHA-256。
- 发布清单增加源码归档哈希；CI 重建启动器并上传 artifact。
- 文档写清“如何从源码重建并比对哈希”。

### D. 上手与公开 QA

- 5 分钟测试包：`npm run demo`、preflight、QUICKSTART。
- 公开 QA harness：固定问题集、score report、失败样本可提交。
- 公开 LoCoMo/长记忆检索跑分，区分“检索层 evidence recall”与“端到端 QA”，不混报。
- 招募 10–20 个种子测试者，收集 diagnostics。

### E. 发布与运营

- 版本节奏：架构/许可变化走 minor，纯修复走 patch。
- 每个 Release 附：变更说明、签名清单、校验命令、可复现构建结论。
- 发布后 48 小时观察 issue、CI、安装失败率。

## 4. 里程碑

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| M1 公开可验证发布 | `verify:release` 命令、验证文档、Release 启动器资产、CI 校验 | 任意人可对 Release 验签并比对 exe；失败有明确错误码 | 执行中 |
| M2 可信首次安装 | 源码安装路径 + 独立签名安装器；setup 降级为开发入口 | 从恶意 fork 执行 setup 不再被描述为安全安装；官方安装器验签失败即拒绝 | 待开始 |
| M3 开源许可与治理 | OSI 许可证、贡献/安全/行为准则、版权头迁移 | GitHub 识别 OSI license；`npm run check` 通过 | 待许可证决策 |
| M4 公共 QA 与上线 | demo、QA harness、公开跑分、种子测试者 | 陌生人 5 分钟跑通；公开跑分可复现 | 待开始 |

## 5. 需要作者决定的两件事

1. **许可证**：AGPL-3.0-only（推荐，保护网络服务开源）/ Apache-2.0（最大采用）/ MIT（最宽松）。
2. **官方安装器形态**：Windows Authenticode 签名 exe（需要代码签名证书）/ 自托管 Ed25519 签名安装包（无证书成本，用户需校验发布哈希）。

未决定前，先执行不依赖许可证的 M1 供应链工作。

## 6. 风险

- 许可证切换不可逆地影响新增代码；旧提交仍受旧许可约束，需在 README 说明时间边界。
- 单把 Ed25519 私钥是单点；开源后必须离线保管并准备轮换。
- 独立安装器仍需要“第一次信任”：没有 Authenticode 时，用户必须从官方 Release 校验安装器哈希/签名。
- 公开 QA 若只报有利指标会被质疑；必须同时公开失败样本、环境与原始日志。
