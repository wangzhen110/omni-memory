# 全息记忆（Omni Memory）

> **让 AI 不再失忆的本地长期记忆底稿。** 换模型、换宿主、重启之后，记忆还在：转录留底，笔记可校验，事实会失效，星图把关系连起来。

[![tests](https://img.shields.io/badge/tests-584%2F584-brightgreen)](#测试与指标)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-8de1ff)](#本地安装开发者)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

![全息记忆 · 记忆底稿](docs/images/hub.png)

[查看完整档案索引](docs/images/hub-full.png)

**它不是聊天记录导出，也不是把上下文窗口调大。** 它把「原文」「结论」「事实」「关系」分成四层：原文只增不改，笔记带来源可校验，事实有有效期，关系进星图；检索时四路召回，只把相关的那一小段送回模型。

**完整机理与接口参考**：[`docs/REFERENCE.md`](docs/REFERENCE.md) —— schema、写入与检索机理、30 个 MCP 工具（28 个内核工具 + `memory_context` / `memory_rules` 适配工具）、26 条路由、MCP 协议面、CLI、环境变量、AI 调用剧本。执行 `npm run memory:sync` 可把整本手册拆成笔记写进记忆库，之后用 `memory_search` 就能直接检索到。

## 5 分钟跑起来

```bash
git clone https://github.com/wangzhen110/omni-memory.git
cd omni-memory
npm ci
npm run demo                   # 隔离临时库，写入 + 召回，不碰真实数据
```

看真实服务：

```bash
npm run serve                  # 打开 http://127.0.0.1:7788/hub
```

Windows 官方安装（发布验签，安装计划任务并启动 7788，静默无黑框）：

```powershell
git checkout v4.6.18
npm ci
npm run setup:dry:release      # 先看计划，并验证官方 Release 签名
npm run setup                  # 验签通过才落盘；不通过不碰正在运行的服务
node hosts/cli.mjs doctor      # 逐项诊断 Node、数据库、语义资产、服务与任务
```

`setup` 不是“同提交哈希自洽”的旧路径：它要求 HEAD 等于签名 commit、工作树干净，并验证 Release Ed25519 清单与启动器 SHA-256。开发检出用 `npm run setup:dev`。完整步骤见 [`docs/QUICKSTART.md`](docs/QUICKSTART.md)，信任边界见 [`docs/INSTALL-RELEASE.md`](docs/INSTALL-RELEASE.md)。

macOS / Linux 或不想装计划任务：

```bash
npm run serve
```

**手机端长这样**（真实截图，竖屏只读搜索）：

![全息记忆 · 手机底稿](docs/images/mobile.png)

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

- **项目代码索引（v4.6.0）**：`omni index --dir <项目>` 一条命令建立可增量重建的模块、符号、API 与依赖索引；源码始终是权威，索引只是缓存。`project_search` / `project_context` / `project_impact` 精确回答“函数在哪、签名是什么、接口契约是什么、改它会波及谁”，并与 note/fact 里“为什么、历史、坑”合并（详见下方「项目代码索引」）
- **混合检索**：词面（FTS5 trigram + 中文二元索引）+ 语义优先（内置 BGE-small-zh int8，512 维；语义不可用或空结果时用 hashed/远程向量兜底）+ 图游走，RRF 融合排序；可选 cross-encoder rerank（Jina / Cohere / SiliconFlow / 自建兼容端点），只对 top-20 候选做 0..1 归一化后混合，exact problemKey 命中始终优先
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

## 项目代码索引

记忆库解决“为什么、历史、坑”，代码索引解决“在哪、叫什么、签名、契约、波及谁”。两者共用同一个 scope，不互相替代。

```bash
node hosts/cli.mjs index --dir D:\xiangmu\全息记忆          # 建立或增量重建
node hosts/cli.mjs project status --dir D:\xiangmu\全息记忆  # 文件/符号/API/stale
node hosts/cli.mjs project search login --dir D:\xiangmu\全息记忆
node hosts/cli.mjs project impact lib/project-index.mjs --dir D:\xiangmu\全息记忆
```

- **schema 20 五张派生表**：`code_files`、`code_symbols`、`code_apis`、`code_modules`、`code_edges`；不存源码正文，只存路径、行号、签名、短摘要和 sha256。
- **适配器**：JS/TS 导出、函数、类、方法、导入与 Express/Koa/Fastify/Next/装饰器路由；OpenAPI/Swagger JSON+YAML；GraphQL SDL；Python/Go/Rust/Java/Kotlin/C#/PHP/Ruby/GDScript/Lua/Swift/Dart 走 generic，可选 universal-ctags 增强。
- **增量与漂移**：mtime+size 未变时仍比对 sha，内容变了会被识别；删除的文件在下次同步清理；查询时按当前文件 stamp 标 `stale`/`missing`。
- **四个入口**：CLI、5 个 `project_*` MCP 工具（`project_sync` / `project_search` / `project_context` / `project_status` / `project_impact`）、5 条 `/omni-memory/project/*` HTTP 路由、`/project` 页面。
- **与记忆合并**：`memory_context` 命中项目引用时追加有预算的项目包；每条结论带 `sourceRef`、行号、`sha` 和 `stale`，需要“为什么/历史/坑”时再回 note/fact。

## 安装

### 插件市场

在 DSH 插件市场搜索「全息记忆 / Omni Memory」安装，重启或刷新后左栏出现「全息记忆」入口。

**语义检索开箱即用**：安装包自带 `BAAI/bge-small-zh-v1.5` int8 ONNX 模型（22.8 MiB）与 ONNX Runtime WASM（14.2 MiB），进程内 CPU 推理、默认离线；不需要安装 Ollama、LM Studio，不需要拉模型，不需要 API key。首次打开库时后台回填，新写入笔记在下一批立即进入语义索引。

> 项目已由 `dsh-omni-memory` 更名 `omni-memory`。旧安装请移除 `@local/dsh-memory`，再安装 `@local/omni-memory`；两者共用同一份 `omni.db`，数据不受影响。

### 本地安装（开发者）

```bash
cd /path/to/omni-memory
npm test          # 584 个用例，TAP 真值汇总
npm run check     # 语法、文档计数与模型资产完整性校验
npm run verify    # npm test + npm run check，发布前真值门
```

然后在 DSH 插件管理器中选择本地目录安装。

### 怎么知道云端更新了

三个地方都能看到当前版本：HTTP 面板顶栏的 `vX.Y.Z` 角标、`GET /health` 的 `version`、`GET /omni-memory/status` 与 `/overview` 的 `version` 字段。历史版本看 [GitHub Releases](https://github.com/wangzhen110/omni-memory/releases)，每个 `vX.Y.Z` 都有对应 tag 和变更说明。

AI 读取记忆时也会自动检查：`memory_context`、CLI `context` 和 `/omni-memory/packet` 在返回内容前检查云端 `main/package.json`；发现更高版本就在返回文本顶部提示“云端有新版，是否更新由用户决定”。成功结果缓存 30 分钟，网络失败 5 分钟后再试，Contents API 与 raw 回退共享 2.5 秒总预算，检查失败不会阻塞记忆读取。读取路径只报告，不自动执行更新，也不会重启服务。

看到上面的版本提醒后，由用户决定是否在项目根目录运行一次：

```bash
node scripts/daily-sync.mjs --apply
```

不带参数时只报告 `update-available` / `up-to-date`，**不合并、不重启**。`--apply` 才执行更新：它优先从 GitHub Release 下载 `omni-update-manifest-v2.json`，用内置的 Ed25519 公钥验签，校验签名清单里的版本、`package.json` SHA-256、启动器 SHA-256 和提交谱系；只快进到签名提交，不把任意 `origin/main` 合并进来。v1 清单继续兼容 3.11.8 之前的客户端。工作树有 tracked 修改时拒绝执行；校验失败回滚到更新前提交。`--restart` 才会重启 `OmniMemory7788`，`--run-tests` 可在快进后额外跑 `npm test`。同一天重复调用直接返回 `already-ran-today`；当天已同步过但仍想重试，必须显式加 `--force`。`--check` 只检查。脚本默认只操作自身所在的 checkout，并校验包名与 `origin` 必须是 `wangzhen110/omni-memory`。

3.11.5 及更早的更新链没有签名校验；3.11.6 是第一个带签名清单的 Release。3.11.8 起 v2 清单把启动器二进制也纳入签名范围，安装时先落内容寻址副本再切换计划任务，运行中的 exe 不被覆盖。公钥指纹与私钥保管方式见 [`docs/UPDATE-SIGNING.md`](docs/UPDATE-SIGNING.md)。

### 验证发布物

```bash
npm run verify:release -- --tag v4.6.18
npm run verify:release -- --tag v4.6.18 --launcher ./omni-serve-7788.exe
```

第一条会下载官方 Release 的签名清单，用内置 Ed25519 公钥验签，再比对签名 commit 上的 `package.json` 与启动器 SHA-256。第二条额外验证你从镜像或第三方渠道拿到的启动器字节。它只读，不安装、不重启、不移动 HEAD；`npm run setup` 已默认走这条发布验签路径，不再使用“同提交哈希自洽”的旧边界。完整说明见 [`docs/VERIFY-RELEASE.md`](docs/VERIFY-RELEASE.md)。

### 7788 静默启动器（Windows）

计划任务 `OmniMemory7788` 由仓库内的 GUI 子系统启动器（`/target:winexe`）启动，不创建控制台。启动器读取 `~/.dsh/omni-serve-7788.json` 侧车配置，仓库、Node、端口和日志路径都不再硬编码；端口被非 omni 进程占用时拒绝启动，只清理命令行精确匹配 `hosts\cli.mjs serve --port 7788` 的旧监听。

```powershell
# 从当前签出的提交安装并切换计划任务（默认不重启服务）
node scripts/install-launcher.mjs --apply

# 校验提交、package.json 和启动器 SHA-256 后重启
node scripts/install-launcher.mjs --apply --restart

# 卸载计划任务和侧车配置；默认保留日志、数据库与旧二进制
node scripts/uninstall-launcher.mjs

# 一并删除启动器二进制与日志（数据库永不删除）
node scripts/uninstall-launcher.mjs --remove-binaries --remove-logs
```

`npm run check` 包含 C# 编译与二进制一致性门禁；`node scripts/build-launcher.mjs --check` 可单独复核可复现构建。源码、配置字段和回滚方式见 [`docs/SILENT-LAUNCHER.md`](docs/SILENT-LAUNCHER.md)。

### 在 DSH 之外使用（MCP / HTTP / CLI）

同一份内核可以脱离 DSH 运行，三个入口共用一个本地记忆库：

- `hosts/mcp/bin.mjs` — 零依赖 stdio MCP 服务，Claude Code、Cursor、Cline、Codex CLI、Zed 都能接
- `hosts/http/server.mjs` — 独立面板 + REST（直接挂载插件原有的 26 条路由）+ HTTP 上的 MCP（`POST /mcp`）
- `hosts/cli.mjs` — `omni rules / context / search / write / index / project / serve / doctor / mcp`
- `GET /omni-memory/packet` — 面向无 MCP 宿主的可注入记忆包；`openapi.json` 与 `POST /tool` 给 OpenAPI/function-calling 客户端
- `POST /omni-memory/ingest` / `GET /omni-memory/candidates` / `POST /omni-memory/candidate` — 会话自动捕获与候选审阅；Claude Code 的 `SessionStart`/`Stop` hook 可用 `omni ingest --stdin`

无 MCP 宿主的接入方式与能力边界见 [`docs/HOST-ADAPTERS.md`](docs/HOST-ADAPTERS.md)。

**规则怎么送到模型**：stdio 与 HTTP 的 `initialize` instructions、`prompts/get`、`resources/read`、`memory_rules` 共享同一份 `RULES_TEXT`；`omni rules --write` 把同一文本写入项目规则文件。五条入口同文，不再维护容易漂移的摘要副本：

1. `initialize` 返回的 `instructions`（stdio 与 HTTP MCP 都是完整 `RULES_TEXT`）
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
| `OMNI_DISABLE_HASHED` | 未设置 | `1` 只关闭 hashed/远程向量，保留本地语义（测量语义单独质量） |
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
- 迁移备份：schema 升级前自动 `VACUUM INTO` 到 `$DSH_HOME/memory/backups/pre-migrate-v<old>-to-v<new>-*.db`，做 `integrity_check`，保留最近 5 份；`OMNI_MIGRATION_BACKUP=0` 可关闭，`OMNI_MIGRATION_BACKUP_KEEP` 可改保留数
- 备份交换目录：`$DSH_HOME/memory/backups/`（`memory_export` / `memory_import` 只接受该目录内的单个 `.json` 文件名；可用 `OMNI_BACKUP_DIR` 改到受控位置）
- 所有 HTTP 路由仅绑定 loopback，非本机请求返回 403；所有路由（含 `/omni-memory/*` 只读路由）都校验 `Host`，只接受本机回环名、绑定地址或 `OMNI_TRUSTED_HOSTS`，伪造 Host 返回带 `error` 的 403；`/export` 只接受 GET，POST 返回 405；写操作只接受 POST，`Origin` 必须同主机同端口，并校验 `x-omni-csrf` 头；`Sec-Fetch-Site: cross-site` 直接拒绝
- 不主动上传任何记忆内容。默认只有读取路径的版本探测会访问 `api.github.com` / `raw.githubusercontent.com`，只发送固定 `User-Agent: omni-memory` 和包路径，不带记忆正文、查询、凭据或时间戳；设置 `OMNI_VERSION_CHECK_DISABLED=1` 可完全关闭。只有显式配置 `OMNI_EMBED_URL`（或远程 `OMNI_EMBED_PROVIDER`）时，文本才会发送到该嵌入端点；只有显式配置 `OMNI_RERANK_*` 时，查询与候选记忆正文才会发送到该重排端点。敏感数据建议用自建端点；关闭版本探测且默认 hashed 向量 + 无 rerank 时完全不出机。`OMNI_SCOPE_JUDGE` 默认 `off`，不会把写入正文发给模型
- persona 自动刷新默认只用离线规则；只有显式 `useModel: true` 或 `OMNI_PERSONA_MODEL=auto/on` 才调用宿主模型，且证据只取全局层，不读取项目内容

## 测试与指标

- 自动化用例：**584 / 584 通过**（TAP 真值汇总，`npm run verify` 拒绝失败/取消的测试）
- 检索延迟（本机复核，**3.12.1/3.12.2 数据**；Node 22.23.2；标准 bench 已改为 global scope 并断言真实命中）：10,000 行 p95 ≈ **2.4ms**；100,000 行 ≈ 2.4ms；1,000,000 行 ≈ 6.0ms；1M + 5 万向量 + 100 万 bigram ≈ **129.8ms**（固定旧边界 226.9ms；3.12.1 自适应收紧窗口/采样，3.12.2 修正为按可召回行数判定，见 ADR-020）
- 3.11.x 发布基准（`bench/release.mjs`，隔离临时库，无向量压力，5 次中位数，DSH 后台运行）：100k 写入 **4.4–4.6ms** / `/list` 96.4–99.1ms / `/overview` 187.2–193.0ms / 检索 2.8–3.2ms / 稳态打开 10.6ms；1M 写入 **4.6ms** / `/list` 966.4–976.2ms / `/overview` 2026–2136ms / 检索 2.8–2.9ms / 稳态打开 46.5ms。高负载复跑会慢 1.1–2.3 倍，文档给区间；1M 面板全库统计超出 300ms 交互预算，检索与写入不受影响。原始值、迁移与机器信息见 [发布基准](docs/BENCH-3.11.0-2026-11-22.md)
- 3.12.0 新增：100k 短笔记 10M 字符检索 p95 **6.9ms**；10k 长笔记 10M 字符 p95 **27.4ms**；120 条确定性质量用例 **120/120**；LoCoMo session 粒度 evidence recall@10 **0.7134**（检索层，不是官方 QA）。完整方法与边界见 [基准与质量实测](docs/BENCHMARKS.md)。
- 3.12.1 修复：1M + 5 万向量 + 100 万 bigram 自适应边界 p95 **129.4ms**（旧固定边界 226.9ms）；第二个打开者等待迁移租约到 **150s**（旧固定 5s，1M 迁移可能 73–80s）。跨进程测试覆盖 6s 持锁后释放。
- 3.12.2 修复：churn 库按活行数判定大库（16,000 墓碑 + 1 活行回归，单字不丢）；`setup` 明确只校验同提交 SHA-256、不冒充 Release 签名；`schtasks` 探测失败不再猜“任务不存在”；doctor 小库 `<4096` 降为 warn。
- 3.12.3 新增：`npm run verify:release` 可从官方 Release 验签，并比对签名 commit 上的 `package.json` 与启动器 SHA-256；`--launcher` 可校验镜像/第三方渠道下载的 exe。只读，不安装、不重启。
- 4.0.1：许可证切换为 AGPL-3.0-only；`npm run setup` 改为发布验签 + 干净检出检查；新增 `npm run demo` / `npm run qa`；测试 **438/438**，公共 QA golden 24/24、quality 120/120。
- 4.1.0：`/hub` 与 `/m` 从等宽六卡/星空入口重绘为本机档案索引与手机底稿；真实数据绑定不变；`/star-map.html` 保留原有星图。
- 4.1.1：手机端把三列大数字统计条改成一行档案读数，进一步去掉视频里的“状态三指标”观感；只改排版，不动数据。
- 4.2.0：项目身份改用仓库根 `.omni-project` 稳定键；CLI `--dir` 硬绑定项目层，显式 `--scope global` 才写全局；画像过滤专业知识并支持 `kb-migrate`；搜索默认返回完整 `text`、`score`、`why`、`snippet`、`total`/`offset`，并标记旧版本结论。
- 4.2.1：CLI 未给 `--dir` 时先向上找 `.omni-project`，找不到则回落到 CLI 所在仓库根，避免从 chat cwd 启动时落到 `proj:new-chat`；HTTP `/omni-memory/search` 同步返回 `total`/`returned`/`offset`/`truncated`。
- 4.3.0：CLI `context`/`search` 默认改为词法 + hashed 向量，不再每次冷加载 37.5 MiB 本地语义模型；`--semantic` 或 `OMNI_CLI_SEMANTIC=1` 显式开启。实测同一查询：默认 **139ms**、语义 **478ms**；`context` 默认 **144ms**、语义 **467ms**。搜索返回结构收敛到单一构造点，CLI 参数错误改为一行提示并退出 2。
- 4.3.1：`memory_context` 读路径只读版本缓存，不再等待 GitHub 探针（TTL 强制过期时仍 **142ms**，旧路径 0.5–2.5s）；`memory_write` 校验 `kind` 白名单，非法值返回错误而不是静默落成 note；CLI 布尔 flag 可放在关键词前；HTTP 空查询回填 `scope`；`npm test` 加 `--test-timeout=60000`，避免并行挂起。
- 4.6.0：新增项目代码索引（schema 20 五张派生表、JS/TS/OpenAPI/GraphQL/generic 适配器、增量/sha 漂移/删除清理、CLI/5 个 MCP 工具/5 条 HTTP 路由/`/project` 页面）；`memory_context` 命中项目引用时追加带 `sourceRef`、行号、`sha`、`stale` 的有预算项目包。1,001 文件冷索引 <1s、热增量 `parsed=0`、精确查询 p95 <50ms；测试 **476/476**。
- 4.6.18：内容字符只计字母与数字（零宽/emoji/符号/组合符不再过门槛）；画像与 persona 证据改“分页取候选、先过滤后截断”，60 条亚门槛行不能再挤掉真规则；fact 必须同时有 relation 与 object，legacy 空 object 行不渲染；错误文案按单复数拼；补 4 条回归，测试 **572/572**。
- 4.6.17：写入侧加最小信息量门禁（内容字符 < 2 的 note/episode 直接拒绝，候选审批同门；已入库的单字符垃圾不再进常驻画像，画像门槛为 4 个内容字符）；补 3 条回归。测试 **568/568**。
- 4.6.16：循环内不再让指针抢走短行额度（写指针前先为剩余最便宜行预留，`pointer:false` 继续扫描），补 L=1151 窗口回归；`included` 口径收窄为“仅 HTTP 可验证”；包数/838 时点/VM SKIP 逐字等 10 条文档口径统一。测试 **565/565**。
- 4.6.15：整节预检改为按全体条目取最小成本（超长首条不再带走可容纳的短条目）；facts 计 `- ` 两字符、孤立 `相关事实：` 标题不再出现；`cachedProfile` 失败记日志并保留上次文本；`memory_profile` 的 schema 补齐结构化字段（完整字段只在 HTTP `POST /omni-memory/tool` 可验证，CLI 与 MCP 仅文本；4.6.16 勘误）；烟测白名单抽成可测函数。测试 **564/564**。
- 4.6.14：修掉 4.6.13 残留——`addSection` 早退时整节 note 静默丢失（现在逐条记 `omitted`，放不下指针也记 `pointer:false`）；`profileFactLines` 计入换行并跳过超限事实；`memory_profile` 返回 `included`；安装烟测只对路径类导入错误降级；包里排除过期内部报告（238→210 files 为 4.6.14 干净 HEAD；4.6.15 发布提交 214、最终 HEAD 216；4.6.16 干净 HEAD 218）。测试 **561/561**。
- 4.6.13：结构评审收口三项——`capProfileLines` 预算改为按含换行分隔符的总长计（`budgetUsed === text.length`），被裁条目必进 `omitted` 并留指针；`picked` 测试改为定值断言（口径＝`- ` 行数，含指针）；安装烟测把断言移出 `try`、改用 `Number.isFinite`，只有动态导入失败才降级到 MCP 路径。不改 schema（仍为 20），预算仍 1200。测试 **559/559**。
- 4.6.12：修复全局段预算饿死，不改 schema（仍为 20）。`buildProfileText` 放不下时继续扫描，单条超长 note 不再连带丢弃其后的短规则，并留 `note#id 超长已省略` 指针；`memory_profile` 新增 `budgetUsed`/`omitted`，`memory_write` 对 400 字以上全局 note 返回非阻断提示。同库同排序模拟对照：旧行为 1 条/292 字符 → 新逻辑 6 条/1150 字符（安装后生产实测 picked=3 / budgetUsed=598，库已新增规则）。测试 **558/558**。
- 4.6.11：覆盖率盲区补测，不改 schema（仍为 20）。新增 dream 路由（replace/rollback/二次回滚/proposals/405/400/scope=all）、doctor 七类分支、dream 定时器 dispose 三组用例；同树双跑 lcov 证明 `server.mjs` 两次均 320/345 且命中行一致（4.6.8 的 205→217 属提交间差异），`cli.mjs` 637/641 抖动如实入证。`read-routes.mjs` 1118→1150/1296、`doctor.mjs` 258→302/348。测试 **556/556**。
- 4.6.10：安装字节绑定发布提交，不回退 schema（仍为 20）。`install.mjs` 现在从签名 manifest 的 `commit` 读 `package.json` 与启动器（`git show <release>:<path>`），并与 manifest 的 `packageJsonSha256`/`launcherSha256` 直比——`HEAD` 只决定“放不放行”，不再决定“装哪个字节”；`describeHeadDelta()` 的 `merge-base` 失败改记 `git-failed`（仅退出码 1 算非祖先）；输出文案改为“安装对象仍取发布提交”。新增 4 条测试（安装字节来源、manifest 哈希不符拒绝、git 故障原因码×2），第 5 条测试补 `allowed === false`。测试 **550/550**。
- 4.6.9：安装校验放行 docs-only 后代，不改 schema（仍为 20）。`install.mjs` 不再要求 HEAD 恰等于发布提交：发布提交是 HEAD 祖先、且 `git diff --name-only` 的变更全在 `docs/` 下时放行，并在输出里标出领先的文档提交数；任一非 `docs/` 路径（含把文档移出 `docs/` 的改名）仍要求 `git checkout <tag>`。新增 `scripts/release-delta.mjs` 与 5 条测试；`entry-diagnostics` 里那条恒真断言改为“prompt 必须渲染内容”。测试 **545/545**。
- 4.6.8：覆盖率重测收口，不改 schema（仍为 20）。修复 `routeState` 诊断恒为 `pending` 的真实缺陷（挂载成功后写 `mounted` 并导出 `routeStateSnapshot()`），补齐 MCP dispatch 失败帧（带 id 回 `-32603`、不带 id 只记日志）、CLI `project` 查询族与 `context`/`search`/`ingest` 主链路、CLI `project init` 只读目标改为退出 2；`hosts/cli.mjs` 行覆盖 61.31% → **74.28%**，`index.js` 并集 **95.99%**。测试 **540/540**。
- 4.6.7：入口层与主链路补测，不改 schema（仍为 20）。按覆盖率评审补齐 `readJsonBody` 严格矩阵（超限 413、非法 JSON、非对象、空体、流不可读）、prompt 注入预算裁剪与争议过滤、dream 定时租约、CLI `project` 族与 `rules` 写盘/预览、MCP stdio 帧处理与 `bin.mjs` 冒烟；`readJsonBody` 由内部函数改为导出以便单测，行为不变。测试 **527/527**。
- 4.6.6：性能测试隔离，不改 schema（仍为 20）。`npm test` 改为串行执行，避免 ADR-020 的 p95 被其他测试进程争用成假失败；300ms 预算未放宽，全量约 99s。测试 **494/494**。
- 4.6.5：报告证据链收口，不改 schema（仍为 20）。新增 `tap-evidence` 证据文件，完成报告必须逐字引用 TAP 的汇总、时长、ADR 诊断和 1000 文件索引，`check-docs` 拒绝手抄数字；显式 `--tap` 缺文件直接失败，摘要不完整不再输出误导性的“0 failure”；DESIGN 语义门补自动化正负回归。测试 **494/494**。
- 4.6.4：4.6.3 复核收口，不改 schema（仍为 20）。修正 DESIGN 中测试钩子的旧口径，并由 `check-docs` 校验该语义；TAP 文件存在但缺 `# tests` 时直接失败，不再回退到声明数；新增 6 条门禁负向回归，覆盖重复摘要、plan 不一致、多个 plan 与漏跑下界；4.6.3 报告的时长和 1000 文件索引改回 TAP 快照原文。测试 **492/492**。
- 4.6.3：测试门禁收口，不改 schema（仍为 20）。TAP 计数低于声明数时 `check-docs` 必须失败，防止测试文件漏加载后仍放行；TAP 真值门拒绝重复摘要和非 `1..N` plan；测试钩子只接受 Node 测试运行器的 `NODE_TEST_CONTEXT=child[-vN]`，并明确为防误设、不是安全边界；修正 macOS 上 scope 属性测试的平台条件；缺 docs 文件时检查显式报错而不是抛栈。测试 **486/486**。
- 4.6.2：复核报告收口，不改 schema（仍为 20）。插件侧读路由对缺失 Host 也 fail-closed；stdio/HTTP `instructions` 统一为完整 `RULES_TEXT`；`OMNI_TEST_MODE` 增加 `NODE_TEST_CONTEXT` 第二道门；`npm test` 输出 TAP 并由 `verify` 校验真实 pass/fail；Linux 项目路径、`schtasks` 与 warm sync 用例改为可移植断言；补 README 规则口径、REST `limit` 默认/上限、persona `clear` 归属与测试变量名。测试 **486/486**。
- 4.6.1：安全加固补丁，不改 schema（仍为 20）。所有只读 `/omni-memory/*` 路由补 Host 校验，伪造 Host 读 `/export` / `/search` / `/status` 返回 403；`/export` 限定 GET；HTTP `/tool` 省略 `scope` 时继承服务启动的项目层；`project_search` 的 `limit` 加 1 下限与有限整数钳制，负数/非数不再触发全表；跨 scope 审计失败写 stderr；`OMNI_TEST_*` 钩子要求 `OMNI_TEST_MODE=1`；新增 `npm run verify`。测试 **483/483**。
- 黄金集（20 语料 / 24 问题）：词面 MRR 0.776 → hashed 混合 0.927 → 语义优先 **0.958**（旧双路 0.979，recall 仍 1.0）；语义冷加载约 208ms，单查询约 9.5ms（20 次 191ms，本机 CPU）

```bash
npm test
npm run demo           # 隔离演示，不碰真实库
npm run qa             # 黄金集 + 120 例质量套件
npm run bench          # 延迟基准
npm run bench:golden   # 黄金集
npm run bench:quality  # 120 条确定性质量集
npm run bench:scale -- 100000 100 100
npm run bench:public:fetch && npm run bench:public
```

## 兼容性

- DeepSeek Harness 0.2.2-rc.3（Desktop，Windows）
- Node 24（使用内置 `node:sqlite`，无原生编译依赖）
- 客户端零依赖：星图为 Canvas 2D 手写投影，不引入 three.js 等库

## 文档

- [设计规格](docs/DESIGN.md)（需求、架构、数据模型、契约、失败模式、追溯矩阵）
- [5 分钟上手](docs/QUICKSTART.md)（demo、源码运行、官方安装）
- [发布验签安装](docs/INSTALL-RELEASE.md)（M2 信任边界）
- [公开 QA](docs/PUBLIC-QA.md)（可复现的检索与质量基线）
- [架构决策记录](docs/ADR)（32 份）
- [威胁模型](docs/THREAT-MODEL.md)（信任边界、残余风险、新增路由检查清单）
- [更新链签名](docs/UPDATE-SIGNING.md)（Ed25519 清单、公钥指纹、发布签名与密钥轮换）
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
- [基准与质量实测](docs/BENCHMARKS.md)
- [竞品与赛道定位](docs/COMPARISON.md)
- [未完成项与 C 类记录](docs/OPEN-GAPS.md)
- [Docker / 容器化](docs/DOCKER.md)
- [Linux 部署](docs/LINUX.md)
- [许可与商业例外](LICENSING.md)
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

**AGPL-3.0-only** — OSI 认可的开源许可证。可以自由使用、修改、分发，也可以商用；闭源分发或闭源 SaaS 需要履行 AGPL 源码义务，或另行取得商业例外。

- ✅ 可以：个人/公司使用、修改、分发、商业服务
- 📄 义务：保留版权与许可；修改版继续使用 AGPL；通过网络提供服务时向用户提供对应源码
- 💼 商业例外：闭源嵌入、闭源 SaaS、OEM/白标等无法满足 AGPL 的场景，见 [LICENSING.md](LICENSING.md)

推荐署名：

```markdown
基于「全息记忆 (Omni Memory)」by wangzhen110
https://github.com/wangzhen110/omni-memory · AGPL-3.0-only
已修改（如有）
```

完整说明见 [ATTRIBUTION.md](ATTRIBUTION.md)，法律文本见 [LICENSE](LICENSE)，商业例外见 [LICENSING.md](LICENSING.md)。

### 商业例外

需要闭源分发、闭源 SaaS 或其他无法满足 AGPL 源码义务的授权时，请开 Issue（模板：商业例外申请）：

https://github.com/wangzhen110/omni-memory/issues/new?template=commercial-license.yml

**备用渠道**：64271785@qq.com（标题请注明「商业例外 + 用途」）









