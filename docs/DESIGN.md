# 全息记忆（`@local/omni-memory`）设计规格

| 项 | 值 |
|---|---|
| 文档版本 | 4.6.6 |
| 插件版本 | 4.6.6 |
| 状态 | 已评审（本文为开发与验收的**唯一依据**） |
| 目标平台 | DSH 0.2.2-rc.3 原生插件（Desktop，Windows 11，Node 22.23.2，`engines >=22.13`）；MCP / HTTP / OpenAPI / CLI 宿主通用 |
| 最后更新 | 2026-11-26 |
| 变更规则 | 任何行为变更必须先改本文并升版本，再改代码 |

**写作原则**：本规格只声明两类内容——① 已实现且被测试覆盖的行为；② 明确标注为「未实现」并有对应 FR 编号的需求。禁止把计划写成现状。

---

## 0. 术语与约定

| 术语 | 含义 |
|---|---|
| 记忆（memory） | 一条可检索的持久条目，分 note / fact / chunk 三类 |
| 笔记（note） | 结论、偏好、规则，人为或模型判断后写入 |
| 事实（fact） | `subject-relation-object` 三元组，带有效期 |
| 转录（chunk） | 会话原文片段，自动捕获，只增不改 |
| 墓碑（tombstone） | `deleted_at` 非空，逻辑删除，保留审计 |
| 画像（profile） | 注入系统提示的那一小段高权重笔记（≤1200 字） |
| 硬失败（hard failure） | 抛错、丢数据、数据损坏 |
| 软降级（soft degradation） | 功能可用但召回变差（如 FTS 不可用退回 LIKE） |

约定：所有时间戳为 Unix 毫秒；所有文本按 UTF-8 存储；所有 SQL 使用预编译语句。

---

## 1. 需求

编号规则：`FR-*` 功能需求，`NFR-*` 非功能需求，`CON-*` 约束。每条需求都有**验收标准**，并在 [第 10 节](#10-测试与追溯) 映射到测试。

### 1.1 功能需求

| 编号 | 需求 | 验收标准 | 状态 |
|---|---|---|---|
| FR-01 | 写入笔记 | `memory_write(kind=note)` 返回自增 id；同 scope 同文本重复写入返回 `deduped=true` 且不新增行 | ✅ |
| FR-02 | 写入事实（双时态） | 同 `(subject,relation)` 已有有效行时，旧行 `valid_to` 被置为当前时间，新行生效；旧行不删除 | ✅ |
| FR-03 | 写入片段 | `kind=episode` 写入 chunks 并进入 FTS 索引 | ✅ |
| FR-04 | 自动捕获 | 会话提交 `user/message`、`assistant/message` 后，正文进入 chunks，来源形如 `session:<id>#<seq>` | ✅ |
| FR-05 | 自包含捕获约束 | 捕获过程不得读取会话投影、不得 prepare 会话、不得阻塞或中断回合；异常必须被吞掉 | ✅ |
| FR-06 | 中文检索 | 查询 `插件报错` 能命中包含该子串的条目（无需空格分词） | ✅ |
| FR-07 | 英文标识符检索 | 查询 `inspectSession` 命中包含该标识符的条目 | ✅ |
| FR-08 | 分层混合召回 | 一次查询同时搜索 notes / facts / chunks，按统一打分排序并跨层去重 | ✅ |
| FR-09 | 常驻注入 | 系统提示中出现长期记忆段，总长 ≤1200 字；无笔记时不产生任何字符 | ✅ |
| FR-10 | 注入时效 | 写入或遗忘后 30 秒内（实现为写入即失效）注入内容反映变更 | ✅ |
| FR-11 | 画像工具 | `memory_profile` 返回注入文本、预算、统计 | ✅ |
| FR-12 | 时间线 | `memory_timeline(entity)` 返回该实体全部事实，含已失效项及其有效期 | ✅ |
| FR-13 | 遗忘 | `memory_forget(kind,id)` 置墓碑；此后检索与画像不再出现；行仍存在 | ✅ |
| FR-14 | 界面浏览 | 左栏「记忆」面板列出笔记与事实，含类型、正文、来源、作用域、重要性 | ✅ |
| FR-15 | 界面搜索 | 面板搜索框调用同一检索算法，展示命中条数与结果 | ✅ |
| FR-16 | 界面遗忘 | 面板按钮触发遗忘并刷新列表 | ✅ |
| FR-17 | 向量融合排序 | 黄金集 MRR 不低于仅词面基线 | ✅ 内置本地语义：词面 MRR 0.776 → 0.927（hashed）→ **0.958**（语义优先，BGE-small-zh int8；旧双路 0.979） |
| FR-18 | 图游走召回 | 通过实体边扩散，召回直接匹配不到的相关条目 | ✅ 已实现（2 跳、衰减 0.5、按边召回） |
| FR-19 | 冲突标记 | 笔记之间冲突时置 `contested=1` 并在界面标注 | ✅ 已实现（显式 `contradicts` + 余弦 ≥0.9 启发） |
| FR-20 | 做梦校验 | 离线任务用原文核对笔记，发现错误时标记并留痕；替代需人工确认且可回滚 | ✅ 已实现（覆盖度 + 特征词缺失判定；`apply` 只标记，`commit`/单条 replace 才替代） |
| FR-21 | 真语义嵌入后端 | 换说法（无共享字）仍能召回；默认零配置，不要求用户安装服务、拉模型或配 key | ✅ 已实现：`BAAI/bge-small-zh-v1.5` int8 ONNX + ONNX Runtime WASM 随包分发，进程内 CPU 推理；远程 OpenAI 兼容 `/embeddings` 仍可选 |
| FR-22 | 面板分页与状态展示 | 列表支持 `limit/offset` 并显示总数；卡片展示 `contested`、`verification`、`evidence`、`superseded` | ✅ 已实现 |
| FR-23 | 转录增长治理 | `memory_compact` 按保留上限墓碑化最旧转录；行保留可审计；dry-run 默认 | ✅ 已实现 |
| FR-24 | 自动召回开关 | 开启时用当前用户消息预取 top-3 并拼入提示；`OMNI_AUTO_RECALL=0` 关闭 | ✅ 已实现（默认开启） |
| FR-25 | 对话结尾状态条 | composer 下方一行显示注入字数、召回条数、存量；60 秒内生效时亮绿点 | ✅ 已实现 |
| FR-26 | 项目级/全局级分层 | 转录按工作目录落项目层；画像=全局+当前项目；检索项目视图含全局；面板可切层 | ✅ 已实现（ADR-013） |
| FR-27 | 归属判断机制 | 写入按措辞判定层并回传依据；检索有当前项目时含项目+全局，无项目时只走全局 | ✅ 已实现（ADR-014，8 用例） |
| FR-28 | 模型复核归类 | 规则先落层，后台调 `llm` 复核，判错则迁移并留痕 | ✅ 可配置；默认 `off`，显式开启后生效（ADR-015/017，7 用例） |
| FR-29 | 记忆星图 | 实体为星、事实为连线、笔记挂载；拖拽旋转/滚轮缩放/惯性/空闲自转 | ✅ 已实现（ADR-016，5 用例） |
| FR-30 | 故障经验写入 | 笔记可写 `problemKey`、`solutionStatus`（verified/unverified/failed/expired）、`evidence`；`problemKey` 做去空白、小写、限长归一化 | ✅ 已实现（ADR-027） |
| FR-31 | 故障经验检索 | `memory_search` 支持只传 `problemKey` 精确查，支持 `status`/`kind` 过滤；精确指纹命中置顶，verified 排在 failed/expired 之前 | ✅ 已实现（ADR-027） |
| FR-32 | 解法复用反馈 | `memory_solution_report` 按 success/failed/expired 回写状态；success 累计 `reuseCount` 并记录解法验证时间 | ✅ 已实现（ADR-027） |
| FR-33 | 召回质量反馈 | `memory_feedback` 对 note/fact 记 `useful` / `misleading`；搜索返回计数与质量，反馈参与 Bayesian 平滑后的排序 | ✅ 已实现（schema v12） |
| FR-34 | 渐进披露 | `memory_get` 按 kind+id 展开完整正文，最多 20 条；默认当前项目 + global，`all` 需显式 | ✅ 已实现 |
| FR-35 | 笔记修订链 | `memory_amend` 产生新 revision，旧行 `superseded_by` 指向新行；搜索只见新行，旧行保留审计 | ✅ 已实现 |
| FR-36 | 检索质量门禁 | 黄金集 recall ≥ 0.85、MRR ≥ 0.9；`npm run bench:golden` 失败即退出码 1，CI 强制执行 | ✅ 已实现（当前 MRR 0.979） |
| FR-37 | 无 MCP 宿主适配 | `GET /packet` 返回可注入的画像+召回包；`POST /tool` 暴露受限工具面；`openapi.json` 可被 function-calling/OpenAPI 客户端导入 | ✅ 已实现（HTTP adapter） |
| FR-38 | 会话自动捕获 | `memory_ingest` 写转录并抽取 pending 候选；候选必须显式 accept 才成为 note；`scope=all` 拒写；单条上限 4000 字、每 chunk ≤3 候选 | ✅ 已实现（schema v13） |
| FR-41 | 零配置语义索引 | 默认开启、离线；模型随包；新写入进入语义队列；旧库后台回填；`semantic_vectors` 按模型签名隔离 | ✅ 已实现（schema v14；`memory_reindex semantic` 可强制回填） |
| FR-39 | 经验巩固 | `memory_consolidate` 按精确 `problemKey` + 精确 scope 合并；默认 dry-run；应用时写来源链摘要、旧行只 supersede、反馈计数汇总 | ✅ 已实现 |
| FR-40 | 分层画像与重排 | 画像分 `## 全局` / `## 当前项目`；可选 cross-encoder rerank（未配置端点零延迟，失败回落融合排序）；本地/远程 embedding 预设 | ✅ 已实现 |
| FR-42 | 跨平台项目键稳定 | Windows/macOS 同一路径不同大小写生成同一项目键；旧键首次打开时按路径迁移到 canonical key，迁移幂等且不误合并同名目录 | ✅ 已实现（schema v15，ADR-031） |
| FR-43 | 版本可见与受控更新 | `/health`、`/omni-memory/status`、`/overview` 与面板顶栏显示当前版本；`daily-sync` 默认只报告，`--apply` 才更新；更新前必须验证 GitHub Release 的 Ed25519 清单、包哈希、启动器哈希与签名提交谱系，只快进到签名提交；启动器安装到内容寻址路径后再切换任务；`--restart` 才重启服务 | ✅ 已实现（3.11.8；`scripts/daily-sync.mjs`、`lib/update-signature.mjs`、`scripts/install-launcher.mjs`） |
| FR-44 | 读取记忆时版本提醒 | `memory_context`（MCP/CLI）与 `/omni-memory/packet` 读取时检查云端 `main/package.json`；发现更高版本时在返回文本顶部提示“云端有新版，是否更新由用户决定”，不命令 AI 自动执行；成功结果缓存 30 分钟，失败 5 分钟，Contents API 与 raw 回退共享 2.5s 总预算，检查失败不阻塞记忆读取；缓存回读校验版本结构与 TTL，失败不保留旧远端版本；并发读取用跨进程单飞锁只发一次请求 | ✅ 已实现（3.11.6；`lib/version-check.mjs`） |
| FR-45 | 产品化入口与诊断 | `/hub` 非等宽档案索引（记忆库/检索/关系图/项目/接入/状态，横向索引行而不是六卡网格）与 `/m` 手机端纸质底稿式只读搜索；`/star-map.html` 保留既有星图；`omni doctor` 只读诊断 Node、数据目录、SQLite 完整性、语义资产、HTTP、计划任务；`npm run setup` 先验证官方 Release 的 Ed25519 清单、签名 commit、干净工作树与启动器 SHA-256，再安装/创建计划任务；`setup:dev` 只做同提交哈希自洽；默认 dry-run，`--apply --start` 才落盘与启动 | ✅ 已实现（4.0.1 产品化入口；4.1.0 重绘 `/hub` 与 `/m`；4.1.1 手机读数改为单行；`hosts/shared/doctor.mjs`、`scripts/install.mjs`、`scripts/verify-release.mjs`） |
| FR-46 | 开源发布与公共验证 | OSI 许可证 AGPL-3.0-only + 商业例外；贡献/安全/行为准则/治理文件；`npm run demo` 隔离演示；`npm run qa` 跑黄金集与 120 例质量套件；`verify:release` 与 `setup --require-release` 共用发布验签逻辑 | ✅ 已实现（4.0.1；`LICENSE`、`LICENSING.md`、`scripts/demo.mjs`、`scripts/qa.mjs`、`docs/QUICKSTART.md`） |
| FR-47 | 项目代码索引 | 任意项目一条命令建立可增量重建的模块/符号/API/依赖索引；索引是派生缓存，源码始终权威；查询返回 `sourceRef`、行号、`sha`、`stale`；与 note/fact 的决策/历史/坑合并；不存源码正文 | ✅ 已实现（4.6.0，schema 20，ADR-032） |
| FR-48 | HTTP 信任边界与工具作用域 | 所有 HTTP 路由先校验 loopback，再拒绝缺失或伪造 Host；只读 `/omni-memory/*` 与面板同规则，403 返回 `error`；`/export` 只接受 GET；HTTP `/tool` 省略 `scope` 时继承服务启动的项目/会话层，显式 `scope` 优先；`project_search` 的 `limit` 限定为 1..80 的整数；跨 scope 审计失败写 stderr；`OMNI_TEST_*` 钩子仅在 `OMNI_TEST_MODE=1` 且处于 Node 测试运行器时生效 | ✅ 已实现（4.6.1/4.6.2；`hosts/shared/http-guard.mjs`、`lib/read-routes.mjs`、`lib/project-index.mjs`） |

### 1.2 非功能需求

| 编号 | 需求 | 指标 | 当前实测 |
|---|---|---|---|
| NFR-01 | 单次检索延迟 | p95 < 300ms（1 万行以内） | **本机复核（Node 22.23.2）：p95 = 2.4ms @ 10,000 行；2.4ms @ 100,000 行；6.0ms @ 1,000,000 行；1M + 5 万向量 + 100 万 bigram 固定边界 226.9ms，3.12.1/3.12.2 自适应边界 129.8ms（无并发、命中 400/400）**（`bench/bench.mjs`，标准 bench 使用 global scope 并断言 `hitTotal > 0`；两段式有界检索见 ADR-020）。3.11.x 发布基准（`bench/release.mjs`）：100k 检索 2.8–3.2ms、写入 4.4–4.6ms；1M 检索 2.8–2.9ms、写入 4.6ms；1M `/list` 966–976ms（高负载 2276ms）、`/overview` 2026–2136ms（高负载 4456ms）；稳态 open 100k 10.6ms / 1M 46.5ms。面板全库统计超出 300ms 交互预算但检索/写入不受影响（[基准](BENCH-3.11.0-2026-11-22.md)） |
| NFR-02 | 注入开销 | 每次装配 ≤ 1 次 SQLite 读；缓存命中时 0 次 | 满足（30s 缓存） |
| NFR-03 | 写入不阻塞回合 | 捕获写入耗时 p99 < 5ms | 满足（单条 insert + 索引） |
| NFR-04 | 崩溃一致性 | 进程被强杀后数据库可打开、已提交行可读 | 满足（WAL + synchronous=NORMAL） |
| NFR-05 | 数据可追溯 | 每条记忆有 `source` 或用例可解释其缺失 | 已捕获项均带 source |
| NFR-06 | 数据不丢失 | 遗忘为墓碑；事实失效为 `valid_to`；无物理删除 | 满足 |
| NFR-07 | 失败隔离 | 任一子系统（FTS/路由/注入）失效不得导致会话不可用 | 满足（全部 try/catch + 可选降级） |
| NFR-08 | 隐私 | 所有数据仅存本机 `$DSH_HOME/memory/omni.db`；HTTP 仅 loopback，且浏览器跨站写请求被 Origin 校验拦截；默认不上传 | 部分满足：数据库未加密，loopback HTTP 仍依赖本机进程边界，未做进程级鉴权（ADR-017）。内置本地语义在进程内推理，不联网；显式配置 `OMNI_EMBED_URL`/远程 `OMNI_EMBED_PROVIDER` 会外发嵌入文本，配置 `OMNI_RERANK_*` 会外发查询与候选正文，均需用户自行选择可信端点 |
| NFR-09 | 可卸载 | 卸载插件后不残留运行中的监听；数据文件保留由用户决定 | 满足（3.11.8 起提供 `install-launcher.mjs` / `uninstall-launcher.mjs`，卸载任务与监听，默认保留数据） |
| NFR-10 | 测试可靠性 | 自动化测试通过率 ≥95% | 494/494（100%，TAP 真值门） |
| NFR-11 | 界面本地化 | 中英词典注册，切换语言无需重载插件 | 已实现（词典 + 订阅重渲染） |
| NFR-12 | 多进程并发 | 同机 N 个宿主进程共用一个库，同时读写不丢数据、不报锁错 | 494 个用例含 6 进程并发用例；写入等待上限 5s（ADR-028） |

### 1.3 约束

| 编号 | 约束 | 原因 |
|---|---|---|
| CON-01 | 禁止调用 `sessionQuery.inspectSession` 操作在线会话 | 会 prepare 会话、顶掉实时投影，聊天区变空白（本项目实测事故） |
| CON-02 | 禁止替换 `conversation.chat.flow` 单例槽位 | 替换后默认聊天流消失 |
| CON-03 | 只依赖公开 Service（`tools` / `systemPrompt` / `webServer` / `slots`） | 内部 API 随版本变动（mnemon 崩溃案例） |
| CON-04 | HTTP 路由必须校验来源为 loopback；写操作只接受 POST 并校验 `Origin` 与 `x-omni-csrf` | 阻止网络来源读取与浏览器跨站写；**不构成进程级认证**（同用户本机进程仍可读写，见 ADR-017） |
| CON-05 | 不得在 `systemPrompt.section` 内做网络/模型调用 | 该函数在每次装配同步执行 |
| CON-06 | 数据目录固定 `$OMNI_HOME/memory`（默认回退 `$DSH_HOME`） | 便于备份与迁移 |

---

## 2. 设计决策（ADR 索引）

| 编号 | 决策 | 结论 | 详见 |
|---|---|---|---|
| ADR-001 | 存储引擎 | SQLite（`node:sqlite` 内置），WAL | [ADR/001-storage.md](ADR/001-storage.md) |
| ADR-002 | 删除语义 | 墓碑 + 事实失效，永不物理删除 | [ADR/002-no-hard-delete.md](ADR/002-no-hard-delete.md) |
| ADR-003 | 捕获路径 | 只订阅 `session/event` 提交后事件流 | [ADR/003-capture-path.md](ADR/003-capture-path.md) |
| ADR-004 | 注入策略 | 单段系统提示，1200 字预算，30s 缓存 | [ADR/004-injection.md](ADR/004-injection.md) |
| ADR-005 | 界面位置 | 左栏导航 + `main` 面板，不用 `conversation.view` | [ADR/005-ui-seat.md](ADR/005-ui-seat.md) |
| ADR-006 | 检索顺序 | 先词面（FTS+分词），向量与图后置 | [ADR/006-retrieval-order.md](ADR/006-retrieval-order.md) |
| ADR-007 | 默认向量后端（历史） | 哈希字符 n-gram（512 维）+ RRF，非语义；3.9.2 起本地语义并行；4.4.0 起语义为主，hashed 降为语义不可用/空结果时的兜底 | [ADR/007-embedding-backend.md](ADR/007-embedding-backend.md) |
| ADR-008 | 嵌入后端可插拔 | 环境变量切换；远程写入入队、检索前惰性刷新 | [ADR/008-pluggable-embedding.md](ADR/008-pluggable-embedding.md) |
| ADR-009 | 图路线与冲突 | 按遍历到的边召回；冲突用显式声明 + 相似度启发 | [ADR/009-graph-and-contradiction.md](ADR/009-graph-and-contradiction.md) |
| ADR-010 | 做梦校验 | 确定性覆盖度 + 特征词缺失；不调用模型 | [ADR/010-dreaming.md](ADR/010-dreaming.md) |
| ADR-011 | 增长治理与本地化 | 墓碑化保留上限；词典 + 订阅重渲染 | [ADR/011-retention-and-i18n.md](ADR/011-retention-and-i18n.md) |
| ADR-012 | 自动召回与状态条 | 事件预取 + 装配同步读缓存；小尾巴读同一份统计 | [ADR/012-auto-recall-and-footer.md](ADR/012-auto-recall-and-footer.md) |
| ADR-013 | 项目级/全局级分层 | 工作目录定项目键；画像=全局+当前项目；检索项目视图含全局 | [ADR/013-scope-layers.md](ADR/013-scope-layers.md) |
| ADR-014 | 归属判断机制 | 显式优先 + 措辞规则 + 保守落项目；检索默认当前项目 | [ADR/014-scope-judgement.md](ADR/014-scope-judgement.md) |
| ADR-015 | 模型复核归类 | 规则先落层，`llm` 后台复核并纠偏；失败保留规则 | [ADR/015-model-scope-judge.md](ADR/015-model-scope-judge.md) |
| ADR-016 | 星图实现 | Canvas 2D 手写投影，零依赖；拖拽/缩放/惯性/自转 | [ADR/016-star-map.md](ADR/016-star-map.md) |
| ADR-017 | HTTP 写入安全与默认隐私 | 写操作只接受 POST；Origin/CSRF 校验；模型复核默认关闭；队列有界 | [ADR/017-http-security.md](ADR/017-http-security.md) |
| ADR-028 | 多进程并发 | busy_timeout + BEGIN IMMEDIATE + 事务内去重 + meta 租约 | [ADR/028-multi-process-concurrency.md](ADR/028-multi-process-concurrency.md) |
| ADR-029 | 零配置本地语义 | BGE-small-zh int8 + ONNX Runtime WASM 随包；独立 `semantic_vectors`；后台回填 | [ADR/029-bundled-semantic.md](ADR/029-bundled-semantic.md) |
| ADR-030 | 语义索引生命周期 | 版本化待处理项、遗忘/替代 GC、队列丢弃计数、失败退避、短租约续期与强制重算 | [ADR/030-semantic-lifecycle.md](ADR/030-semantic-lifecycle.md) |
| ADR-031 | 跨平台项目键与旧 scope 迁移 | Windows/macOS 路径大小写归一；v15 `scope_aliases` 只迁移可反推旧键；chunk 冲突墓碑化 | [ADR/031-project-scope-alias.md](ADR/031-project-scope-alias.md) |

### 2.1 参考实现对照（可移植部分）

| 参考 | 移植/借鉴的具体内容 | 是否移植代码 |
|---|---|---|
| Anthropic《components of agent memory》 | 转录层与笔记层分离；注入只放少量结论 | 设计借鉴 |
| Zep / Graphiti | 事实有效期（`valid_from`/`valid_to`）与失效不删除 | 表结构移植 |
| HippoRAG 2 | 实体/边模型与后续 PPR 扩散 | 表结构移植，算法待做 |
| dsh-memento | 墓碑审计、协议化导出思路 | 语义移植 |
| meow-memory | 分层检索与打分权重 | 权重借鉴 |
| dsh-memory-openviking | 注入预算 1200 字与缓存 | 参数移植 |
| SQLite 官方 WAL 文档 | `journal_mode=WAL`、`synchronous=NORMAL` 组合 | 标准做法 |

---

## 3. 架构

![架构图](architecture.png)

### 3.1 容器视图

```
DSH Host 进程
├── 本插件 Host 半边（index.js，~680 行，只保留会话捕获/HTTP 安全壳/attachSession/apply）
│   ├── lib/store.mjs        SQLite 句柄、schema/迁移、向量队列、备份与候选（~3,300 行）
│   ├── lib/search.mjs       词面/语义/图召回、RRF 排序与 dream（~1,500 行）
│   ├── lib/profile.mjs      画像、persona、memory packet、OpenAPI（~640 行）
│   ├── lib/project-schema.mjs  schema 20 五张代码索引表与 scope 清理（~200 行）
│   ├── lib/project-index.mjs   项目扫描/增量/查询/上下文/影响（~1,000 行）
│   ├── lib/project-adapters/   js / api / generic / ctags 解析器（~1,000 行）
│   ├── lib/tool-definitions.mjs  28 个 MCP/DSH 工具定义（~1,500 行）
│   ├── lib/read-routes.mjs  26 条 loopback HTTP 路由（~1,250 行）
│   ├── capture       session/event → chunks
│   ├── recall        agent/inbox/claimed → 异步预取 top-3（TTL 120s）
│   ├── retrieval     分词 / FTS / bigram / hashed 或远程向量 / 本地语义 / 图游走 / RRF
│   ├── tools         28 个插件工具（write/ingest/candidate/consolidate/search/solution_report/profile/timeline/forget/dream/dream_proposals/dream_replace/dream_rollback/compact/reindex/export/import/restore/link_entity/persona/get/feedback/amend/project_sync/project_search/project_context/project_status/project_impact）
│   ├── prompt        systemPrompt.section：画像 + 召回段（同步读缓存）
│   └── routes        26 条 loopback HTTP（list/overview/search/graph/node/forget/restore/export/status/persona/persona/refresh/dream/proposals/dream/replace/dream/rollback/packet/openapi.json/tool/ingest/candidates/candidate/consolidate/project/status/project/search/project/context/project/impact/project/sync）
├── 本插件 Client 半边（client.js，~1500 行）
│   ├── sidebar.panellist[id=omni-memory]   左栏入口图标
│   ├── main[key=omni-memory]               记忆面板（分页/搜索/状态/遗忘）
│   └── conversation.composer.dock[memory-tail]  对话结尾状态小尾巴
└── 数据：$DSH_HOME/memory/omni.db（WAL，单文件）
```

### 3.2 组件职责与依赖方向

```
tools ─┐
routes ─┼→ retrieval ─→ store
prompt ─┘        ↑        ↑
recall ──────────┘        │
capture ──────────────────┘（只写）
```

约束：`store` 不依赖任何上层；`prompt` 只读；`capture` 只写；`retrieval` 纯读。任何组件不得反向调用。

---

## 4. 数据模型

### 4.1 表定义（与代码一致）

```sql
chunks(id PK, ts, session_id, role, text, hash, scope, source, importance, deleted_at)
notes(id PK, ts, scope, text, importance, source, revision, superseded_by, contested, deleted_at, problem_key, solution_status, solution_verified_at, reuse_count, last_used_at)
facts(id PK, subject, relation, object, text, recorded_at, valid_from, valid_to, confidence, scope, source, contested, deleted_at)
entities(id PK, name UNIQUE, kind)
edges(id PK, src, rel, dst, scope, valid_from, valid_to, source)
vectors(id PK, kind, owner_id, dim, vec)
bigrams(id PK, layer, owner_id, gram)
meta(key PK, value)
chunks_fts / notes_fts / facts_fts  -- FTS5，trigram 优先
  notes_fts 为 external-content（content='notes'），正文不存副本，trigger 同步
```

索引：`chunks_hash_active(hash, IFNULL(scope,'global')) WHERE deleted_at IS NULL` 是**部分唯一索引**，墓碑后的同文可以重新写入；`bigrams_gram(gram)` 支撑 2 字 CJK 查询。

### 4.2 不变量

| 编号 | 不变量 | 强制方式 |
|---|---|---|
| INV-01 | 同一 `(hash, scope)` 至多一条未墓碑的 chunk；墓碑后同文可重新捕获 | 部分唯一索引 + 先查后插 |
| INV-02 | 同一 `(subject,relation,scope)` 至多一条 `valid_to IS NULL` 且未墓碑的事实 | 写入前先按 scope 置旧行失效 |
| INV-03 | `notes.revision ≥ 1` | 默认值 |
| INV-04 | 逻辑删除只写 `deleted_at`，不删行 | 代码约束（禁止 DELETE） |
| INV-05 | `chunks_fts` 行与 `chunks` 行 id 一致 | 插入时同事务写入 rowid |

### 4.3 迁移策略

`meta.schema_version` 记录整数版本；启动时按序执行 `MIGRATIONS[n]`。
**当前版本 20**。v7 移除全局 `chunks.hash` 唯一索引，改为按 `(hash, scope)` 的部分唯一索引；为 `edges` 补 `scope`、为 `facts` 补 `recorded_at`；新增 `bigrams` 索引表；并回填旧数据的 scope 与 bigram。v11 为 notes 增加故障经验字段，旧行保持为空/NULL，按 unverified 读取。v12 为 notes/facts 增加召回反馈计数（`recall_count`、`last_recall_at`、`useful_count`、`misleading_count`），旧行从 0 起算。v13 新增 `note_candidates`（会话自动捕获的待审候选），带 `status/scope/hash` 索引，旧库补表不丢数据。v14 新增 `semantic_vectors`（按 `(kind, owner_id, model)` 隔离本地语义向量），旧库补表，语义索引由后台回填。v15 新增 `scope_aliases`，用于跨平台路径大小写归一时记录旧项目键到 canonical 键的映射；迁移由 `ensureProjectAlias` 在打开工作区时执行。v16 为检索热路径补 `notes(scope, superseded_by, ts)`、`facts(subject, relation, scope, valid_to)`、`chunks(scope, deleted_at, ts)` 等索引；旧库启动时幂等补齐，不改变数据。v17 为 notes 增加 `text_hash` 与 `(scope, text_hash)` 索引，写入去重、导入与 restore 先走哈希候选、再比对原文；旧库启动时按 1000 行/批回填 NULL，并用 `notes_text_hash_missing(id) WHERE text_hash IS NULL` 部分索引让稳态缺失探针保持 O(1)。新增列/索引必须写迁移，禁止直接改 `CREATE TABLE` 语句（新库与老库必须收敛到同一结构）。v18 把 `bigrams` 改为 `WITHOUT ROWID`，主键 `(gram, layer, owner_id)` 直接服务两字中文查询，另保留 `bigrams_owner(layer, owner_id, gram)` 供删除路径；旧表原先把同一份 gram 存在 hidden rowid、复合主键索引和二级索引三处。v19 把 `notes_fts` 改为 external-content 索引（`content='notes'`、`content_rowid='id'`），不再另存 `notes_fts_content` 正文副本；索引由 6 个 trigger 在插入、修改、supersede、tombstone、恢复、物理删除时同步，重建时只写入 active 行。

| 版本 | 变更 | 迁移动作 |
|---|---|---|
| 1 | 基线 schema | `CREATE TABLE IF NOT EXISTS` |
| 2 | 分层作用域 | `facts.scope`、`chunks.scope`；`notes_fts`、`facts_fts` 建表与回填 |
| 3 | 向量索引 | `vectors(kind, owner_id, dim, vec)` |
| 4 | 维度变更 | 清空 `vectors`，由写入/回填重建 |
| 5 | 做梦校验 | `notes.verified_at / verification / evidence` |
| 6 | 旧作用域归一 | 无哈希的 `proj:*` 旧值改为 `global`（升级前它们本就全局可见） |
| 7 | 分片唯一索引与 CJK 索引 | `chunks(hash, scope)` 部分唯一索引；`edges.scope`、`facts.recorded_at`；`bigrams(layer, owner_id, gram)` 与回填 |
| 8 | 多值关系 | `facts.cardinality`、`relations` 表 |
| 9 | 实体别名 | `entity_aliases(alias, canonical, updated_at)` |
| 10 | 用户设定 | `persona(key, value, updated_at)`；始终注入，不参与 dream/检索 |
| 11 | 故障经验库 | `notes.problem_key / solution_status / solution_verified_at / reuse_count / last_used_at`；`problem_key`、`solution_status` 索引 |
| 12 | 召回质量反馈 | `notes/facts` 增加 `recall_count / last_recall_at / useful_count / misleading_count`；旧行默认 0 |
| 13 | 会话候选 | `note_candidates(kind, text, scope, status, hash, ...)`；pending 候选不参与正式检索 |
| 14 | 本地语义向量 | `semantic_vectors(kind, owner_id, model, dim, vec)`；`semantic_vectors_model` 索引；不触碰旧 `vectors` |
| 15 | 项目 scope alias | `scope_aliases(alias PRIMARY KEY, canonical, created_at)`；`scope_aliases_canonical` 索引；打开路径时迁移旧键 |
| 16 | 热查询索引 | 为 notes/facts/chunks/edges 补 scope+状态+时间复合索引；幂等 `CREATE INDEX IF NOT EXISTS`，不改变数据 |
| 17 | 笔记文本哈希 | `notes.text_hash`、`notes_scope_text_hash(scope, text_hash)`；`notes_text_hash_missing(id) WHERE text_hash IS NULL`；启动按 1000 行/批回填 NULL，去重仍比对原文，碰撞不合并 |
| 18 | bigram 去冗余 | `bigrams` 改 `WITHOUT ROWID`，主键 `(gram, layer, owner_id)`；保留 `bigrams_owner(layer, owner_id, gram)` 供删除 |
| 19 | notes FTS 正文瘦身 | `notes_fts` 改 external-content（`content='notes'`），6 个 trigger 同步增删改/替代/墓碑/恢复；去掉 `notes_fts_content` 副本 |
| 20 | 项目代码索引 | 新增 `code_files`、`code_symbols`、`code_apis`、`code_modules`、`code_edges` 五张派生表；只存路径/行号/签名/摘要/sha256，不存源码正文；启动时幂等补建 |

未带版本的旧库按 v1 处理，自动补齐到当前版本；旧行不受影响（迁移只加列、不删数据）。

**打开时的迁移租约（v3.12.1）**：迁移与派生索引维护由 `lease:open-maintenance` 串行化。等待中的第二个进程不再固定 5 秒放弃，而是最多等待 `OMNI_OPEN_LEASE_WAIT_MS`（默认 150,000ms，上限 300,000ms）；1M 库迁移实测 73–80 秒，默认窗口覆盖迁移并留出 120 秒租约 TTL 的接管余量。若等不到租约仍抛错，不读取未迁移库；租约到期后可由下一个进程接管。

---

## 5. 接口契约

### 5.1 模型工具

| 工具 | 入参 | 出参 | 错误 |
|---|---|---|---|
| `memory_write` | `kind`(note/fact/episode), `text`, 可选 `scope`/`importance`/`source`/`subject`/`relation`/`object`；note 额外可选 `problemKey`/`solutionStatus`/`evidence` | `{id, kind, deduped, invalidated?, problemKey?, solutionStatus?, reuseCount?}` | `subject is required for kind=fact`；`text is required`；`solutionStatus` 仅限 note |
| `memory_search` | 可选 `query`，可选 `problemKey`/`status`(all\|verified\|unverified\|failed\|expired)/`kind`(all\|note\|fact\|chunk)/`limit`(1..30)/`scope` | `{total, scope, problemKey?, hits[]}` | 空查询且无 problemKey 返回 `{total:0,hits:[]}`；status/kind 非法时报错 |
| `memory_ingest` | `text`, 可选 `role`(user/assistant/system/tool/note), `scope`/`sessionId`/`source`/`cwd`/`importance`/`extract` | `{id,deduped,scope,sessionId,chars,truncated,candidates[]}` | `scope=all` 拒写；note 候选先 pending |
| `memory_candidate` | `action`(list/accept/reject), `id`(accept/reject), 可选 `status`/`scope`/`cwd`/`limit`/`reason` | `{action,total,candidates[]}` 或 `{id,action,noteId?,reason?}` | 默认当前项目+global；跨项目需 `scope=all` |
| `memory_consolidate` | `problemKey`, 可选 `scope`/`minNotes`(2..10)/`apply`(默认 false) | `{problemKey,scope,applied,notes,n sourceIds,summary?,noteId?}` | `scope=all/project` 拒绝；少于 `minNotes` 返回不足 |
| `memory_solution_report` | `id`, `outcome`(success/failed/expired), 可选 `evidence` | `{id, solutionStatus, reuseCount, lastUsedAt, verifiedAt}` | 笔记不存在或已被替代/墓碑化时报错 |
| `memory_feedback` | `kind`(note/fact), `id`, `rating`(useful/misleading), 可选 `scope`(all) | `{id, kind, usefulCount, misleadingCount, feedbackCount, lastFeedbackAt, quality}` | 默认仅当前项目+global；跨项目需显式 `scope=all` |
| `memory_get` | `items[{kind,id}]`（最多 20），可选 `scope` | `{items[], missing[]}` | 超过 20 条报错 |
| `memory_amend` | `id`, `text`, 可选 `reason`/`scope`(all) | `{id, revision, superseded, scope}` | 仅支持 note；默认仅当前项目+global；原文与新文相同会拒绝 |
| `memory_profile` | 无 | `{text, stats, picked, budget}` | 无 |
| `memory_timeline` | `entity` | `{entries[]}` | 无 |
| `memory_forget` | `kind`(note/fact/chunk), `id` | `{forgotten}` | `kind must be note, fact or chunk` |
| `memory_dream` | `apply`(默认 false), `commit`(默认 false，需 apply) | `{scanned, applied, actions[]}` | 无；`apply` 只标记，`commit` 才批量替代 |
| `memory_dream_proposals` | `limit`(默认 50) | `{proposals[]}` | 无 |
| `memory_dream_replace` | `noteId`, `confirm`(必须 true) | `{oldId, replacementId}` | 无；单条语义决策 |
| `memory_dream_rollback` | `noteId` | `{restored, replacementId?}` | 仅回滚 `dream:` 来源的替代 |
| `memory_compact` | `keepChunks`(默认 5000，下限 50), `apply`(默认 false) | `{total, excess, tombstoned, applied}` | 无；只做墓碑，不物理删除 |

命中项结构：`{kind, id, ts, text, source, score}`，fact 额外含 `subject/relation/object/validFrom/validTo/contested`；note 额外含 `problemKey/solutionStatus/reuseCount/lastUsedAt/verifiedAt/verification/evidence`。

### 5.2 HTTP（仅 loopback，非本机 403）

| 路由 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/omni-memory/list` | GET | `limit`(1..200, 默认 40), `offset`(≥0), `scope`(`all`\|`global`\|`project`\|项目键) | `{ok, db, fts, schema, index, page{limit,offset,scope,totalNotes,totalFacts,hasMore*}, stats{notes,facts,chunks,globalNotes,projectNotes,contested,verified}, projects[{scope,notes,facts,chunks,lastAt}], chunks[]（仅精确项目键）, notes[], facts[]}` |
| `/omni-memory/status` | GET | 无 | `{ok, version, autoRecall, lastInjection, routes, aliasRepair, aliasMigration, lastSearch, lastJudge, embedding, semantic, ...}`；`version` 来自 `package.json` |
| `/omni-memory/project/status` | GET | `root`/`cwd` `scope` | `{ok, root, scope, counts{files,modules,symbols,apis,edges}, stale, missing, indexedAt}` |
| `/omni-memory/project/search` | GET | `q` `root` `scope` `kind` `path` `module` `method` `limit` | 模块/文件/符号/API 结果，带 `path`、`line`、`sha`、`stale`、`sourceRef` |
| `/omni-memory/project/context` | GET | `ref`（必填）`root` `scope` `budget` | 有预算的模块/文件/符号/API 上下文；带 `sourceRef`、行号、`sha`、`stale` |
| `/omni-memory/project/impact` | GET | `ref`（必填）`root` `scope` `depth`（1..8，默认 4） | `{ok, targets, files, modules, importers, tests, stale}`；反向静态 import BFS |
| `/omni-memory/project/sync` | POST | body `root`（必填）`scope` `full` `ctags` `gitCommit`；header `x-omni-csrf: 1` | `{files,parsed,unchanged,removed,symbols,apis,modules,edges,durationMs}`；增量建立/重建 |
| `/omni-memory/overview` | GET | `range`(`4w`\|`6w`\|`12w`\|`26w`, 默认 `12w`), `scope`(`all`\|`global`\|`project`\|项目键) | `{ok, version, asOf, range, scope, stats, health, series, daily, projects, profile, activity, graph}`；面向网页概览的真实聚合，不返回全文；非 loopback 403 |
| `/omni-memory/graph` | GET | 无 | `{ok, nodes[{id,kind,label,weight,scope}], links[{source,target,rel}]}`（节点 ≤300，无悬空边） |
| `/omni-memory/search` | GET | `q`, `limit`(1..60), `rerank`(0/1) | `{ok, hits[]}`；配置 rerank 后按 cross-encoder 分数重排 |
| `/omni-memory/packet` | GET | `q` `scope` `cwd` `limit`(1..10, 默认 5) `budget`(400..4000, 默认 1800) `format`(`json`\|`text`) | `{ok, format, scope, query, text, chars, hits, truncated, memories[], update, generatedAt}`；`text` 顶部可能含版本提醒；`format=text` 直接输出纯文本 |
| `/omni-memory/openapi.json` | GET | — | OpenAPI 3.0 描述：15 条 path（packet/search/list/node/status/tool/ingest/candidates/candidate/consolidate/project/status/project/search/project/context/project/impact/project/sync） |
| `/omni-memory/tool` | POST | body `name` `arguments`；header `x-omni-csrf: 1` | `{ok, name, value, text}`；仅允许 write/search/solution_report/feedback/get/amend/profile/timeline |
| `/omni-memory/forget` | **POST**（GET 兼容） | `kind`, `id`, `scope`（查询参数优先；空 body 时从 JSON body 兜底） | `{ok, forgotten, scope}` |
| `/omni-memory/restore` | POST | `kind`, `id`, `scope`（查询参数优先，JSON body 兜底） | `{ok, restored, reason?, activeId?, activeObject?}`；单值事实/同文本笔记已有 active 值时拒绝恢复 |
| `/omni-memory/persona` | GET/POST | body `values`（≤64KB）或 query `values`；清空须 `action=clear` | `{ok, persona}`；空/非法 body 400，超限 413，不静默清空 |
| `/omni-memory/ingest` | POST | `text`（必填；body 上限 64KB，长中文走 body）, `role`, `scope`, `cwd`, `sessionId`, `source`, `importance`, `extract` | `{ok,id,deduped,scope,sessionId,chars,truncated,candidates[]}`；超限 413 |
| `/omni-memory/candidates` | GET | `status`(pending/accepted/rejected/all), `scope`, `cwd`, `limit` | `{ok,action:'list',total,candidates[]}` |
| `/omni-memory/candidate` | POST | `id`, `action`(accept/reject), `scope`, `cwd`, `reason` | `{ok,id,action,noteId?,reason?}` |
| `/omni-memory/consolidate` | POST | `problemKey`（必填）, `scope`, `minNotes`, `apply` | `{ok,problemKey,scope,applied,notes,noteId?,sourceIds[],summary?}` |

> 平台约束（实测 2026-11-15）：DSH 在 **`/api` 前缀**上注册了连接鉴权（`connection.admit`），非浏览器会话请求会被 `401 unauthorized` 拦下，且响应不是 JSON。插件自建路由必须避开该前缀，本插件统一使用 **`/omni-memory/*`**。

> 平台约束（实测）：DSH 的 web server 在把请求交给路由处理函数之前**可能已消费掉请求体**（`req.complete=true`、`req.readable=false`，`data`/`end` 不再触发）。因此本插件的写操作参数一律走查询参数，请求体仅作兜底。

> `scope` 语义（3.10.4 明确）：项目键是同一用户本机数据的命名空间，不是权限边界。调用方能给出精确 `proj:*` 键时，读工具允许读该层；写工具也接受显式项目键，因为新工作区必须先能创建自己。`scope=all` 只用于读，或在 `memory_amend` / HTTP 写操作中显式请求并写 `meta.audit:cross-scope`；HTTP 写还要求 loopback + CSRF。项目键不是秘密，不能当认证令牌。

### 5.3 界面

- 左栏图标：`sidebar.panellist`，`id=omni-memory`，`order=20`，`label=记忆`，图标为内联 SVG。
- 面板：`main`，`key=omni-memory`；`hosts/http/web/panel.html` 是独立 HTTP 外壳的旧列表视图，含搜索、分页、状态和遗忘。
- 概览：`hosts/http/web/index.html` 是默认 `/` 的「记忆概览」仪表盘；`dashboard.css` / `dashboard.js` 无外部依赖，读取 `/omni-memory/overview`。它展示 5 个 KPI、记忆增长双轴图、健康环、项目分布、84 天活跃日历、项目活跃带、事实关系迷你图、画像/偏好信号和最近动态。顶栏版本角标显示 `/overview.version`。
- 每日同步：`scripts/daily-sync.mjs` 不是运行中 HTTP 服务的一部分。AI 读取记忆时先由 `lib/version-check.mjs` 做带缓存的轻量检查；提醒只报告版本差，**由用户确认后才显式执行 `--apply`**。`--apply` 从 GitHub Release 下载 `omni-update-manifest-v2.json`（旧客户端回退 v1），验证 Ed25519 签名、包哈希、启动器哈希和签名提交谱系，只快进到签名提交；`node --check` 校验失败回滚；启动器安装失败返回 `launcher-install-failed`；`--restart` 才重启 `OmniMemory7788`。状态落 `~/.dsh/omni-daily-sync.json`，同一本地日历日只自动检查一次，重试必须显式 `--force`。失败分支只探测服务，不重启。
- 边界：当前 schema 没有任务起止、状态、依赖字段，所以项目活跃带只画首次/最近写入区间，明确标注「不是任务甘特」；不伪造甘特。`persona` 为空时只展示可回原文的偏好信号，不生成推断画像。
- 数据口径：活跃笔记 = 未删除且未被 `superseded_by` 替代；活跃事实 = 未删除且 `valid_to` 为空；有争议 = 两类 `contested` 之和；已失效 = 被替代笔记 + 过期事实；召回有用率在 `recall_count=0` 时返回 `null`，页面显示「暂无反馈」。

---

## 6. 检索算法

### 6.1 分词

1. 归一化小写，按空白与中英标点切分。
2. 含 CJK 且长度 > 2 的片段，展开为全部二元组（bigram），并保留整串。
3. 最多保留 12 个 term；去重保序。

### 6.2 召回

| 层 | 方法 |
|---|---|
| notes | 各 term `LIKE '%term%'` 的 OR 连接，`ORDER BY importance DESC, ts DESC` |
| facts | 同上，列覆盖 `text/subject/object` |
| chunks | term 长度 ≥3 时先走 FTS5 `MATCH`（取 bm25），不足 limit 用 LIKE 补齐 |

### 6.3 打分

```
score = 0.6 × 文本分 + 0.2 × 权重分 + 0.2 × 时效分 + 经验状态分
时效分 = exp(-(now - ts) / 120 天)
权重分 = notes.importance | facts.confidence | chunks.importance
文本分 = max(基线, 命中 term 数 / term 总数)
基线 = notes 0.6 / facts 0.7 / chunks 1/(1+bm25)
经验状态分（仅 notes）= verified +0.2 / failed -0.2 / expired -0.35 / 复用次数最多 +0.15
```

### 6.4 去重

按「去空白后前 120 字」为键跨层去重，保留分数更高者。

### 6.5 向量路线与融合（v0.7.0）

- 嵌入：`lib/embed.mjs`，512 维哈希字符 n-gram，L2 归一化，确定性（ADR-007）。
- **后端可插拔**（ADR-008）：设置 `OMNI_EMBED_URL` 后改用远程 OpenAI 兼容 `/embeddings`：
  `OMNI_EMBED_MODEL`（默认 `text-embedding-3-small`）、`OMNI_EMBED_KEY`、`OMNI_EMBED_TIMEOUT_MS`（默认 10000）。
  远程模式下写入只入队，检索前批量刷新（≤32 条/次）；失败保留队列并回退词面。
- 存储：`vectors(kind, owner_id, dim, vec)`；维度随后端变化，检索只取当前后端维度的行（切换后端无需迁移）。
- 召回：逐行余弦，阈值 **0.2**；哈希后端额外要求**共享至少一个 token**（抑制碰撞噪声），远程后端不需要。
- 融合：RRF，`1/(60+rank)` 叠加参与本轮的排名（词面 / 本地语义 / 图；语义无结果时才有 hashed 或远程向量）；权重为词面 1、hashed/远程 1、本地语义 2、图 0.5，避免哈希碰撞压过明确的语义改写命中。命中项暴露 `lexicalScore` / `vectorScore` / `semanticScore` / `rrf`。
- 诊断开关：`OMNI_DISABLE_VECTOR=1` 同时关闭 hashed/远程向量与本地语义，只跑词面路线（基线与回归对比）；`OMNI_DISABLE_HASHED=1` 只关闭 hashed/远程向量，保留本地语义，用于测量语义单独质量。

### 6.5.1 本地语义路线（v3.9.2 / v3.9.3）

- 模型与运行时随包：`models/bge-small-zh-v1.5/` + `lib/vendor/`，约 39MB；不需要用户安装 Ollama、LM Studio 或配置 key（ADR-029）。
- 推理：`lib/semantic-embed.mjs`，BGE int8 ONNX + onnxruntime-web WASM，进程内 CPU，CLS pooling + L2 归一化；查询加 BGE 指令前缀，文档不加。
- 存储：`semantic_vectors(kind, owner_id, model, dim, vec)`，`model` 为签名 `local:bge-small-zh-v1.5:int8:512`；不覆盖旧 `vectors`，hashed 512 维与本地 512 维不会混算。
- 召回：对最近 5000 条语义向量 + 词面候选做余弦，阈值 **0.25**；命中暴露 `semanticScore`，`via:'semantic'`。
- 索引：新写入进入内存队列，待处理项带版本号；后台 worker 每批 8 条，推理期间同一 key 被改写时旧快照不会写入或吞掉新条目；检索前先冲刷一批待处理项，保证同轮写入后立即可召回；旧库后台回填（每轮扫描上限 64 条），`semantic-backfill` 租约 TTL 120 秒并按批续租；已索引库不会在启动时加载模型。
- 生命周期：遗忘 / compact / amend / dream replace / consolidate / rollback 在事务内清理 bigram / hashed/remote `vectors` / `semantic_vectors`，并清理 notes 之外的 FTS；`notes_fts` 自 v19 起是 external-content，由 trigger 同步，通用删除路径不再手写 `DELETE WHERE rowid`，否则会因缺少旧正文破坏索引。派生表只在确实存在时删除，存在表上的删除失败会让事务回滚而不是静默吞掉。启动按 `semantic_gc_version` 在单个事务内清扫一次孤儿向量；失败写入 `semantic_gc_last_error` / `semantic_gc_failed_at` 并暴露到状态。队列满记 `dropped` 不静默；失败按 1s→30s 指数退避，冷却期早退也会为未完成回填续排。
- 状态：`memory_status` / `/omni-memory/status` 的 `semantic` 暴露 `enabled/model/dim/pending/indexed/dropped/failureCount/retryAt/running/backfillDone/lastError/gcError/gcFailedAt`；`embedding` 暴露 `pending` / `dropped` / `lastDropAt`。`memory_reindex({semantic:true})` 回填缺行，`semanticForce:true` 清当前签名后按源文本重建。
- 开关：`OMNI_DISABLE_SEMANTIC=1` 单独关闭；`OMNI_DISABLE_VECTOR=1` 同时关闭；`OMNI_SEMANTIC_MODEL_DIR` 可替换同结构模型；`OMNI_SEMANTIC_BATCH` 默认 8（1–64）。
- 降级：模型缺失、损坏、WASM 加载失败或内存不足时返回空，词面/hashed/图路线继续工作；`lastError` 留痕。
- 实测：冷加载 208ms，RSS 216MB，512 维；20 次查询 191ms（约 9.5ms/query）；黄金集 recall 1.000、MRR 0.958（4.4.0 语义优先；旧双路 0.979）。

### 6.5.2 大规模库的自适应有界（v3.12.1 引入，v3.12.2 修正判定）

- 背景：固定 `OMNI_SEARCH_WINDOW=20000` 与 `OMNI_VECTOR_SAMPLE=5000` 在 1M 行 + 5 万向量 + 100 万 bigram 下，低配机器 p95 曾到 418.6ms，超出 300ms 预算（A-06）。
- 规则：先看索引表 `MAX(id)`；只有高水位超过 `OMNI_LARGE_STORE_ROWS`（默认 250,000）时，才进一步用可召回行数判定（notes 排除 `deleted_at`/`superseded_by`，facts 排除 `deleted_at`/`valid_to`，chunks 排除 `deleted_at`）。可召回行数也超过阈值才把最近窗口降到 **5,000**、向量采样降到 **1,000**；否则保持 20,000 / 5,000。行数按连接缓存 60 秒（`OMNI_ACTIVE_COUNT_TTL_MS`），避免每次检索都全表 COUNT。
- 为什么不用单一 `MAX(id)`：软删除永不复用 id，写→忘→再写会抬高 id 高水位；churn 库可能只有少量活行却触发 5,000 窗口，导致墓碑间隙以下的活行静默丢召回（3.12.2 回归：`test/churn-window.test.mjs`）。
- 配置：`OMNI_LARGE_STORE_ROWS` 低于 10,000 时保留 10,000 安全下限并打一行 warning，不再静默回退到 250,000；显式 `OMNI_SEARCH_WINDOW` / `OMNI_VECTOR_SAMPLE` 仍固定覆盖。
- 取舍：大库放弃一部分"窗口外纯语义"的覆盖，FTS/词面候选仍负责精确旧记忆；这是有界延迟优先于全库语义召回的产品决策，不是宣称全库语义检索。
- 验收：`bench/bench.mjs 1000000 50` + `BENCH_VECTORS=50000` + `BENCH_BIGRAM=条目` 的 p95 必须低于 300ms，且 `hitTotal > 0`；黄金集 small-store MRR 不得下降。

### 6.6 图路线（v0.9.0）

- 种子：当前 top-6 命中文本中出现的实体（`entities` 表，30 秒缓存、事实写入即失效）。
- 扩散：最多 2 跳，权重 `0.5^hop`，记录**被遍历的边**，已访问实体不重复展开。
- 候选：按 `(subject, relation, object)` 精确回查 facts（带 scope 过滤）。
- 融合：作为第三条排名列表进入同一 RRF。
- 开关：`OMNI_DISABLE_GRAPH=1`。
- 局限：只覆盖事实链，纯笔记语料无增益（实测 MRR 0.927 → 0.927）。

### 6.7 冲突标记

- 显式：`memory_write(kind='note', contradicts=[id...])`，只接受存在且未删除的 id。
- 启发：哈希余弦 ≥ 0.9 判为近重复/近似矛盾，双方 `contested=1`。
- 只标记、不合并、不删除；界面与检索结果均展示 `contested`。

**阈值为什么是 0.9（实测依据，2026-11-14）**：

| 文本对 | 余弦 | 结论 |
|---|---|---|
| 「部署方式最终选择裸机进程方案」vs 同句加句号 | 1.000 | 逐字重复 |
| 「部署方式用 Docker 容器方案」vs「…容器方式」 | 0.913 | 近逐字，标记成立 |
| 「以后所有项目都先用中文回答，不要反复确认」vs「以后所有项目都用中文回答，不用每次确认」 | **0.688** | 语义重复但字面差异大 |

结论：字符 n-gram 余弦只能识别**字面近似**，识别不了语义改写。降低阈值抓不到 0.688 这类真重复，只会把措辞相近但内容不同的笔记误标。所以 0.9 保持不变；语义级重复交给模型复核（ADR-015）或人工清理，不靠调阈值解决。

### 6.8 故障经验检索（v3.2.0）

- **问题指纹**：`problem_key` 经过去首尾、压缩空白、小写、限长 200 字符归一化；同一错误签名跨会话可精确命中。
- **精确优先**：`memory_search({ problemKey })` 先走 `problem_key = ?` 的 SQL 查询，结果带 `exactProblem: true`，合并时置顶；没有 `query` 也允许只按指纹检索。
- **状态语义**：`solution_status` 是现实结果（verified / unverified / failed / expired），与 `verification`（dream 对转录支持度）分开存储；v11 使用独立 `solution_verified_at`，不覆盖 dream 的 `verified_at`。
- **排序**：verified +0.2，failed -0.2，expired -0.35，复用次数按 `log1p` 最多再加 0.15；融合后的最终排序也会重新加这份状态分，避免被 RRF 覆盖。
- **过滤**：`status` 只作用于 notes，指定具体状态时 facts/chunks 不混入；`kind` 可单独限定层。
- **闭环**：`memory_solution_report` 在真实复用后更新状态和 `reuse_count/last_used_at`；success 写 `solution_verified_at`，failed/expired 清空该时间戳。

### 6.9 做梦校验（v1.0.0）

- 入口：`memory_dream({ apply })` 工具；`apply=false` 为 dry-run。
- 证据：`notes.source` 精确匹配 `chunks.source`，否则在最近 300 条转录里取 token 命中率最高者（≥0.4 才算有效证据）。
- 判定：`supported`（覆盖 ≥0.8）/ `weak`（0.4–0.8）/ `contradicted`（覆盖 ≥0.6 且笔记含证据里缺失的拉丁/数字特征词）/ `unsupported`（<0.4）/ `no_source`。
- 修订：仅 `contradicted`、`unsupported` 且存在证据时，用证据原文生成替代笔记（`source: dream:<id>`、`revision+1`），旧笔记写 `superseded_by` 并置 `contested=1`；旧行保留可审计。
- 定时：`OMNI_DREAM_INTERVAL_MS>0` 时按该间隔自动执行 apply；默认关闭。

### 6.10 自动召回与状态条（v1.3.0）

- 触发：`agent/inbox/claimed`（emit）捕获用户消息 → 异步预取 top-3（TTL 120 秒）→ 装配时同步读缓存追加到提示段。
- 开关：`OMNI_AUTO_RECALL=0` 关闭；默认开启。竞态未命中时降级为仅画像，不重试不报错。
- 状态：每次装配更新 `lastInjection{at,chars,recall,auto}`；`GET /omni-memory/status` 暴露该统计。
- 小尾巴：`conversation.composer.dock`（id `memory-tail`, order 3）每 5 秒轮询，显示 `注入 N 字 · 召回 M · 共 K 条`，60 秒内有注入则绿点。

### 6.11 作用域分层（v1.4.0）

| 层 | 取值 | 可见范围 |
|---|---|---|
| 全局 | `global` | 所有会话的画像与检索 |
| 项目 | `proj:<目录名>#<哈希>` | 仅该工作区的画像与检索（项目视图 = 项目 + 全局） |

- 项目键由 `session.header.cwd` 推导；无工作目录的会话写入 `global`。
- 画像只注入"全局 + 当前项目"；当前项目未知时只注入全局。
- 检索：项目作用域包含全局与历史无 scope 行；`scope='global'` 只看全局；`scope='all'` 不过滤。
- 面板：全部 / 全局 / 项目三个筛选，分别显示两层计数；选「项目」时先列出**项目卡片**（笔记 / 事实 / 转录条数、最近活动），点进去看该项目的笔记与**最近 20 条转录**——转录是自动捕获的，笔记是模型写入的，两者必须都能看见。

### 6.12 归属判断（v1.5.0）

写入（`memory_write` 未传 scope）：

| 顺序 | 条件 | 结果 | 回传 reason |
|---|---|---|---|
| 1 | 显式 scope | 用它 | `explicit` |
| 2 | 无当前项目 | `global` | `no-project` |
| 3 | 含跨项目措辞、无项目痕迹 | `global` | `cross-project wording` |
| 4 | 含项目痕迹 | 当前项目 | `project-specific wording` |
| 5 | 其余 | 当前项目 | `default-to-project` |

- 跨项目措辞：偏好/习惯/以后/总是/永远/一律/所有项目/跨项目/通用/铁律/禁止/不要再
- 项目痕迹：本项目/这个项目/本仓库/本工程/本插件/src//docs//package.json/.mjs/.ts/.js/构建/部署/迁移/表结构/字段

检索（`memory_search` 未传 scope）：有当前项目 → 该项目 + 全局；否则全部。

**模型复核**（`OMNI_SCOPE_JUDGE=off|auto|always`，默认 `always`）：

| 模式 | 行为 |
|---|---|
| `off` | 不调用模型 |
| `auto` | 只复核规则没把握的项（confidence < 0.8） |
| `always` | 每条都复核（显式 scope 与无项目上下文除外） |

复核用 `llm.stream` 发一条「workspace + memory → global/project」的极短请求（maxTokens 8、temperature 0、4 秒超时），答案与当前层不同则迁移并写入 `lastJudge`；任何失败都保留规则判定。模型选择：`OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL`，否则第一个 provider 里优先带 flash/mini/haiku/small/lite 的模型。

### 6.13 退出条件
- `term` 为空 → 返回空集（不查询）。
- 任一层抛错 → 该层记 0 条，其余层照常（软降级）。

### 6.14 项目代码索引（v4.6.0）

- **定位**：源码是权威，索引只是可重建缓存。索引回答“模块负责什么、函数在哪、签名是什么、接口契约是什么、改它会波及谁”；note/fact 回答“为什么、历史、坑”。两者用同一个项目 scope 合并，不互相替代。
- **表**：schema 20 新增 `code_files`、`code_symbols`、`code_apis`、`code_modules`、`code_edges` 五张派生表。只存路径、行号、签名、短摘要、`sourceRef`、`sha256`，**不存源码正文**。
- **扫描**：跳过 `.git`、`node_modules`、构建产物与二进制；按扩展名选择适配器。模块优先由 manifest（`package.json`、`go.mod`、`Cargo.toml`、`pyproject.toml`、`pom.xml`、`build.gradle`、`pubspec.yaml`、`.csproj`）划分；monorepo 子包各自成模块，无 manifest 时按顶层源目录。
- **适配器**：JS/TS 覆盖导出、函数、类、方法、`export {}`、`export ... from`、CommonJS、`import/require/import()`，以及 Express/Koa/Fastify、`route({method,url})`、装饰器、Next.js `app/**/route.ts` 与 `pages/api/**`；OpenAPI/Swagger JSON+YAML 解析 paths、operationId、tags、auth、request/response、errors、`components.schemas`；GraphQL SDL 把 Query/Mutation/Subscription 字段转为 API；其他语言走 generic 声明/导入/常见路由，`ctags` 模式可用 universal-ctags JSON 增强。
- **增量**：先比 `mtime_ms + bytes`，相同且已知 sha 时仍重读文件比对 sha，捕获“内容变了但 stat 未变”的漂移；未变文件不解析。变更文件只替换自己的符号/API/出边，不误删其他文件指向它的入边；删除文件时清理该文件全部行与相关边。
- **stale/missing**：查询时用当前文件 stamp 对比索引记录，内容或存在性变化标 `stale`/`missing`，不假装索引仍准确。
- **查询面**：CLI（`index`、`project status/search/context/impact/sync`）、5 个 `project_*` MCP 工具、5 条 `/omni-memory/project/*` HTTP 路由、`/project` 页面。`project_search` 返回精确字段与 `sourceRef`；`project_context` 输出有预算的模块/文件/符号/API 包；`project_impact` 走反向静态 import BFS，并附模块 tests 边与直接 import 的测试文件。
- **与记忆合并**：`memory_context` 在 query 命中项目引用时追加项目包，预算取 `min(900, 1800)`；显式项目 scope 的 `buildMemoryPacket` 也追加项目包，约占总预算 45%（上限 1000）。项目包每条带 `sourceRef`、行号、`sha`、`stale`。空结果分支保留 `project:null`，不静默跳过。
- **预算**：1,000 文件冷索引 <30s、热增量 <2s、精确查询 p95 <50ms；专项 24 项覆盖 schema、适配器、增量、删除、sha 漂移、查询、上下文、影响面、monorepo、状态和性能。

### 6.15 HTTP 信任边界收口（v4.6.1 → v4.6.2）

- **统一守卫**：`hosts/shared/http-guard.mjs` 收拢 loopback 判定、可信 Host 列表、Host 解析、同源判定与写操作判定；`index.js`、`hosts/http/server.mjs`、`lib/read-routes.mjs` 共用同一实现，不再各写一套。
- **只读路由**：`/omni-memory/*` 的所有只读路由先校验 loopback，再拒绝缺失或不可信的 `Host`，返回 `403 {"ok":false,"error":"forbidden host"}`。4.6.2 起插件路由也不再对缺失 Host 放行，与 standalone 服务端一致 fail-closed。
- **导出方法**：`/export` 只接受 GET；POST 返回 405，避免只读导出被写成跨站触发面。
- **工具作用域**：HTTP `/tool` 在调用方未给 `arguments.scope` 时，使用服务启动时由 `bootHost` 解析出的 `agent/session/scope`，与 CLI/MCP 的项目层一致；显式 `scope` 仍然优先，不会被默认值覆盖。
- **参数边界**：`project_search` 及四个项目查询函数把 `limit` 钳到 `1..上限` 的有限整数；负数、0、非数回退默认，超大值钳到上限。REST `/search` 的 `limit` 默认 30、上限 60，越界静默钳制。
- **可观测性**：跨 scope 审计失败写 `console.error`，只记错误消息，不打印查询正文；写路径继续成功，不因审计失败回滚。
- **规则同文**：stdio 与 HTTP 的 `initialize.instructions`、`prompts/get`、`resources/read`、`memory_rules` 共享同一份 `RULES_TEXT`，不再维护会漂移的摘要副本。
- **测试钩子**：`OMNI_TEST_GIT_FETCH_URL`、`OMNI_TEST_UPDATE_PUBLIC_KEY_FILE`、`OMNI_TEST_UPDATE_KEY_ID`、`OMNI_TEST_UPDATE_PUBLIC_KEY_SHA256` 只在 `OMNI_TEST_MODE=1` **且** `NODE_TEST_CONTEXT` 为 `child` / `child-vN` 时生效；这是防误设，不是抗篡改安全边界。生产环境遇到 `OMNI_TEST_*` 只告警并忽略。
- **测试真值**：`npm test` 同时输出 spec 与 TAP，`npm run verify` 调用 `scripts/check-test-results.mjs` 校验真实 `# pass` / `# fail` / `# cancelled`，不再用源码里的 `test(` 计数冒充运行结果。

### 6.16 测试门禁收口（v4.6.3）

- **漏跑检测**：`check-docs` 仍以 TAP 为 pass/fail 真值，但 TAP 的 `# tests` 不得低于 `test/*.test.mjs` 的 `test(` 声明数。测试文件因 glob、语法或加载失败未被发现时，计数变小会直接失败，不能靠 `fail=0` 放行。
- **摘要唯一**：`check-test-results` 要求每个 `# tests / # pass / # fail / # cancelled` 标签全文件唯一，且只能有一个 `1..N` plan，`N` 必须等于 `# tests`；重复摘要、拼接 TAP 与 plan 不一致都拒绝。
- **防误设而非安全边界**：测试钩子仍要求 `OMNI_TEST_MODE=1`，`NODE_TEST_CONTEXT` 收紧为 Node 测试运行器实际写入的 `child` / `child-vN`。能写进程环境的主体仍可伪造，因此该门只防部署脚本误设，不承担抗篡改职责。
- **平台条件**：scope 属性测试使用被测语义变量 `platform` 判断大小写别名差异，macOS 上不再按 Linux 语义误跑。
- **缺文档可诊断**：`check-docs` 遇到缺失的 DESIGN/REFERENCE 等必需文件时输出明确的 `missing required doc` 并退出，不再抛出未捕获的 `ENOENT`。

### 6.17 复核收口（v4.6.4）

- **TAP 缺摘要 fail-closed**：`.test-results.tap` 存在但缺 `# tests` 时，`check-docs` 不再回退到声明数，直接以 `TAP summary is complete` 失败；`--tap <path>` 可指定快照，供回归测试使用。
- **语义漂移门**：`check-docs` 校验 DESIGN 的测试钩子段落，必须写明只接受 `child` / `child-vN`、且“不是抗篡改安全边界”；旧的“存在时生效”表述会直接失败。
- **负向回归自动化**：`test/gates-4.6.4.test.mjs` 覆盖 TAP 完整摘要、重复 `# tests`、plan 不一致、多个 plan、缺 `# tests` 与低于声明数六种路径。
- **报告勘误**：4.6.3 完成报告的时长与 1000 文件索引改回 TAP 快照原文；全绿标注快照时间，并并列记录并发复跑的 484/486。

### 6.18 报告证据链（v4.6.5）

- **数字只从证据文件来**：`scripts/tap-evidence.mjs` 把 TAP 的汇总、`# duration_ms`、ADR 诊断行、1000 文件索引行和快照时间写入 `docs/evidence/<version>.json`；完成报告必须逐字引用这些行，`check-docs` 的 `completion report quotes archived TAP evidence` 会拒绝手抄数字。
- **--tap 不再回退**：显式传入 `--tap` 但文件不存在时，`check-docs` 立即报 `TAP file missing` 并退出，不静默回退到声明数。
- **诊断不掩盖原因**：TAP 摘要不完整时只报 `TAP summary is complete`，不再附带“0 failure(s)”的误导行。
- **语义门有回归**：`lib/design-contract.mjs` 抽出 DESIGN 测试钩子契约，`test/gates-4.6.4.test.mjs` 增加旧措辞拒绝与当前措辞放行的自动化断言。

### 6.19 性能测试隔离（v4.6.6）

- **串行全量**：`npm test` 加 `--test-concurrency=1`。ADR-020 的 p95 是墙钟延迟，不能在其他测试进程争用 CPU/磁盘时测量；串行后 10k/100k 场景稳定低于 300ms，预算不变。
- **代价**：全量从约 30s 增加到约 99s，换来可复现的发布门结果；这是测试调度修正，不是产品性能降级。

---

## 7. 运行时可观测性

| 信号 | 位置 | 用途 |
|---|---|---|
| `meta.fts_mode` | 数据库 | 判断当前分词器（trigram/unicode61/like） |
| `memory_profile.stats` | 工具返回 | 行数、数据库路径、FTS 模式 |
| `/omni-memory/list` | HTTP | 界面健康检查（stats + db 路径） |
| 捕获异常 | 静默吞掉 | 不允许影响回合（FR-05） |

无日志文件；诊断依赖上述四个读取点。

---

## 8. 失败模式与降级

| 编号 | 场景 | 行为 | 影响 |
|---|---|---|---|
| FM-01 | FTS5 不可用 | 启动时尝试 trigram → unicode61 → LIKE | 召回变差，功能可用 |
| FM-02 | 数据库文件损坏/无法打开 | 工具与路由返回错误；不 panic | 记忆不可用，会话正常 |
| FM-03 | 捕获写入异常 | 吞掉异常 | 丢失该条转录，会话正常 |
| FM-04 | 注入函数抛错 | 返回空串 | 本轮无记忆注入，会话正常 |
| FM-05 | HTTP 非 loopback | 403 | 外部不可访问 |
| FM-06 | 写入磁盘满 | SQLite 抛错，工具返回错误 | 记忆不可写，会话正常 |

原则：**任何记忆子系统的失败都不得使 DSH 会话不可用**（NFR-07）。

---

## 9. 已知缺陷清单

| 编号 | 缺陷 | 影响 | 计划 |
|---|---|---|---|
| D-01 | ~~真语义召回缺失~~ | **3.9.2 已修**：内置 BGE-small-zh int8，默认离线零配置；黄金集 MRR 0.927 → 0.979 | 已关闭（ADR-029） |
| D-02 | ~~无图游走~~ | **v0.9.0 已实现**（2 跳按边召回）；纯笔记语料无增益 | 已关闭 |
| D-03 | ~~LIKE 全表扫描~~ | **v0.6.0 已修**：notes/facts 建 FTS5（trigram）+ 回填，词面走 `MATCH`，LIKE 仅作兜底 | 已关闭 |
| D-04 | ~~`forget` 用 GET~~ | **v0.6.0 已修**：改为 POST（JSON body），GET 保留兼容 | 已关闭 |
| D-05 | ~~`contested` 恒为 0~~ | **v0.9.0 已实现**：显式声明 + 相似度启发 | 已关闭 |
| D-06 | ~~`scope` 只过滤 notes~~ | **v0.6.0 已修**：facts/chunks 增加 scope 列并参与过滤；无 scope 的行对任意作用域可见 | 已关闭 |
| D-07 | ~~`timeline` 只查 facts~~ | **v1.2.0 已修**：时间线合并「实体相关事实 + 提到该实体的笔记」，按时间排序 | 已关闭 |
| D-08 | ~~无 schema 版本迁移~~ | **v0.6.0 已修**：`meta.schema_version` + 顺序迁移 + 旧库就地升级 | 已关闭 |
| D-09 | ~~无评测集~~ | 基线已建立：黄金集 20 语料 / 24 问 + 10k 行延迟基准 | 部分关闭（黄金集已建，仍缺 100k/1M 回归门槛） |
| D-10 | ~~面板无分页~~ | **v1.1.0 已修**：`limit`/`offset` + 总数/是否有更多；面板显示 `起–止 / 总数` | 已关闭 |
| D-11 | ~~无 i18n~~ | **v1.1.0 已修**：中英词典注册，界面跟随语言切换 | 已关闭 |
| D-12 | 捕获不含工具调用 | 过程不可回溯 | P3（按需） |

---

## 10. 测试与追溯

### 10.1 测试分层

| 层 | 方式 | 运行命令 |
|---|---|---|
| 单元 | `node:test`，直接导入模块，用桩 ctx | `npm test` |
| 集成 | 临时 `DSH_HOME`，全流程 write→search→timeline→forget | `npm test` |
| 契约 | 路由 handler 以伪 req/res 调用，断言状态码与 body | `npm test` |
| 手工 | 面板浏览/搜索/遗忘、注入在系统提示中可见 | 记录于 CHANGELOG |

### 10.2 需求追溯矩阵

| 需求 | 测试文件 | 用例 |
|---|---|---|
| FR-01 | `test/write.test.mjs` | 写笔记、重复去重 |
| FR-02 | `test/facts.test.mjs` | 冲突失效、时间线含失效项 |
| FR-03 | `test/write.test.mjs` | episode 入 chunks |
| FR-04/05 | `test/capture.test.mjs` | 事件捕获、异常不抛出 |
| FR-06/07/08 | `test/search.test.mjs` | 中文子串、英文标识符、跨层去重 |
| FR-09/10 | `test/prompt.test.mjs` | 预算截断、写入即失效、空库返回空串 |
| FR-11/12/13 | `test/tools.test.mjs` | profile/timeline/forget |
| FR-14/15/16 | 手工 + `test/api.test.mjs` | 路由数据正确 |
| FR-17/21 | `test/semantic.test.mjs`、`test/fixes.test.mjs` | 内置本地语义改写召回、远程维度重启、旧库回填、词面/混合排序 |
| FR-41 | `test/semantic.test.mjs`、`scripts/check-semantic-assets.mjs` | 本地模型随包、同轮写入可召回、模型/WASM 完整性闸门 |
| FR-23 | `test/fixes.test.mjs`、`test/compact.test.mjs` | 墓碑后同文重捕、compact 事务 |
| FR-26/27/28 | `test/scope-model-judge.test.mjs`、`test/fixes.test.mjs` | HTTP scope、`scope=all` 拒写、跨 scope 事实隔离 |
| FR-43 | `test/update-signature.test.mjs`、`test/sign-release.test.mjs`、`test/daily-sync-cli.test.mjs`、`test/daily-sync-success.test.mjs`、`test/install-launcher.test.mjs`、`test/uninstall-launcher.test.mjs`、`test/api.test.mjs` | Ed25519 v1/v2 签名/验签、发布清单生成、启动器哈希绑定、字段篡改/未知字段/错误密钥/时间窗拒绝、默认只报告不移动 HEAD、`--apply` 脏树拒绝、完整成功主链、安装/卸载、版本/预发布解析、本地日期 gate；`/status` 与 `/overview` 暴露 `version` |
| FR-44 | `test/version-check.test.mjs`、`test/daily-sync.test.mjs`、`test/api.test.mjs` | 提醒文本、contents API、raw 回退、缓存复用、缓存注入拒绝、失败清空旧远端版本、网络失败降级、并发单飞锁、`memory_context` 顶部提醒、`/packet` 文本提醒 |
| FR-45 | `test/productization.test.mjs`、`test/api.test.mjs`、`test/install-launcher.test.mjs`、`test/install-smoke.test.mjs` | doctor 只读诊断、fresh home 不落库、安装 dry-run 不写文件/不建任务、`/hub` 与 `/m` 由静态服务返回、计划任务缺失时 `--create-task` 才创建、发布验签安装入口 |
| FR-46 | `test/open-source.test.mjs`、`test/verify-release.test.mjs` | AGPL/治理文件存在、setup 默认 fail-closed 验签、demo/qa 入口、发布清单签名与篡改拒绝 |
| FR-47 | `test/project-index.test.mjs`、`test/tools.test.mjs`、`test/api.test.mjs` | 五表 schema、JS/TS/OpenAPI/GraphQL/generic/ctags、增量/删除/sha 漂移、search/context/impact、monorepo、1,000 文件性能 |
| FR-48 | `test/http-security.test.mjs`、`test/http-lifecycle.test.mjs`、`test/remediation-4.6.1.test.mjs`、`test/check-test-results`（脚本）、`test/project-index.test.mjs`、`test/daily-sync-cli.test.mjs` | 伪造/缺失 Host 读 `/export`/`/search`/`/status` 403、POST `/export` 405、HTTP `/tool` 写项目层且默认搜索可见、显式 global 不可见、负数/超大/非数 limit 钳制、审计失败告警、测试钩子二道门、TAP 真值门 |
| FR-38 | `test/ingest.test.mjs`、`test/capture-rules.test.mjs` | ingest 候选、接受/拒绝、隔离、去重、hook 解析 |
| FR-39 | `test/consolidation.test.mjs` | dry-run、apply、supersede、来源链、scope 隔离 |
| FR-40 | `test/rerank.test.mjs`、`test/prompt.test.mjs` | rerank 开关、远程评分顺序、分层画像预算 |
| FR-29 | `test/starmap.test.mjs` | 节点/边投影、聚焦与高亮 |
| NFR-04 | `test/store.test.mjs`、`test/migration.test.mjs` | 重开数据库后数据可读；升级前备份通过 `integrity_check` |
| NFR-07 | `test/resilience.test.mjs` | FTS 缺失降级、注入抛错返回空串 |
| NFR-08 | `test/api.test.mjs`、`test/fixes.test.mjs` | GET 405、跨站 Origin 403、loopback 拒绝 |

### 10.3 可靠性口径

> 可靠性 = 通过的自动化用例数 / 自动化用例总数（`npm test` 的 TAP 汇总）。

- 目标：**≥ 95%**。
- 未实现需求不计入通过率，而是以「已知缺陷」单列，避免虚高；FR-17..21 已在 3.9.2 全部实现并纳入统计。
- 每次发布记录实际数值到 CHANGELOG。

---

## 11. 发布与回滚

| 项 | 做法 |
|---|---|
| 版本 | 语义化：新增需求 → minor；缺陷修复 → patch；不兼容改动 → major |
| 版本可见 | 面板顶栏 `vX.Y.Z`、`GET /health.version`、`GET /omni-memory/status.version`、`GET /omni-memory/overview.version` 四处一致，均来自 `package.json` |
| 读取时版本提醒 | `memory_context`、CLI `context`、`/omni-memory/packet` 读取时检查云端 `main/package.json`；远端更高时返回文本顶部插入“云端有新版，是否更新由用户决定”的提示，JSON `update` 同步给出两版版本号；提醒不命令 AI 自动执行，检查失败不阻塞读取 |
| 发布渠道 | GitHub Releases 按 `vX.Y.Z` 发布并写变更说明；同一 Release 上传 `omni-update-manifest-v2.json` 主签名资产，需要兼容旧客户端时同时上传 `omni-update-manifest.json` v1 资产；包为 `private:true`，没有 npm 通道；用户通过面板版本、Releases 和 `scripts/daily-sync.mjs` 感知更新 |
| 公开发布验证 | `npm run verify:release` 只读校验 Release 的 Ed25519 清单、签名 commit 上的 `package.json` 与启动器 SHA-256；`--launcher <path>` 可校验镜像/第三方渠道下载的 exe；不移动 HEAD、不安装、不重启。完整说明见 `docs/VERIFY-RELEASE.md` |
| 更新执行 | 读取记忆时 `lib/version-check.mjs` 先查云端版本（成功缓存 30 分钟、失败 5 分钟、总网络预算 2.5s）；提醒只报告，用户确认后显式运行 `node scripts/daily-sync.mjs --apply`；`--apply` 必须验签 Ed25519 清单、包 SHA-256、启动器 SHA-256 与签名提交谱系，只快进到签名提交；通过后安装内容寻址启动器并切换任务；`--restart` 才重启服务；本地日期 gate 写 `~/.dsh/omni-daily-sync.json`，同日重试必须 `--force` |
| 发布 | `plugin_manager remove_bundle` → `install_bundle` → 刷新页面 → 跑 `npm test` |
| 回滚 | 保留上一版目录/归档；数据库迁移前写 `memory/backups/pre-migrate-*.db`；更新校验失败自动 `git reset --hard` 回到更新前提交（reset 前二次检查 tracked 改动）；启动器保留旧内容寻址副本，回滚时把任务 action 指回旧路径 |
| 服务退出 | `OmniMemory7788` 的 `LastTaskResult=3221225786`（`0xC000013A`）表示收到 Ctrl+C / 控制台关闭；若任务显示 Running 但 `/health` 仍是旧版本，多半是旧 node 子进程成了孤儿并占着 7788。启动器只清理可执行路径等于配置 Node、命令行精确含 `hosts\cli.mjs`、`serve` 与 `--port 7788` 的监听进程，再起新 node；日常用 `schtasks /Run /TN OmniMemory7788` 重启并等 `/health` 恢复 |
| 数据备份 | 复制 `$DSH_HOME/memory/omni.db`（建议先 `PRAGMA wal_checkpoint`） |

---

## 12. 路线图

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M0（已完成） | 存储 + 检索 + 工具 + 界面 + 捕获 + 注入 | FR-01..16 全绿 |
| **M1（已完成 v0.6.0）** | 迁移框架、POST 遗忘、notes/facts FTS、scope 全层生效 | D-03/04/06/08 关闭；63 用例 100% 通过；p95 11.7ms |
| **M2a（已完成 v0.7.0，历史里程碑，非当前基准）** | 向量路线（哈希 n-gram）+ RRF 融合 + 黄金集 | 当时 78 用例 100%；MRR 0.770→0.917；p95 12.6ms |
| **M2b（已完成 v0.8.0）** | 外部真语义嵌入（OpenAI 兼容），写入入队 + 检索前惰性刷新 | 87 用例 100%；零共享字改写查询可召回；端点宕机不影响词面 |
| **M3（已完成 v0.9.0）** | 图游走（按边召回）+ 冲突标记 | 96 用例 100%；图测试覆盖跳数/开关/作用域 |
| **M4（已完成 v1.0.0）** | 做梦校验（覆盖度 + 特征词缺失，dry-run/apply） | 101 用例 100%；「错记 Docker」样例可复现纠正 |
| **M5（已完成 v1.1.0）** | 面板分页 + 校验状态展示 + 中英 i18n + 转录增长治理 | 107 用例 100%；D-10/11 关闭 |
| **M6（已完成 v3.9.2）** | 内置 BGE-small-zh int8 + ONNX Runtime WASM；四路 RRF；零配置离线语义 | 当时 348 用例 100%；黄金集 MRR 0.979；冷加载 208ms / RSS 216MB |

---

## 13. 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 14. 配置项与默认值（决策记录）

环境变量在**进程启动时**读取；修改后需重启 DSH 才生效。本表是默认值的唯一事实来源。

| 配置项 | 默认 | 取值 | 影响 | 成本 / 风险 | 依据 |
|---|---|---|---|---|---|
| `OMNI_SCOPE_JUDGE` | **`off`** | `off` / `auto` / `always` | 写入后是否让模型复核层归属 | 默认不把写入正文发给模型；显式开启后每条写入一次 `llm` 调用 | ADR-014/015/017 |
| `OMNI_JUDGE_PROVIDER` | 第一个已注册 provider | provider 路由 | 复核使用的模型提供方 | 选错 provider 会调用不计费/不可用模型 | ADR-015 |
| `OMNI_JUDGE_MODEL` | 自动挑选（优先 `flash/mini/haiku/small/lite`） | 模型 id | 复核使用的模型 | 大模型更准但更贵 | ADR-015 |
| `OMNI_AUTO_RECALL` | 开启（未设置即开） | `0` 关闭 | 装配时是否用当前用户消息预取 top-3 | 每轮一次本地检索（10k 行 p95 ≈ 10ms） | ADR-012 |
| `OMNI_DREAM_INTERVAL_MS` | `0`（关闭） | 正整数毫秒 | 后台做梦校验的周期 | 每次最多 100 条笔记 × 300 条转录 | ADR-010 |
| `OMNI_DISABLE_VECTOR` | 未设置 | `1` 关闭 | 同时关闭 hashed/远程向量与本地语义 | 关闭后退化为纯词面：黄金集 MRR 0.958 → 0.776 | ADR-006/007/029 |
| `OMNI_DISABLE_HASHED` | 未设置 | `1` 关闭 | 只关闭 hashed/远程向量 | 保留本地语义；用于测量语义单独质量（0.958） | ADR-007/029 |
| `OMNI_DISABLE_SEMANTIC` | 未设置 | `1` 关闭 | 只关闭内置本地语义 | hashed/词面/图仍工作；黄金集回落到 0.927 | ADR-029 |
| `OMNI_SEMANTIC_MODEL_DIR` | 包内 `models/bge-small-zh-v1.5` | 目录 | 替换本地语义模型 | 需同结构 int8 ONNX + tokenizer | ADR-029 |
| `OMNI_SEMANTIC_BATCH` | `8` | 1–64 | 本地语义每批条数 | 越大越快回填，单批内存越高 | ADR-029 |
| `OMNI_DISABLE_GRAPH` | 未设置 | `1` 关闭 | 是否启用图路线 | 关闭后事实链的关联召回消失 | ADR-009 |
| `OMNI_EMBED_URL` | 未设置 | OpenAI 兼容端点 | 可选：覆盖为远程向量后端 | 需外部服务；本地语义仍独立运行 | ADR-008 |
| `OMNI_EMBED_MODEL` | `text-embedding-3-small` | 模型 id | 远程嵌入模型 | — | ADR-008 |
| `OMNI_EMBED_KEY` | 未设置 | API key | 远程鉴权 | 缺失时远程调用失败并降级 | ADR-008 |
| `OMNI_EMBED_TIMEOUT_MS` | `10000` | 毫秒 | 远程嵌入超时 | 超时即保留队列、只用词面返回 | ADR-008 |
| `DSH_HOME` | 宿主默认 | 目录 | 数据库位置 `$DSH_HOME/memory/omni.db` | 换目录等于换库 | ADR-001 |

### 14.1 为什么默认是 `off`

- **隐私优先**：默认不把笔记正文发到任何外部模型；需要更准的层归属时，用户显式打开 `auto` / `always`。
- **代价**：显式打开后，每条写入多一次极小模型调用；写入路径**不等待**它（异步复核），交互延迟不变。
- **失败模式**：模型不可用 / 超时 / 返回空 → 保留规则判定，写入早已成功；空输出不会再把项目笔记改成 `global`。
- **回退**：`auto`（只复核没把握的）或 `always`（全部复核）；`off` 完全离线。
- **两条豁免**：显式 `scope` 不复核（调用方优先）；无项目上下文不复核（没有层可选）。

### 14.2 判断与归属的兜底顺序

1. 写入：显式 scope → 规则（跨项目措辞 / 项目痕迹 / 保守落项目）→ 可选的模型复核。
2. 装配：`scope.id` 精确匹配 → 前缀匹配最近捕获的会话；未知 scope 只走全局，不继承上一项目。
3. 检索：显式 scope → 当前项目（含全局）→ 全局；`scope=all` 只读，写入会直接报错。
4. 工具调用：只使用 tool context 的 `agent/session/scope.id` 解析项目；没有 context → `global`，不再回退到最近一次装配或上一项目。

### 14.3 调参建议

- 想省钱又怕误判：`auto`，只让模型复核规则没把握的（约三分之一写入）。
- 完全离线/隐私敏感：`off` + `OMNI_DISABLE_VECTOR=1`，只保留词面与规则。
- 复核太慢导致层归属"跳动"可见：把 `OMNI_SCOPE_JUDGE` 改 `auto`，或把 `OMNI_JUDGE_MODEL` 固定成更快的模型。



