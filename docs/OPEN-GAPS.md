# 未完成项与 C 类记录（2026-11-23）

本页把“还没做”与“不能由助手代做”分开。C 类不是待办代码，而是需要外部资源、真实用户或独立第三方才能完成的事项；先记录，不伪造成已完成。

## C 类：需要外部条件，当前不完成

| 项 | 为什么当前做不了 | 完成标准 | 记录 |
|---|---|---|---|
| LoCoMo 官方 QA 分数 | 需要答案生成模型 + 官方 judge；本仓库只做检索层 | 在官方脚本/ judge 下复现，报告 QA 准确率与设置 | 未开始；已有检索层数字见 BENCHMARKS.md |
| LongMemEval 官方分数 | 数据集大、需要模型端点与 judge；本地无端点 | 用官方 harness 跑完并报告 | 未开始 |
| 真实用户与社区 | 不能由助手制造；需要真实使用、反馈、issue、复现 | 至少 10 个独立用户、3 个外部 issue/PR、1 个第三方复现 | 当前仓库社区指标接近零 |
| macOS 真机验收 | 当前只有 Windows 与 Linux CI，没有 Mac 设备 | 在真实 Mac 上安装、运行 `omni doctor`、MCP/HTTP/面板冒烟 | 未开始 |
| 独立安全审计 | 需要第三方按威胁模型审计；自审不算独立 | 外部审计报告 + 高危项闭环 | 仅内部 THREAT-MODEL/AUDIT 文档 |
| 商业许可法律审阅 | 需要执业律师确认条款与合同模板 | 律师出具审阅意见 | `LICENSING.md` 只是框架，不是法律意见 |

## A/B 类：代码可做，但本轮仍未闭环

| 项 | 现状 | 下一步 |
|---|---|---|
| FTS5 构建差异 | Linux CI 的 Node 构建没有 FTS5；产品退化为 LIKE，FTS5 专项测试 skip | 提供可选的 FTS5 构建说明/自编译脚本；或在 Linux 上用带 FTS5 的 Node 复测 |
| 多进程并发压测 | 已有真实多进程正确性测试（`concurrency.test.mjs`、迁移并发），但没有并发吞吐/延迟压测 | 两进程持续写入 + 检索，记录 busy/retry、p95 与丢行数 |
| 远程 HTTP 鉴权 | loopback-only，明确不暴露 LAN | 若要托管，需要 token/OAuth、TLS、租户隔离；不能只改 bind |
| Docker HTTP 入口 | 容器只提供 stdio MCP | 远程 HTTP 方案确定后再加；现在加端口没有意义 |
| 密钥扫描 | 未接入 CI | 可加 gitleaks 或等价规则；当前 `.pem`/`.git-credentials` 在仓库外 |
| 依赖审计 | CI 已加 `npm audit --omit=dev --audit-level=high`；本地尚未跑 | 以首次 CI 结果为准 |
| 1M + 语义向量复测 | 已有 1M 无语义数据；语义全量索引成本高 | 单独跑 1M + 本地语义，记录内存与 p95 |
| 跨平台安装包 | 只有 Windows launcher 与源码安装 | macOS/Linux 安装脚本与签名 |

## 已在本轮补上的

- 规模/字符体积：`bench/scale.mjs`，100k 短笔记、10k 长笔记各 10M 字符。
- 质量集：`bench/quality-lib.mjs`、`bench/quality.mjs`、`test/memory-quality.test.mjs`，120/120。
- 公开检索：`bench/fetch-public.mjs`、`bench/public-retrieval.mjs`，LoCoMo session/turn 两种粒度。
- 恢复演练：`test/recovery-drill.test.mjs`，导出备份 → 全新库导入 → 检索可命中。
- 可观测性：`/metrics`（loopback-only，进程/请求/MCP/内存计数）。
- 交付：`Dockerfile`、`.dockerignore`、Linux/Docker 文档、CI container job。
- 许可：`LICENSING.md` 双轨框架 + 修正商业授权 Issue 模板。
- **3.12.1 A-06**：大库自适应窗口/采样；本机 1M + 5 万向量 + 100 万 bigram p95 226.9ms → 129.4ms，报告机器同配置 257ms；黄金集 full MRR 0.979 无退化。
- **3.12.1 C-02**：`OMNI_OPEN_LEASE_WAIT_MS`（默认 150s）替代固定 5s；新增 `test/open-lease-wait.test.mjs`，6s 持锁后第二个打开者成功。
- **3.12.2 复审 P2/P3**：churn 库按活行数判定大库，新增 16,000 墓碑 + 1 活行回归；setup 明文改为“同提交 SHA-256 自洽，不验 Release 签名”；`schtasks` 探测区分 missing/unknown，unknown 拒绝建任务；doctor 小库 `<4096` 降为 warn。

## 判断规则

- 没有真实数据就不写“已超越”“官方分数”“生产就绪”。
- 没有第三方复现就不写“社区验证”。
- 没有 Mac 设备就不写“macOS 已验证”；CI 的 Linux 结果也不能替代 macOS。
