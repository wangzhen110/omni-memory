# 贡献指南

感谢你愿意改进「全息记忆」。这是一个本地优先的个人记忆服务，代码、文档和契约都在同一个仓库里。

## 开始之前

- 读 [`docs/DESIGN.md`](docs/DESIGN.md) 与 [`docs/ADR/`](docs/ADR/)：数据模型、检索边界、更新链和许可决策以这里为准。
- 不要在 Issue 里贴数据库、令牌、私钥、真实记忆内容。安全问题走 [`SECURITY.md`](SECURITY.md)。
- 功能改动先开 Issue 或 Draft PR，避免大改后才发现方向不一致。

## 开发与验证

```bash
npm ci
npm test          # 全量测试
npm run check     # 测试 + 工具数/路由/ADR/版本/语法门禁
```

提交前必须两条都通过。只改文档也要跑 `npm run check`，它会校验版本、ADR 数量与文档口径。

新增行为至少包含：

- 一条能失败的回归测试，再让它通过。
- 对应文档更新（README / DESIGN / REFERENCE / CHANGELOG 按影响范围）。
- 不引入新的静默失败路径；外部依赖失败要显式区分“不存在”和“未知”。

## 提交规范

使用 Conventional Commits 前缀：

```text
feat: add release-verified setup path
fix: distinguish missing task from unknown schtasks state
docs: clarify AGPL commercial exception
test: cover manifest tampering
chore: bump version to 4.0.0
```

每个提交用 DCO 签名，表示你有权按本仓库许可证提交这些代码：

```bash
git commit -s -m "feat: ..."
```

提交信息里会带 `Signed-off-by: Your Name <you@example.com>`。不需要签 CLA，版权仍归你。

## 许可

除非你在提交时明确另行声明，贡献按 **AGPL-3.0-only** 授权。见 [`LICENSING.md`](LICENSING.md)。提交即表示你同意该许可，并保证你有权提交这些内容。

## 评审与合并

- 维护者会尽量在 7 天内给出第一次实质回复。
- 合并采用 squash 或 rebase，保持 `main` 线性、可回滚。
- 涉及更新链、签名、数据库迁移、许可证的改动需要额外一轮审查。
- 不符合方向、没有测试或引入静默失败的 PR 会被关闭，并说明原因。

## 行为

参与即表示同意 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
