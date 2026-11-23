# 全息记忆（Omni Memory）

> 给任意 AI 宿主的长期记忆内核：DSH 原生插件，MCP / HTTP / OpenAPI / CLI 通用接入；**只增不改的原文留底 + 会自我校验的结论 + 按项目分层 + 四路混合召回 + 可复用的故障经验沉淀**。

> ⚠️ **许可提醒**：本项目采用 **全息记忆个人使用许可 1.1** —— 仅允许个人、非商业使用；
> **禁止任何形式的商业使用**，包括直接商用、修改后商用，以及复制、改写或提取本软件
> **源码/架构**后做商业替代、竞品或商业服务；且**必须署名作者**。
> 商用请走 [商业授权](#商业授权) 流程。

[![tests](https://img.shields.io/badge/tests-380%2F380-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-Personal%20Use%201.1-lightgrey)](LICENSE)

---

**完整机理与接口参考**：[`docs/REFERENCE.md`](docs/REFERENCE.md) —— schema、写入与检索机理、25 个 MCP 工具（23 个内核工具 + `memory_context` / `memory_rules` 适配工具）、21 条路由、MCP 协议面、CLI、环境变量、AI 调用剧本。执行 `npm run memory:sync` 可把整本手册拆成笔记写进记忆库，之后用 `memory_search` 就能直接检索到。

## 它解决什么问题

普通对话记忆要么"全记"（噪声爆炸），要么"靠模型自觉"（漏记）。全息记忆把两件事拆开：

| 层 | 谁负责 | 特点 |
|---|---|---|
| **转录**（原文） | 系统自动 | 只增不改、可检索、可按上限墓碑化 |
| **结论**（笔记/事实） | 模型判断后写入 | 带来源、可校验、可遗忘、可修订 |
| **事实** | 结构化三元组 | 双时态（何时为真/何时失效），冲突自动失效旧值 |
| **实体图** | 事实自动生成 | 支持 2 跳关联召回 |
| **分层** | 按工作目录自动判定 | 全局规则 vs 项目专属，互不污染 |

## 核心能力

- **混合检索**：词面（FTS5 trigram + 中文二元索引）+ 向量（内置 BGE-small-zh int8 本地语义，512 维；可选接远程嵌入）+ 图游走，四路 RRF 融合排序；可选 cross-encoder rerank（Jina / Cohere / SiliconFlow / 自建兼容端点），只对 top-20 候选做 0..1 归一化后混合，exact problemKey 命中始终优先
- **会话自动捕获**：`memory_ingest` 把任意宿主的对话轮次落成转录与待审候选；候选先 pending，`memory_candidate` 接受后才成为正式笔记，不让人写库成为唯一入口
- **经验巩固**：`memory_consolidate` 按 `problemKey` 把多条活跃笔记压成带来源链的摘要；默认 dry-run，应用时只写 `superseded_by`，不删除原行
- **分层画像**：注入画像显式分为 `## 全局`、`## 当前项目`，事实段单独保留，项目规则不再和全局规则混在一起
- **结论优先去重**：同一段文本同时命中 chunk 与已接受 note 时，搜索结果保留 note/fact，不让原始转录遮住结论
- **故障经验库**：笔记可带 `problemKey` 问题指纹、`solutionStatus`（verified / unverified / failed / expired）和证据；精确指纹优先命中，已验证解法排在失败尝试之前
- **复用闭环**：`memory_solution_report` 在真实复用后回写成功/失败/过期，成功累计 `reuseCount` 并标记 verified，失败尝试保留下来避免重复走死路
- **自动召回**：每轮用你的消息预取 top-3 注入上下文（可关）
- **模型复核归类（可选）**：写入先按规则落层；显式开启后，后台让模型复核，判错自动迁移并留痕。默认关闭，不把正文发给外部模型
- **冲突标记**：显式声明或近重复自动标记 `contested`，只标记不删除；画像与自动召回默认排除 contested
- **做梦校验**：离线拿转录核对笔记，发现"与原文矛盾"时**只标记为待复核**；替代需单条确认（`memory_dream_replace`），且可一键反替代
- **记忆星图**：整屏旋臂星系，拖拽旋转/滚轮缩放/分层切换；**单击任意星点弹出记忆卡**，搜索命中会亮起脉冲光环
- **活跃视图**：列表/搜索默认只显示活跃记忆；历史（被替代、已删除、已失效）通过面板「审计」查看并可单条**恢复**
- **备份/导出/导入**：`memory_export` 导出可移植 JSON（含墓碑与待审候选），`memory_import` 合并导入（默认 dry-run），`memory_restore` 复活单条
- **多客户端并发**：同一台机器上多个 AI 客户端各起一个服务进程，共用一个 `omni.db`；写入等待而不是报锁错，去重与事实失效在写锁内完成，迁移/索引重建/做梦由全机唯一的租约持有者执行（见 [ADR-028](docs/ADR/028-multi-process-concurrency.md)）
- **隐私**：全部数据在本地 SQLite（`$OMNI_HOME/memory/omni.db`，未设置时回退 `$DSH_HOME`），HTTP 只监听 loopback；写操作只接受 POST 并校验 Origin/CSRF 头

## 安装

### 插件市场

在 DSH 插件市场搜索「全息记忆 / Omni Memory」安装，重启或刷新后左栏出现「全息记忆」入口。

**语义检索开箱即用**：安装包自带 `BAAI/bge-small-zh-v1.5` int8 ONNX 模型（22.8 MiB）与 ONNX Runtime WASM（14.2 MiB），进程内 CPU 推理、默认离线；不需要安装 Ollama、LM Studio，不需要拉模型，不需要 API key。首次打开库时后台回填，新写入笔记在下一批立即进入语义索引。

> 项目已由 `dsh-omni-memory` 更名 `omni-memory`。旧安装请移除 `@local/dsh-memory`，再安装 `@local/omni-memory`；两者共用同一份 `omni.db`，数据不受影响。

### 本地安装（开发者）

```bash
cd /path/to/omni-memory
npm test          # 380 个用例
npm run check     # 语法、文档计数与模型资产完整性校验
```

然后在 DSH 插件管理器中选择本地目录安装。

### 怎么知道云端更新了

三个地方都能看到当前版本：HTTP 面板顶栏的 `vX.Y.Z` 角标、`GET /health` 的 `version`、`GET /omni-memory/status` 与 `/overview` 的 `version` 字段。历史版本看 [GitHub Releases](https://github.com/wangzhen110/omni-memory/releases)，每个 `vX.Y.Z` 都有对应 tag 和变更说明。

如果希望本机自动跟上云端，每天第一次记忆操作前运行一次：

```bash
node scripts/daily-sync.mjs
```

它读取 GitHub `main` 的 `package.json`，仅在远端版本更高且 tracked 文件干净时快进合并；更新后用 `node --check` 校验，失败自动回滚，再重启 `OmniMemory7788` 并等 `/health` 返回新版本。同一天重复调用直接返回 `already-ran-today`；`--check` 只检查，`--force` 强制重查，`--no-restart` 只更新代码。

### 在 DSH 之外使用（MCP / HTTP / CLI）

同一份内核可以脱离 DSH 运行，三个入口共用一个本地记忆库：

- `hosts/mcp/bin.mjs` — 零依赖 stdio MCP 服务，Claude Code、Cursor、Cline、Codex CLI、Zed 都能接
- `hosts/http/server.mjs` — 独立面板 + REST（直接挂载插件原有的 21 条路由）+ HTTP 上的 MCP（`POST /mcp`）
- `hosts/cli.mjs` — `omni rules / context / search / serve / mcp`
- `GET /omni-memory/packet` — 面向无 MCP 宿主的可注入记忆包；`openapi.json` 与 `POST /tool` 给 OpenAPI/function-calling 客户端
- `POST /omni-memory/ingest` / `GET /omni-memory/candidates` / `POST /omni-memory/candidate` — 会话自动捕获与候选审阅；Claude Code 的 `SessionStart`/`Stop` hook 可用 `omni ingest --stdin`

无 MCP 宿主的接入方式与能力边界见 [`docs/HOST-ADAPTERS.md`](docs/HOST-ADAPTERS.md)。

**规则怎么送到模型**：MCP 没有系统提示注入点，所以准备五条通道，同一份文本、永不漂移：

1. `initialize` 返回的 `instructions`
2. `prompts/get` 的 `omni-bootstrap`（可带当前任务一起返回）
3. `resources/read` 的 `omni://rules`
4. 工具 `memory_rules`
5. `omni rules --write` 把托管区块写进项目自己的 `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `.clinerules`；区块幂等，可以挂在 SessionStart 钩子上反复执行

```bash
node hosts/mcp/bin.mjs            # stdio MCP
node hosts/cli.mjs serve          # 面板 http://127.0.0.1:7788
node hosts/cli.mjs rules --write  # 把规则写进项目规则文件
node hosts/cli.mjs context --query "当前任务"   # 给 hooks 拼上下文用
```

接入配置、能力边界与自检方法见 [`hosts/mcp/README.md`](hosts/mcp/README.md)。

## 配置

所有开关通过环境变量控制，**修改后需重启宿主进程**（DSH 或 MCP/HTTP 进程）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `OMNI_HOME` | 先 `$DSH_HOME`，再 `~/.dsh` | 数据根目录；非 DSH 宿主靠它指向同一个库 |
| `OMNI_AUTO_RECALL` | 开 | `0` 关闭每轮自动召回 |
| `OMNI_SCOPE_JUDGE` | `off` | 模型复核归类：`off` / `auto` / `always`；开启后写入正文会发给复核模型 |
| `OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL` | 自动 | 指定复核用的模型 |
| `OMNI_PERSONA_MODEL` | `off` | `auto`/`on` 允许后台 persona 自动提炼调用宿主模型；默认只用离线规则 |
| `OMNI_DISABLE_SEMANTIC` | 未设置 | `1` 关闭内置本地语义路线（诊断或极低内存环境用） |
| `OMNI_SEMANTIC_MODEL_DIR` | 包内 `models/bge-small-zh-v1.5` | 换用其他同结构 BGE int8 模型目录 |
| `OMNI_SEMANTIC_BATCH` | `8` | 本地语义每批推理条数（1–64） |
| `OMNI_EMBED_URL` | 未设置 | 可选：接 OpenAI 兼容 `/embeddings` 覆盖为远程向量后端 |
| `OMNI_EMBED_MODEL` | `text-embedding-3-small` | 远程嵌入模型 |
| `OMNI_EMBED_KEY` | — | 远程嵌入鉴权 |
| `OMNI_EMBED_PROVIDER` | 未设置 | 预设：openai / dashscope / zhipu / siliconflow / **ollama / lmstudio**（本机 OpenAI 兼容嵌入；不内置模型） |
| `OMNI_EMBED_BATCH` | `64` | 每请求最大输入条数 |
| `OMNI_EMBED_RETRIES` | `2` | 429/5xx 重试次数（250ms、750ms 退避） |
| `OMNI_EMBED_TIMEOUT_MS` | `10000` | 远程嵌入超时 |
| `OMNI_RERANK_PROVIDER` | 未设置 | `cohere` / `jina` / `siliconflow`，自动填 URL 与模型 |
| `OMNI_RERANK_URL` | 未设置 | 自建或兼容 rerank 端点；未设置则完全跳过重排、零额外延迟；只发送 query + top-20 候选正文 |
| `OMNI_RERANK_KEY` / `OMNI_RERANK_API_KEY` | — | rerank 鉴权 |
| `OMNI_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | cross-encoder 模型名 |
| `OMNI_RERANK_TIMEOUT_MS` | `5000` | rerank 超时；失败时回落到融合排序，不影响主结果 |
| `OMNI_DREAM_INTERVAL_MS` | `0`（关） | 定时做梦校验 |
| `OMNI_DISABLE_VECTOR` | 未设置 | `1` 同时关闭 hashed/远程向量与内置语义（诊断用） |
| `OMNI_DISABLE_GRAPH` | 未设置 | `1` 关闭图路线 |

## 模型工具

| 工具 | 作用 |
|---|---|
| `memory_write` | 写入笔记 / 事实 / 原始观察；笔记可带 `problemKey` / `solutionStatus` / `evidence`（事实可声明 `cardinality: multi` 保留多值） |
| `memory_ingest` | 接收一条对话轮次：写转录 chunk，并按确定性规则抽取最多 3 条 pending 候选；支持 Claude Code hook JSON（`--stdin`） |
| `memory_candidate` | `list` / `accept` / `reject` 候选；接受后才写入正式 note，拒绝保留原因与审计 |
| `memory_consolidate` | 按同一 `problemKey` 巩固活跃笔记：默认 dry-run，`apply` 写来源链摘要并 supersede 原行，反馈计数汇总 |
| `memory_search` | 混合检索（支持全局 / 项目 / 全部）；可按 `problemKey` 精确查，按 `status` / `kind` 过滤 |
| `memory_solution_report` | 记录解法真实复用结果：`success` 标记 verified 并累计次数，`failed` / `expired` 更新状态 |
| `memory_feedback` | 给召回结果投票 `useful` / `misleading`，计入排序信号；错误召回不再反复污染上下文 |
| `memory_get` | 按 `{kind,id}` 展开完整正文，最多 20 条；默认当前项目 + global，`all` 显式跨项目 |
| `memory_amend` | 修订一条笔记：新 revision 生效，旧行保留并指向新行，审计链不丢 |
| `memory_profile` | 读取常驻画像 |
| `memory_timeline` | 某实体的时间线（事实 + 相关笔记） |
| `memory_forget` | 墓碑化一条记忆 |
| `memory_dream` | 拿转录核对笔记（默认 dry-run；`apply` 只标记，`commit` 才批量替代） |
| `memory_dream_proposals` | 列出待确认的替代候选（只读） |
| `memory_dream_replace` | 单条替代（需 `confirm: true`） |
| `memory_dream_rollback` | 反替代：复活原笔记、墓碑化生成笔记 |
| `memory_compact` | 转录增长治理（默认 dry-run） |
| `memory_reindex` | 回填缺失向量（hashed / remote）；`bigrams: true` 一次重建全库 CJK 两字索引 |
| `memory_link_entity` | 登记实体别名并合并事实/边（默认 dry-run） |
| `memory_persona` | 读取/修正/自动提炼用户设定：称呼 / 性格 / 习惯 / 偏好 / 其他；刷新默认保留手工字段，`useModel: true` 才调用宿主模型 |
| `memory_export` | 导出 JSON 备份（默认含墓碑与待审候选；`activeOnly` 只导活跃） |
| `memory_import` | 合并导入备份（默认 dry-run，按内容去重，重建向量） |
| `memory_restore` | 恢复一条被墓碑化的记忆（重建索引） |

## 数据与隐私

- 数据文件：`$DSH_HOME/memory/omni.db`（SQLite WAL，单文件，备份即复制；**默认明文落盘，未加密**）
- 备份交换目录：`$DSH_HOME/memory/backups/`（`memory_export` / `memory_import` 只接受该目录内的单个 `.json` 文件名；可用 `OMNI_BACKUP_DIR` 改到受控位置）
- 所有 HTTP 路由仅绑定 loopback，非本机请求返回 403；写操作只接受 POST，`Host` 必须是本机回环名、绑定地址或 `OMNI_TRUSTED_HOSTS`，`Origin` 必须同主机同端口，并校验 `x-omni-csrf` 头；`Sec-Fetch-Site: cross-site` 直接拒绝
- 不主动上传任何内容；只有显式配置 `OMNI_EMBED_URL`（或远程 `OMNI_EMBED_PROVIDER`）时，文本才会发送到该嵌入端点；只有显式配置 `OMNI_RERANK_*` 时，查询与候选记忆正文才会发送到该重排端点。敏感数据建议用自建端点；默认 hashed 向量 + 无 rerank 完全不出机。`OMNI_SCOPE_JUDGE` 默认 `off`，不会把写入正文发给模型
- persona 自动刷新默认只用离线规则；只有显式 `useModel: true` 或 `OMNI_PERSONA_MODEL=auto/on` 才调用宿主模型，且证据只取全局层，不读取项目内容

## 测试与指标

- 自动化用例：**380 / 380 通过**
- 检索延迟（本机复核，**3.10.1 数据；3.10.4 未重跑，不作为 3.10.4 实测**；Node 22.23.2；标准 bench 已改为 global scope 并断言真实命中）：10,000 行 p95 ≈ **2.4ms**；100,000 行 ≈ 2.4ms；1,000,000 行 ≈ 6.0ms；1M + 5 万向量 + 100 万 bigram ≈ **116.8ms**（两段式有界检索，见 ADR-020）
- 3.11.x 发布基准（`bench/release.mjs`，隔离临时库，无向量压力，5 次中位数，DSH 后台运行）：100k 写入 **4.4–4.6ms** / `/list` 96.4–99.1ms / `/overview` 187.2–193.0ms / 检索 2.8–3.2ms / 稳态打开 10.6ms；1M 写入 **4.6ms** / `/list` 966.4–976.2ms / `/overview` 2026–2136ms / 检索 2.8–2.9ms / 稳态打开 46.5ms。高负载复跑会慢 1.1–2.3 倍，文档给区间；1M 面板全库统计超出 300ms 交互预算，检索与写入不受影响。原始值、迁移与机器信息见 [发布基准](docs/BENCH-3.11.0-2026-11-22.md)
- 黄金集（20 语料 / 24 问题）：词面 MRR 0.776 → 旧 hashed 混合 0.927 → 内置本地语义单独 **0.979**；语义冷加载约 208ms，单查询约 9.5ms（20 次 191ms，本机 CPU）

```bash
npm test
npm run bench          # 延迟基准
npm run bench:golden   # 黄金集
```

## 兼容性

- DeepSeek Harness 0.2.2-rc.3（Desktop，Windows）
- Node 24（使用内置 `node:sqlite`，无原生编译依赖）
- 客户端零依赖：星图为 Canvas 2D 手写投影，不引入 three.js 等库

## 文档

- [设计规格](docs/DESIGN.md)（需求、架构、数据模型、契约、失败模式、追溯矩阵）
- [架构决策记录](docs/ADR)（31 份）
- [威胁模型](docs/THREAT-MODEL.md)（信任边界、残余风险、新增路由检查清单）
- 备份/恢复设计见 [ADR-019](docs/ADR/019-backup-restore.md)
- 1M 行检索改造见 [ADR-020](docs/ADR/020-bounded-retrieval.md)
- 做梦校验的安全边界见 [ADR-021](docs/ADR/021-dream-manual-confirmation.md)
- 进程鉴权与加密的评估结论见 [ADR-022](docs/ADR/022-process-auth-and-encryption.md)
- 多值关系设计见 [ADR-023](docs/ADR/023-multi-valued-relations.md)
- 实体别名与多值画像见 [ADR-024](docs/ADR/024-entity-aliases.md)
- 用户设定见 [ADR-026](docs/ADR/026-persona-settings.md)
- 故障经验库见 [ADR-027](docs/ADR/027-problem-experience.md)
- 多进程并发（多个 AI 客户端共用一个库）见 [ADR-028](docs/ADR/028-multi-process-concurrency.md)
- 远程 embedding 加固与 ANN 边界见 [ADR-025](docs/ADR/025-remote-embedding-and-ann.md)
- [更新日志](docs/CHANGELOG.md)
- [逐次更新记录](docs/UPDATES.md)
- [3.9.0 自动捕获与巩固完成报告](docs/COMPLETION-2026-11-21.md)
- [3.9.1 复核问题修复报告](docs/COMPLETION-3.9.1-2026-11-21.md)
- [3.9.2 零配置语义整改报告](docs/COMPLETION-3.9.2-2026-11-21.md)
- [3.9.3 语义索引治理报告](docs/COMPLETION-3.9.3-2026-11-21.md)
- [3.9.4 跨平台项目键与 scope 迁移报告](docs/COMPLETION-3.9.4-2026-11-21.md)
- [3.9.5 语义可靠性收尾报告](docs/COMPLETION-3.9.5-2026-11-21.md)
- [3.10.0 记忆概览仪表盘](docs/WEB-UI-3.10.0-2026-11-21.md)
- [属性测试落地记录（348 用例）](docs/PROPERTY-TESTING-ROLLOUT-2026-11-21.md)
- [项目 scope alias 决策](docs/ADR/031-project-scope-alias.md)
- [架构图](docs/architecture.png)

## 许可证

**全息记忆个人使用许可 1.1**（仅限个人 · 禁止任何商用）— 不是 OSI 开源许可，源码公开可读。

- ✅ 可以：个人使用、学习、研究、复制、修改、二次开发、借鉴设计，发布你的非商业修改版
- 🚫 不可以：任何形式的商业使用；包括直接商用、修改后商用，以及拿本项目的**源码或架构**去复制、改写、重写、反向工程或做商业替代品、竞品、商业插件、SaaS
- ⚠️ 必须：**署名作者**（保留作者、项目链接、协议声明；修改需注明「已修改」）

最低署名写法（可直接复制）：

```markdown
基于「全息记忆 (Omni Memory)」by wangzhen110
https://github.com/wangzhen110/omni-memory · 全息记忆个人使用许可 1.1
已修改
```

完整署名规则与更多模板见 [ATTRIBUTION.md](ATTRIBUTION.md)，法律文本见 [LICENSE](LICENSE)。

### 商业授权

需要商业使用（公司内部生产经营、付费服务、SaaS/托管、外包交付、销售/转售/捆绑收费等）时，
请先取得作者书面许可。

**优先渠道（推荐）**：在仓库开 Issue，公开可追踪、回复更快
https://github.com/wangzhen110/omni-memory/issues

**备用渠道**：64271785@qq.com（标题请注明「商业授权 + 用途」）

作者会在 3 个工作日内回复授权范围与费用。

