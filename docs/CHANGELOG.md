# 变更记录

格式遵循 Keep a Changelog；版本遵循语义化。可靠性 = `npm test` 通过率。

## [4.6.3] — 2026-11-26

### 修复
- **漏跑检测回归**：`check-docs` 在 TAP 存在时新增 `# tests >= 声明数` 下界；测试文件因 glob、语法或加载失败没被 runner 发现时，计数变小会失败，不能再用 `fail=0` 放行。
- **TAP 摘要可拼接**：`check-test-results` 拒绝重复的 `# tests` / `# pass` / `# fail` / `# cancelled` 标签，并要求全文件只有一个 `1..N` plan 且与 `# tests` 一致；复现的“前后两段摘要”绕过已关闭。
- **缺文档抛栈**：`check-docs` 遇到缺失的必需文档时输出 `missing required doc: <path>` 并退出，不再抛出未捕获的 `ENOENT`。

### 变更
- **测试钩子防误设**：`testModeEnabled()` 的 `NODE_TEST_CONTEXT` 收紧为 `child` / `child-vN`，任意非空字符串不再生效；文档明确该门只防部署误设，不是抗篡改安全边界。
- **平台条件**：`property-scope-alias` 改用被测语义变量 `platform` 判断大小写别名差异，修正 macOS 上按 Linux 语义误跑的问题。

### 测试
- 保持 **486/486**；新增 TAP 重复摘要与 plan 不一致的负向实测，测试模式任意字符串不再放行。schema 仍为 20，无数据迁移。

## [4.6.2] — 2026-11-26

### 安全
- **插件侧无 Host fail-closed**：`lib/read-routes.mjs` 不再对缺失 `Host` 的请求放行；缺失或不可信 Host 一律 403，与 standalone `hosts/http/server.mjs` 对齐。所有测试请求显式注入 Host，新增插件路由与原始 HTTP 两层回归。
- **测试钩子二道门**：`OMNI_TEST_MODE=1` 之外还要求 `NODE_TEST_CONTEXT`（仅 `node --test` 及其子进程存在），避免部署侧误设单个变量就替换签名公钥、keyId 或 git 源。

### 变更
- **规则文本统一**：stdio `hosts/mcp/bin.mjs` 与 HTTP `hosts/http/server.mjs` 的 `initialize.instructions` 改为完整 `RULES_TEXT`，与 `prompts/get`、`resources/read`、`memory_rules` 同文；不再维护摘要副本。
- **测试真值门**：`npm test` 输出 spec + TAP，新增 `scripts/check-test-results.mjs`，`npm run verify` 校验真实 `# pass` / `# fail` / `# cancelled`，不再用源码 `test(` 计数代替运行结果；全量超时改为 120s。
- **测试可移植性**：项目路径用例改用 `projectCwd()` 生成 OS 临时目录，消除 Linux 上合成 `C:\...` 落入仓库并误取 `.omni-project` 的问题；`schtasks` 不可用时明确 skip；1000 文件 warm sync 改为「2s 或 2×cold」的相对预算并输出诊断。

### 文档
- README 规则通道改为「五条入口共享同一份 `RULES_TEXT`」；REFERENCE 补 REST `/search` 的 `limit` 默认 30 / 上限 60 与 persona `clear` 仅 HTTP 管理面；DESIGN/CHANGELOG 修正 `OMNI_TEST_UPDATE_PUBLIC_KEY_FILE` 变量名。
- `scripts/check-docs.mjs` 增加 HOST-ADAPTERS、REFERENCE、OpenAPI path 数、规则口径、persona 归属、REST limit 与旧变量名校验。
- `docs/COMPLETION-4.6.2-2026-11-26.md` 记录复核结论、改动、测试证据与未采纳项。不改 schema（仍为 20）。

### 测试
- 新增插件侧缺失 Host 403、原始 HTTP 缺失 Host 拒绝、stdio/HTTP instructions 同文、测试模式二道门等用例。
- 完整 `npm test` **486/486** 通过；TAP `# tests 486`、`# pass 486`、`# fail 0`、`# cancelled 0`。

## [4.6.1] — 2026-11-26

### 安全
- **只读 HTTP 路由补 Host 校验**：`/omni-memory/*` 所有只读路由在 loopback 之外增加 Host 校验，伪造 Host 读 `/export`、`/search`、`/status` 返回带 `error` 的 403；`/export` 限定 GET，POST 返回 405。
- **共享信任守卫**：`isLoopback`、可信 Host、Host 解析、同源与写操作判定收拢到 `hosts/shared/http-guard.mjs`，`index.js`、`hosts/http/server.mjs`、`lib/read-routes.mjs` 共用；服务级守卫拒绝缺失 Host，路由层拒绝存在但不可信的值。
- **HTTP `/tool` 落层**：省略 `arguments.scope` 时使用服务启动时解析出的项目/会话 scope，不再默认落 global；显式 `scope` 仍优先。
- **参数边界**：`project_search` 及四个项目查询函数把 `limit` 钳到 1..上限的有限整数，负数/0/非数回退默认，超大值钳到上限。
- **可观测性**：跨 scope 审计失败写 stderr，只记错误消息，不打印查询正文；写入不因审计失败回滚。
- **测试钩子门**：`OMNI_TEST_GIT_FETCH_URL`、`OMNI_TEST_UPDATE_PUBLIC_KEY_FILE` 等仅在 `OMNI_TEST_MODE=1` 时生效；生产环境遇到 `OMNI_TEST_*` 只告警并忽略。

### 修复
- `scripts/install.mjs` 的 `--key=value` 按第一个 `=` 切分，值里再含 `=` 不再丢后半段。
- `hosts/cli.mjs` 删除重复 `case 'index'`；`scripts/verify-release.mjs` 不再把 HTTP 响应体前 160 字符拼进错误。
- 新增 `npm run verify`（`npm test && npm run check`），作为发布前真值门。

### 文档
- `docs/HOST-ADAPTERS.md` 同步 4.6.1 / 30 工具 / 26 路由 / OpenAPI 15 path；当时把“五通道同一份文本”改为“三条读取通道共享 RULES_TEXT，instructions 为接入摘要”，4.6.2 已统一为完整同文。
- README、DESIGN（FR-48、§6.15）、REFERENCE、CHANGELOG 同步 4.6.1；`docs/REMEDIATION-BACKLOG.md` 固化延后与不采纳项。
- 不改 schema（仍为 20）。

### 测试
- 新增 `test/remediation-4.6.1.test.mjs` 3 项：Host 守卫、loopback 判定、审计失败告警。
- 扩展 `test/http-security.test.mjs` 2 项：伪造 Host 读 `/export`/`/search`/`/status` 403、POST `/export` 405。
- 扩展 `test/http-lifecycle.test.mjs` 1 项：HTTP `/tool` 写项目层、默认搜索可见、显式 global 不可见。
- 扩展 `test/project-index.test.mjs` 1 项：负数/超大/非数 limit 钳制。
- 完整 `npm test` **483/483** 通过（原 476 + 新增 7）。

## [4.6.0] — 2026-11-26

### 变更
- **项目代码索引**：schema 升到 20，新增 `code_files`、`code_symbols`、`code_apis`、`code_modules`、`code_edges` 五张派生表。只存路径、行号、签名、短摘要、`sourceRef` 与 `sha256`，**不存源码正文**；索引是可重建缓存，源码始终是权威。
- **一条命令建立/增量重建**：`omni index [--dir] [--scope] [--full] [--no-ctags] [--json]`；按 manifest/顶层源目录发现模块，monorepo 子包各自成模块；变更文件只替换自己的符号/API/出边，删除文件清理对应行，不误删其他文件指向它的入边。
- **漂移检测**：先比 `mtime_ms + bytes`，相同且已知 sha 时仍重读比对 sha，捕获“内容变了但 stat 未变”；查询时按当前文件 stamp 标 `stale`/`missing`。
- **适配器**：JS/TS 导出、函数、类、方法、导入、Express/Koa/Fastify、`route({method,url})`、装饰器、Next.js `app/**/route.ts` 与 `pages/api/**`；OpenAPI/Swagger JSON+YAML；GraphQL SDL；Python/Go/Rust/Java/Kotlin/C#/PHP/Ruby/GDScript/Lua/Swift/Dart 走 generic，可选 universal-ctags JSON 增强。
- **查询面**：5 个 `project_*` MCP 工具（`project_sync` / `project_search` / `project_context` / `project_status` / `project_impact`）、5 条 `/omni-memory/project/*` HTTP 路由、CLI `omni project status|search|context|impact|sync`、`/project` 页面。结果带 `path`、`line`、`sha`、`stale`、`sourceRef`；`project_impact` 走反向静态 import BFS，并附模块 tests 边与直接 import 的测试文件。
- **与记忆合并**：`memory_context` 命中项目引用时追加有预算的项目包（`min(900, 1800)`）；显式项目 scope 的 `buildMemoryPacket` 追加项目包（约 45% 预算，上限 1000）。每条带 `sourceRef`、行号、`sha`、`stale`；空结果分支返回 `project:null`。
- **OpenAPI 与文档**：`HOST_OPENAPI` 补齐 5 条 project path（共 15 条 path）；README、REFERENCE、DESIGN、ADR-032、CHANGELOG 同步到 4.6.0。

### 测试
- 新增 `test/project-index.test.mjs` 24 项：五表 schema、JS/TS/OpenAPI JSON+YAML/GraphQL/generic/ctags、增量、删除清理、sha 漂移、全量重建、不存正文、精确查询、上下文预算、影响面、monorepo、stale/missing、1,000 文件性能。
- 1,000 文件（1,001 含 package.json）专项：冷索引 <1s（验收上限 30s），热增量 `parsed=0` 且 <2s，40 次精确查询 p95 <50ms。
- 完整 `npm test` **476/476** 通过（原 452 + 新增 24）；路由 26 条、内核工具 28 个、MCP 工具 30 个。

## [4.5.1] — 2026-11-26

### 变更
- **hashed 向量孤儿清理**：新增 `pruneHashedVectors()`，只在启动时删除 owner 已删除/已 supersede 的 `vectors` 行，活跃行继续作为零配置兜底；新增 `hashed_gc_version` 标记，成功后才落标记。
- **画像域独立成模块**：`persona/profile/packet/openapi` 从 `index.js` 搬到 `lib/profile.mjs`（~640 行）；`index.js` 进一步从 1,231 行降到 **678 行**，只保留会话捕获、HTTP 安全壳、`attachSession` 与 `apply`。
- 不改 schema（仍为 19）、不改工具/HTTP 协议。

### 测试
- 新增 `test/hashed-gc.test.mjs`：孤儿向量删除、活跃向量保留。完整 `npm test` **452/452** 通过。

## [4.5.0] — 2026-11-25

### 变更
- **`index.js` 从 8,721 行降到 1,231 行**：只保留模块组装、公开导出、会话捕获与 `apply(ctx)`；核心按域拆到 `lib/store.mjs`（~3,300 行，SQLite/schema/迁移/向量/备份/候选）、`lib/search.mjs`（~1,500 行，词面/语义/图/RRF/dream）、`lib/tool-definitions.mjs`（~1,350 行，工具定义）、`lib/read-routes.mjs`（~1,130 行，HTTP 路由）。
- **运行时依赖注入，不反向 import `index.js`**：各模块用 `bindStoreRuntime()` / `bindSearchRuntime()` / `bindToolRuntime()` / `bindRouteRuntime()` 接收宿主函数与可变状态 getter，模块图保持无环；`store`、`lastInjection`、`lastSearchProfile`、`lastJudge`、`vectorDropped` 等仍走实时绑定，不拍启动快照。
- **`configureStore(home)` 支持同进程多 home**：ESM 缓存会复用模块，新宿主重新求值 `index.js` 时显式重置 `DB_FILE`、备份目录、workspace 缓存、SQLite 单例与检索缓存；`closeStore()` 在宿主 dispose 时关闭句柄，顺序启动的 HTTP 实例可安全接管同一库。
- **不改 schema、不改工具/HTTP 协议**：`SCHEMA_VERSION` 仍为 19；23 个工具与 21 条路由的名称、参数、返回结构不变。

### 测试
- 完整 `npm test` **451/451** 通过；`node --check` 覆盖 `index.js` 与四个新模块；黄金集 `semantic-first` MRR **0.958**、recall **1.0**，与 4.4.0 持平。
- 回归覆盖：工具注册、候选审阅/巩固、备份导入导出、HTTP 生命周期顺序重启、`/overview` 聚合、语义回填与锁超时。


## [4.4.0] — 2026-11-25

### 变更
- **双向量收敛为“语义为主、hashed 兜底”**：`runSearch` 先跑词面召回，再将词面候选交给内置语义；语义有结果时不再融合 hashed `vectors`，语义不可用、失败或空结果时 hashed 才接手。语义不再排在 hashed 之后，也不再被 `OMNI_DISABLE_VECTOR` 连带关闭。
- **新增诊断开关 `OMNI_DISABLE_HASHED=1`**：只关闭 hashed `vectors`，保留本地语义，用于分离测量两路质量；`OMNI_DISABLE_VECTOR=1` 仍按历史行为同时关闭两路。
- **hashed 写入不变**：CLI 零配置且本地语义模型缺失时，hashed 仍是唯一向量召回；本版不删除 `vectors` 表，也不清理现有 5 MiB，避免默认召回从 0.927 掉回 0.776。
- **修掉版本硬编码测试**：`open-source.test.mjs` 改为校验 semver 格式并与 `package-lock.json` 一致，不再每版手改。

### 测试
- 黄金集新增“仅语义无 hashed”模式：词面 **0.776** → hashed **0.927** → 仅语义 **0.958** → 语义优先 **0.958**（旧双路 0.979，recall 仍 1.0）。完整 `npm test` **451/451** 通过。

## [4.3.3] — 2026-11-25

### 变更
- **`notes_fts` 改为 external-content 索引**：schema 升到 19，`notes_fts` 使用 `content='notes'`、`content_rowid='id'`，不再另存 `notes_fts_content` 正文副本。迁移只索引 `deleted_at IS NULL AND superseded_by IS NULL` 的笔记，保留 trigram 分词器；生产库 `VACUUM` 实测 29,462,528 → 27,475,968 bytes（约 −1.9 MiB）。
- **6 个 trigger 接管 note FTS 同步**：插入写索引；正文更新删旧写新；supersede / tombstone 删旧索引；恢复 active 时重新写入；物理删除按旧正文执行 external-content `'delete'`。通用 `reindexRow()` / `dropDerivedRows()` 跳过 note FTS，禁止再手写 `DELETE WHERE rowid`。
- **启动回填跳过 external notes**：`backfillFts()` 在 external 模式下不再写 `notes_fts`，避免与 trigger 重复插入。

### 测试
- external-content 的 `SELECT COUNT(*) WHERE rowid` 会通过 content 表返回源行，不能证明索引已删；回归测试改为验证旧文本不再命中旧 id，并让 100k 性能 seed 在 external 模式下只插 `notes`。完整 `npm test` **451/451** 通过，黄金集 recall **1.0** / MRR **0.979**。

## [4.3.2] — 2026-11-25

### 变更
- **bigram 索引改为 `WITHOUT ROWID`**：主键改为 `(gram, layer, owner_id)`，正好匹配两字中文查询的访问顺序；删除路径保留 `bigrams_owner(layer, owner_id, gram)` 覆盖索引。旧表原先同时存 hidden rowid、复合主键索引和 `(gram,layer,owner_id)` 索引，同一份 gram 实际存三遍。迁移后生产备份 `VACUUM` 实测 31.3 MiB → 26.1 MiB，两字查询召回不变。
- **star-map 内联脚本外置**：1,166 行主脚本从 `star-map.html` 移到 `hosts/http/web/star-map.js`，`npm run check` 的 `node --check` 门禁从 56 个文件扩到 57 个，语法错误不再只能靠浏览器发现。
- **前端公共函数收敛**：新增 `hosts/http/web/base.js`，统一 `$`、`fmt`、`setText`、`ago`、`showError`、`getJson`；`hub.js` / `mobile.js` 删除重复实现，`hub.html` / `m.html` 先加载 `base.js`。

### 测试
- 新增 v18 bigram schema 与两字召回回归；迁移备份文件名断言改为跟随 `SCHEMA_VERSION`；完整 `npm test` **451/451** 通过。

### 范围
- 本补丁不包含 P2-3 `index.js` 拆分、P2-5 双向量收敛；P3-9 `notes_fts` external-content 试做时发现手写 DELETE 会破坏外部内容索引，已回退，留待带 trigger 的独立改造。

## [4.3.1] — 2026-11-25

### 修复
- **`memory_write` 校验 `kind` 白名单**：只接受 `note` / `fact` / `episode`；未知值直接报错，不再静默降级为 note。CLI `write` 同样输出一行错误并退出 2。
- **`memory_context` 读路径不再等待版本探针**：只读取 `omni-version-check.json` 的缓存结果；缓存缺失或过期时不发网络请求。CLI `context` 在 `OMNI_VERSION_CHECK_TTL_MS=1` 下仍为 **142ms**，旧路径为 0.5–2.5s。HTTP `/packet` 仍保留实际刷新。
- **CLI 布尔 flag 不再吞掉后面的关键词**：`--semantic`、`--json`、`--rerank`、`--apply` 等已知布尔 flag 不消费下一个 token；`--semantic 记忆` 现在等价于 `--semantic -- 记忆`。
- **HTTP 空查询回填请求 scope**：`q=&scope=global` 返回 `scope:"global"`，不再固定为 `all`。
- **CLI 工具参数错误统一一行提示 + 退出 2**：覆盖 `search`、`write`、`forget`、`feedback`、`report`、`candidates`、`candidate`、`consolidate`、`ingest`、`context`。

### 测试
- `npm test` 加 `--test-timeout=60000`，把并行跑测试时的挂起变成明确失败；完整套件 **450/450** 通过。

## [4.3.0] — 2026-11-25

### 性能
- **CLI 默认不再冷加载语义模型**：`context` / `search` 默认走词法 + hashed 向量；`--semantic` 或 `OMNI_CLI_SEMANTIC=1` 才加载 37.5 MiB 的本地 bge-small-zh。实测同一查询：`search` 默认 **139ms**、`--semantic` **478ms**；`context` 默认 **144ms**、`--semantic` **467ms**。MCP / HTTP 常驻进程保持默认启用本地语义。
- **搜索返回结构单一构造点**：`buildSearchResult()` 统一 `total` / `returned` / `offset` / `truncated` / `scope` / `hits`，MCP 空结果、MCP 正常结果与 HTTP 路由不再各写一份。

### 修复
- **CLI 参数错误不再抛 stacktrace**：`omni search --limit 99` 现在输出一行 `limit must be a number between 1 and 30`，退出码 2；`0` 仍是“无命中”，`1` 仍是内部失败。

### 测试
- 新增 CLI 参数错误退出码/单行输出回归；完整 `npm test` **447/447** 通过。

## [4.2.1] — 2026-11-25

### 修复
- **CLI 默认项目解析不再落回 chat cwd**：未给 `--dir`、未设置 `OMNI_PROJECT_DIR` 时，先向上查找 `.omni-project` / `.omni/project.json`；找不到则回落到 CLI 所在仓库根。从聊天目录执行 `omni search` 现在落到 `proj:全息记忆#30534c`，不再落到 `proj:new-chat#5af3cd`。
- **HTTP 搜索返回分页元数据**：`/omni-memory/search` 补充 `total`、`returned`、`offset`、`truncated`，与 MCP / CLI 的成功搜索返回口径一致；空查询也返回完整零值。

### 测试
- 新增 CLI 外部 cwd 默认解析回归、HTTP 搜索元数据回归；完整 `npm test` **446/446** 通过。

## [4.2.0] — 2026-11-25

### 修复
- **项目身份不再靠路径哈希赌运气**：仓库根 `.omni-project` 可声明稳定 `key` / `name`；`projectShow`、CLI 与写入统一优先读它。同仓库从任意盘符或大小写路径进入，都会落到同一个 `proj:全息记忆#30534c`；没有文件的旧仓库仍走路径哈希，并提供 `omni project init` 生成。
- **CLI `--dir` 硬绑定项目层**：`write` / `ingest` / `candidates` / `consolidate` 在给了 `--dir` 且没有 `--scope` 时强制 `scope=project`，分类器不再把“偏好/规则”这类字样误判成 global；全局规则必须显式 `--scope global`。
- **画像与领域知识分层**：`buildProfileText` 过滤 `专业知识/`、知识库、测试/审计/部署报告和工具清单，只保留用户规则与项目结论；`personaEvidence` 用独立过滤，避免技术碎片进入人设。新增 `omni kb-migrate`（默认 dry-run，`--apply` 才迁移），把 1,208 条知识库笔记从 global 移到 `proj:专业知识#967a81`。
- **搜索输出可用**：`memory_search` 返回完整 `text`、`snippet`、`matchedTerms`、`score`、`why`、`total` / `returned` / `offset` / `truncated`；CLI 支持 `--json` 与 `--offset`，不再每条硬截 400 字；命中按新旧加权，旧版本结论标记 `staleVersion`。
- **待审与版本新鲜度口径**：`/overview` 新增 `pendingBreakdown`（争议笔记/争议事实/候选/被替代/过期事实）与 `coverage`（转录、事实、图谱、召回、来源覆盖率）；`/hub` 的待处理数改用单一 `pending`，不再重复累加候选与争议。

### 测试
- 新增 CLI 项目身份、画像过滤、搜索输出、旧版本标记、kb 迁移与 overview 口径用例；完整 `npm test` **444/444** 通过；`npm run check` 通过（444 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.2.0、syntax 56 files）。

## [4.1.1] — 2026-11-24

### 界面
- **手机端读数从三列统计条改为一行档案读数**：`/m` 顶部不再放“大数字三列”，改成 `活跃条数 · 健康度 · 工具数` 的单行排版；继续使用同一套墨色底稿语言，进一步去掉视频里的“状态三指标”观感。只改排版，数据来源与只读边界不变。

### 测试
- 完整 `npm test` **438/438** 通过；`npm run check` 通过（438 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.1.1、syntax 56 files）。

## [4.1.0] — 2026-11-24

### 界面
- **`/hub` 从六卡总览改为本机记忆档案索引**：去掉等宽六卡、英文 kicker 与“中枢”式模块叙事，改成墨色底稿页面：衬线大标题、真实运行状态卡、01–06 横向索引行（记忆库 / 检索 / 关系图 / 项目 / 接入 / 状态）、最近归档与底稿宣言。数据绑定仍是 `/omni-memory/overview` 与 `/health`，没有示例数字。
- **`/m` 从星空 hero + 统计卡改为手机端纸质底稿**：同一套墨色、琥珀和衬线字体语言；顶部本机档案头、竖排 hero、三段统计、下划线搜索、可展开的归档条目、底部三栏导航。继续只读，不新增手机写入口。
- **`/hub` 不再复用 `dashboard.css`**：不再继承深色星空变量、topbar 与点阵背景，避免与视频里的六卡/星空界面语言继续同形；`/m` 的 `mobile.css` 同步重写。
- **`/star-map.html` 不动**：星图在 `9d6794a` 已存在，早于本次参考视频，不算本轮照搬对象。

### 文档
- README 首屏、截图说明与版本示例同步；`docs/DESIGN.md` FR-45 改为“非等宽档案索引 + 纸质底稿式手机端”；`docs/REFERENCE.md` 同步 `/hub`、`/m` 的入口说明。
- 重新生成 `docs/images/hub.png`、`docs/images/hub-full.png`、`docs/images/mobile.png`，全部来自本机真实 7788 数据。

### 测试
- 完整 `npm test` **438/438** 通过；`npm run check` 通过（438 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.1.0、syntax 56 files）。

## [4.0.1] — 2026-11-24

### 修复
- **Node 路径变化后启动器拒绝停旧监听**：Windows 启动器原先要求旧监听进程的 node.exe 绝对路径与当前侧车配置完全一致；升级 Node 后旧进程仍在跑，`npm run setup` 会报 “port 7788 is held by a non-omni process”，服务停留在旧版本。`IsOmniNode` 现在接受任意 `node.exe` / `node`，只要命令行同时匹配 `hosts\cli.mjs serve --port <当前端口>`；不再依赖 Node 安装路径。
- 重新可复现构建启动器，SHA-256 从 `fd7dfa64…` 更新为 `d7ba3e76…`；`package.json.omni.launcher.sha256` 同步。`check-launcher` 重建一致。

### 测试
- 完整 `npm test` **438/438** 通过；`npm run check` 通过（438 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.0.1、syntax 56 files）。
- v4.0.1 Release 清单与启动器 SHA-256 复验一致。

## [4.0.0] — 2026-11-24

### 许可与治理
- **许可证切换为 AGPL-3.0-only**：`LICENSE` 替换为 GNU AGPL v3 官方全文；`package.json` 的 `license` 改为 `AGPL-3.0-only`；52 个源码/文档文件的 SPDX 头从 `LicenseRef-Omni-Memory-Personal-Use-1.1` 迁移为 `AGPL-3.0-only`，删除 NonCommercial 限制行。
- **商业例外模型**：`LICENSING.md` 重写为“AGPL 自由商用 + 闭源/闭源 SaaS 商业例外”；`ATTRIBUTION.md` 改为 AGPL 合规署名；Issue 模板改为“商业例外申请”；README 许可证段与 badge 同步。
- **治理文件**：新增 `CONTRIBUTING.md`（DCO、测试门禁、提交规范）、`SECURITY.md`（私密报告、响应时限、范围）、`CODE_OF_CONDUCT.md`（Contributor Covenant 2.1 改编）、`GOVERNANCE.md`（维护者、ADR、发布、签名密钥、商业例外）。

### 可信首次安装
- **`npm run setup` 改为发布验签路径**：新增 `--require-release`，先调用 `scripts/verify-release.mjs` 验证官方 Release 的 Ed25519 清单、tag/version/commit，再要求当前 `HEAD` 等于签名 commit、工作树没有未提交的跟踪文件，最后才安装启动器与计划任务。任何一步不符在写文件前失败。
- **保留开发入口**：`npm run setup:dev` 只校验同提交 `package.json` 的启动器 SHA-256；`npm run setup:dry:release` 只验证与打印计划；`install-launcher.mjs` 返回 `launcherIntegrity: "release-manifest-v2"` / `releaseSignatureVerified: true`，不再把本地哈希安装标成签名安装。
- **文档**：新增 `docs/INSTALL-RELEASE.md`，写清两条路径、9 步校验顺序、防什么/不防什么、镜像与离线边界；`docs/QUICKSTART.md` 给出 5 分钟源码路径与官方安装路径。

### 公共 QA 与上手
- **`npm run demo`**：`scripts/demo.mjs` 在临时目录启动隔离库，写入 note + fact 并召回，不碰真实 `~/.dsh`。
- **`npm run qa`**：`scripts/qa.mjs` 跑黄金集与 120 例质量套件，支持 `--json`；`docs/PUBLIC-QA.md` 记录 4.0.0 基线（golden recall 1.000 / MRR 0.979；quality 120/120，p50 2ms）。
- **测试**：新增 `test/open-source.test.mjs` 四条：AGPL/版本、治理文件、setup 默认验签、安装帮助。

### 测试
- 完整 `npm test` **438/438** 通过；`npm run check` 通过（438 tests、23 core / 25 MCP、21 routes、31 ADRs、version 4.0.0、syntax 56 files）。
- `npm run qa -- --quality-count 120 --json` 通过：golden 24/24、quality 120/120。

## [3.12.3] — 2026-11-24

### 新增
- **公开发布验证（开源发布第一步）**：新增 `npm run verify:release` / `scripts/verify-release.mjs`。它从官方 GitHub Release 下载 `omni-update-manifest-v2.json`（旧版本回退 v1），用内置固定 Ed25519 公钥验签，校验 tag/version/commit，再通过 GitHub Contents API 读取签名 commit 上的 `package.json` 与启动器并比对 SHA-256。`--launcher <path>` 可校验从镜像或第三方渠道下载的启动器 exe。只读，不移动 HEAD、不安装、不重启。历史 Release 不受 180 天更新时效限制；`daily-sync --apply` 仍执行完整时效窗口检查。
- 新增 `test/verify-release.test.mjs`：覆盖正常验签与哈希绑定、清单篡改、启动器哈希不符、本地启动器比对失败四条路径。
- 新增 `docs/VERIFY-RELEASE.md` 与 `docs/OPEN-SOURCE-LAUNCH-PLAN.md`；README 增加“验证发布物”入口。

### 说明
- 这一步不改变 `npm run setup` 的信任边界：setup 仍只校验同提交 `package.json` 声明的启动器 SHA-256，不验 Release 签名；首次安装的受信任入口仍是独立签名安装器或源码构建路径。
- GitHub Contents API 替代 `raw.githubusercontent.com`，避免部分网络重置 raw 域名；匿名 API 限额 60 次/小时，可用 `GITHUB_TOKEN` 提升。

### 测试
- 完整 `npm test` **434/434** 通过；`npm run check` 通过（434 tests、23 core / 25 MCP、21 routes、31 ADRs、version 3.12.3、syntax 54 files）。
- `verify:release` 对 v3.12.2 真实 Release 复验通过，签名 key 指纹、`package.json` 哈希、启动器哈希与本地已安装 exe 一致。


### 修复
- **churn 库静默丢召回（复审 P2）**：3.12.1 用 `MAX(id)` 判断大库；软删墓碑会抬高 id 高水位，导致只有少量活行的库误入 5,000 窗口，墓碑间隙以下的活行检索不到。3.12.2 先看高水位，再用可召回行数确认（notes 排除 `deleted_at`/`superseded_by`，facts 排除 `deleted_at`/`valid_to`，chunks 排除 `deleted_at`）；行数缓存 60 秒（`OMNI_ACTIVE_COUNT_TTL_MS`），只有可召回行数也超过阈值才收紧窗口/向量采样。新增 `test/churn-window.test.mjs`：16,000 条墓碑 + 1 条活行，单字仍命中。
- **`OMNI_LARGE_STORE_ROWS` 静默回退**：低于 10,000 时保留 10,000 安全下限，并打一行 warning；不再静默改成 250,000 让用户误以为配置生效。
- **`npm run setup` 的安全承诺与实现不一致（复审 P2）**：FR-45、README、安装帮助与输出统一改为“校验同提交 `package.json` 声明的启动器 SHA-256（本地自洽）”；Release Ed25519 签名只在 `daily-sync --apply` 验证。安装结果显式返回 `launcherIntegrity: "sha256-in-commit"`、`releaseSignatureVerified: false`，不再使用“签名启动器”这个会被误解的说法。
- **计划任务探测失败被当成“不存在”（复审 P3）**：`schtasks /Query` 现在区分 `present` / `missing` / `unknown`；权限或安全策略导致查询失败时返回 `unknown`，apply 阶段拒绝创建/修改任务并提示 `--no-task`，不再猜测后新建。`noTask` 时完全跳过 `schtasks /Query`，测试不再触发系统黑名单告警。
- **`doctor` 小库误报 fail（复审 P3）**：主库文件 `< 4096` 字节从 `fail` 降为 `warn`；WAL 刚创建、数据尚在 `-wal` 时不再阻断 preflight，真正的损坏交给 `PRAGMA integrity_check` 与必备表检查。

### 测试
- 新增 `test/churn-window.test.mjs`；`test/productization.test.mjs` 增加任务探测 `unknown` 拒绝、`noTask` 不调用探针、小库文件 `warn` 三条回归。
- 完整 `npm test` **430/430** 通过；`npm run check` 通过（430 tests、23 core / 25 MCP、21 routes、31 ADRs、version 3.12.2、syntax 53 files）。
- 1M + 5 万向量 + 100 万 bigram 复跑：p50 126.0ms / p95 **129.8ms** / max 221.1ms，400/400 命中，pass；首次查询含一次 COUNT，后续 60s 缓存。

## [3.12.1] — 2026-11-23

### 修复
- **A-06 大规模检索边界**：`OMNI_SEARCH_WINDOW` / `OMNI_VECTOR_SAMPLE` 从固定 20,000 / 5,000 改为按库规模自适应；最大 id 超过 250,000 时降到 5,000 / 1,000，小库保持原值。环境变量仍可显式覆盖。1M 行 + 5 万向量 + 100 万 bigram 本机 p95 从 **226.9ms 降到 129.4ms**；报告机器（i5-14600KF）同一收紧配置实测 257ms。黄金集 small-store full MRR 保持 **0.979**。
- **C-02 活 owner 迁移等待**：`openStore` 的固定 `25 × 200ms` 等待改为 `OMNI_OPEN_LEASE_WAIT_MS`（默认 150s，上限 300s，可配 0 立即失败），覆盖 1M 迁移实测 73–80s；等不到租约仍报错，不读取未迁移库。新增跨进程测试，持有租约 6s 后释放，第二个打开者成功续开。

### 测试
- 完整 `npm test` **426/426** 通过（新增 `test/open-lease-wait.test.mjs`）。
- `bench/golden.mjs` 通过：full recall 1.000、MRR 0.979。

## [3.12.0] — 2026-11-23

### 基准与质量
- **规模/字符体积**：新增 `bench/scale.mjs`，隔离临时库，测 100k 短笔记与 10k 长笔记各 10M 字符的 seed、库体积、RSS、检索 p50/p95；100k p95 **6.9ms**，10k 长笔记 p95 **27.4ms**。
- **确定性质量集**：新增 `bench/quality-lib.mjs`、`bench/quality.mjs`、`test/memory-quality.test.mjs`，覆盖 knowledge-update / conflict / scope-isolation / forget-restore 四类各 30 条，120/120 通过。
- **公开检索层**：新增 `bench/fetch-public.mjs`、`bench/public-retrieval.mjs`，接入 LoCoMo；session 粒度 evidence recall@10 **0.7134**、any-evidence **0.7583**、nDCG@10 **0.5621**；turn 粒度分别为 0.3483 / 0.3845 / 0.2193。明确只测检索，不是官方 QA 分数。
- **恢复演练**：新增 `test/recovery-drill.test.mjs`，导出备份到全新库导入后可检索；不再只测单点快照。
- **文档**：新增 [BENCHMARKS.md](BENCHMARKS.md)、[COMPARISON.md](COMPARISON.md)、[OPEN-GAPS.md](OPEN-GAPS.md)；C 类（官方 QA、真实用户、macOS 真机）单列记录。

### 可观测性与交付
- **`/metrics`**：HTTP 服务新增 loopback-only 指标入口，返回进程 uptime、请求数、错误数、MCP 请求/消息数、工具/路由数、RSS/heap；非回环请求 403。
- **容器**：新增 `Dockerfile`、`.dockerignore`，只提供 stdio MCP；HTTP 仍保持 loopback-only，不做无鉴权端口暴露。
- **Linux/CI**：新增 `docs/LINUX.md`（systemd 示例与 SSH 隧道边界）；CI 增加 `container` job，构建镜像并验证 MCP `initialize`；Linux/Windows 矩阵保留。
- **许可**：新增 `LICENSING.md` 双轨框架（个人非商业免费 / 商业书面授权），修正商业授权 Issue 模板中误写的 CC BY-NC 4.0；`LICENSE` 项目链接更新为 `omni-memory`。

### 测试
- 完整 `npm test` **425/425** 通过（423 + quality 1 + recovery 1）。
- `npm run check` 覆盖文档、客户端 hook、语法、启动器、语义资产与 update log。
- **跨平台守卫**：Linux CI 的 Node 构建没有 FTS5 时，FTS5 专项测试显式 skip；Windows-only 的 launcher 安装测试在非 Windows 上 skip。产品在没有 FTS5 时继续用 LIKE 字面召回，不把平台能力差异伪装成代码失败。

## [3.11.9] — 2026-11-23

### 产品化 · 首屏与入口
- **`/hub` 六卡总览**：新增面向普通用户的产品入口，记忆库 / 检索 / 星图 / 项目 / 工具 / 状态六张真实数据卡；数字来自 `/omni-memory/overview` 与 `/health`，不沿用示例值。现有 `/` 仪表盘保留，不作为默认替换。
- **`/m` 手机端**：只读搜索与最近写入；竖屏、拇指区、44px 触控目标，底部导航回到中枢/搜索/桌面。写操作仍走桌面面板，避免手机端成为第二个写入口。
- **README 首屏**：一句话定位、真实 `/hub` 与 `/m` 截图、5 分钟安装路径前置；许可证提醒移到文末许可证章节，不再压住价值主张。

### 安装与诊断
- **`npm run setup`**：包装现有内容寻址启动器安装器，先做只读 preflight，再安装启动器、写侧车配置、创建或修改计划任务；默认 dry-run，`--apply --start` 才落盘和启动。计划任务缺失时新增 `--create-task` 显式创建，避免“安装成功但服务没起来”。3.12.2 起明确：这里只校验同提交 SHA-256 自洽，不验 Release Ed25519 签名。
- **`omni doctor`**：新增只读诊断命令，检查 Node 版本、数据目录可写、SQLite `integrity_check` 与必备表、语义资产、7788 `/health`、计划任务是否指向当前内容寻址启动器、DSH 插件元数据；支持 `--json`、`--strict`、`--skip-http`、`--skip-task`。
- **可观测口径**：doctor 不创建数据库、不写配置、不改任务；数据库以 `readOnly` 打开，HTTP 只发 loopback GET。

### 测试
- 新增 `test/productization.test.mjs`：fresh home 的 doctor 只告警不落库、安装 dry-run 不写文件/不建任务、`/hub` 与 `/m` pretty-path 映射。
- 完整 `npm test` **423/423** 通过。

## [3.11.8] — 2026-11-23

### 修复 · 终验 P1：启动器信任链
- **启动器纳入签名清单**：新增 `omni-update-manifest-v2` schema，固定字段 `launcherPath` 与 `launcherSha256`；`sign-release.mjs` 从签名提交读取 `scripts/launchers/omni-serve-7788.exe` 的实际字节计算哈希。v1 清单继续保留，兼容旧客户端。
- **可复现构建**：新增 `scripts/build-launcher.mjs`，用 `csc /target:winexe` 编译后归一化 PE 时间戳和 .NET Module MVID，连续构建两次比对哈希；`--check` 只重建并与仓库二进制比对。`scripts/check-launcher.mjs` 已接入 `npm run check`。
- **配置驱动启动器**：`omni-serve-7788-launcher.cs` 不再硬编码仓库、Node 与日志路径；从 `omni-serve-7788.json` 侧车配置读取，支持 `OMNI_REPO` / `OMNI_NODE` / `OMNI_HTTP_PORT` 等环境变量回退。旧监听判定要求 Node 可执行路径、`hosts\cli.mjs`、`serve` 和精确 `--port` 同时匹配。
- **安装与卸载**：新增 `scripts/install-launcher.mjs`，校验提交内 `package.json` 元数据与启动器 SHA-256（本地自洽，不验 Release 签名），写内容寻址副本 `omni-serve-7788-<sha8>.exe` 和侧车配置，再改计划任务 action；默认不覆盖运行中的 exe。新增 `scripts/uninstall-launcher.mjs`，删除任务与侧车配置，默认保留日志、数据库和二进制，显式 `--remove-binaries --remove-logs` 才清理。
- **daily-sync 自动安装**：v2 清单验签、merge、syntax、测试和版本校验通过后，自动安装并切换启动器，不停止当前进程；安装失败返回 `launcher-install-failed` 并退出 2。

### 修复 · 终验 P1：备份、锁与 CLI 主链
- **备份失败默认 fail-closed**：迁移前备份抛错直接中止迁移；只有显式 `OMNI_MIGRATION_BACKUP_DEGRADE=1` 或 `OMNI_MIGRATION_BACKUP_STRICT=0` 才告警继续。
- **共享备份目录按库隔离**：备份文件名加入 `DB_TAG = sha256(resolve(DB_FILE)).slice(0,8)`，保留裁剪只匹配当前库；共享 `OMNI_BACKUP_DIR` 不再误删其他数据库的备份。
- **apply 锁按真实 repo**：锁名由 `realpath(repo)` 哈希生成，不同 `--state` 不能绕过同一 checkout 的互斥。
- **Bearer token 精确 host**：只有 `https://api.github.com` 才附加 GitHub token，`api.github.com.evil` 之类子串不再匹配。
- **rollback 二次检查**：`safeResetToBefore` 在 `reset --hard` 前再查 tracked 改动，发现验证过程改动文件就拒绝回滚。
- **CLI 主链断言**：新增离线 bare remote 的完整成功路径测试（验签 → fast-forward → syntax → launcher 安装），以及验签失败不移动 HEAD、apply 锁、Bearer host、rollback 拒绝 tracked 改动等断言。

### 测试与发布
- 完整 `npm test` **420/420** 通过；`npm run check` 覆盖文档、客户端 hook、全部运行时 JS 语法、C# 启动器编译/二进制一致性、语义资产和 update log。
- 终验报告中的 P2（NFR-08 口径、缓存 TTL、私钥权限测试、首开与语义内存、`index.js` 体量/静默 catch 等）未在本版全部关闭，继续留在下一轮。

## [3.11.7] — 2026-11-23

### 修复 · v3.11.6 复验 P0
- **迁移备份并发竞态**：备份文件名由“毫秒时间戳”改为“pid + UUID”，每个进程写自己的 `.tmp`，校验通过后再原子 rename；失败只清理本进程的临时文件，不再删除别的进程刚完成的备份。
- **备份移入维护租约**：`openStore()` 先建立 `meta` 表并取得 `open-maintenance` 租约，再备份、建 FTS 表和迁移；第二个进程拿到租约后会重新读取 schema 版本，已迁移则不再产生第二份备份。
- **备份失败降级**：备份抛错默认只向 stderr 告警并继续迁移，不再让插件加载失败；需要硬停的运维场景显式设置 `OMNI_MIGRATION_BACKUP_STRICT=1`。备份目录改为尊重 `OMNI_BACKUP_DIR`，备份文件按 `0600` 收紧。
- **回归用例**：新增两个真实进程同时首启 v16 库、备份失败仍可迁移、`--apply` 并发锁、伪造 origin、签名主路径包哈希/缺失提交拒绝等断言。

### 安全 · 签名链与更新入口
- **私钥权限门禁**：`sign-release.mjs` 在签名前检查私钥权限；POSIX 要求 `0600`，Windows 检查 ACL 不允许 `Users`/`Everyone`/`Interactive` 等宽泛主体。
- **origin 精确匹配**：更新器解析 remote URL 的 host 与 path，只接受 `github.com/wangzhen110/omni-memory`，不再用 `includes` 子串匹配。
- **apply 并发锁**：`--apply` 使用 `~/.dsh/omni-daily-sync.json.apply.lock`，同一时间只允许一个更新进程；锁按 pid 归属释放，30 分钟后才视为 stale。
- **长驻进程版本**：`/omni-memory/packet` 与 `/health` 按需读取当前 `package.json` 版本，不再返回模块加载时冻结的版本。

### 工具链与交付
- **语法门禁**：新增 `scripts/check-syntax.mjs`，递归检查 `index.js`、`client.js`、`lib/`、`hosts/`、`scripts/` 的全部运行时 JS，替换原先手工列举的漏网清单。
- **跨平台测试**：`--run-tests` 在非 Windows 使用 npm 命令或 `npm_execpath`，不再固定拼 `npm.cmd`。
- **启动器源码入库**：`scripts/launchers/omni-serve-7788-launcher.cs` 与部署的 `omni-serve-7788.exe` 对应，源码与构建命令见 `docs/SILENT-LAUNCHER.md`。
- 完整 `npm test` **408/408** 通过；`npm run check` 的语法门禁覆盖 34 个运行时文件，版本 3.11.7。

## [3.11.6] — 2026-11-23

### 安全 · 更新链加入 Ed25519 签名校验
- **默认只报告**：`node scripts/daily-sync.mjs` 不再 fast-forward、不重启 7788；只输出 `update-available` / `up-to-date` 和 `--apply` 命令。更新必须显式传 `--apply`。
- **签名清单**：发布时由 `scripts/sign-release.mjs` 生成 `omni-update-manifest.json`，用 Ed25519 私钥签名，作为 GitHub Release asset 上传。清单绑定 `version`、`commit`、`tag`、`package.json` SHA-256 和 key id；未知字段一律拒绝。
- **固定公钥**：`lib/update-signature.mjs` 内置公钥指纹 `76:f3:5c:2d:c5:d6:f7:7e:a8:4d:9b:03:26:c0:7f:fc:d5:94:70:50:8c:bf:c4:41:75:a5:59:c1:67:a9:10:f1`；私钥只放在 `~/.dsh/omni-update-signing-key.pem`，权限限制为当前用户读写，不入库。
- **apply 闸门**：`--apply` 先验签，再校验签名提交在 `origin/main` 历史内、`package.json` 哈希与版本一致、工作树无 tracked 修改；只快进到签名提交，不再把任意 `origin/main` 合并进来。失败不重启服务，`--restart` 才显式重启。
- **兼容边界**：3.11.5 及更早的更新链没有签名校验；3.11.6 是第一个带签名清单的 Release。升级到 3.11.6 之后，后续 `--apply` 才会强制验签。

### 可靠性 · 存储迁移与服务启停
- **迁移前备份**：真实 schema 升级前用 `VACUUM INTO` 写 `memory/backups/pre-migrate-v<old>-to-v<new>-*.db`，做 `PRAGMA integrity_check`，保留最近 5 份；备份失败则拒绝迁移。全新空库不产生无意义备份。
- **迁移事务化**：`migrate()` 的 DDL、修复和版本标记在同一个 `BEGIN IMMEDIATE` 里提交，失败自动回滚；嵌套写入改用 SQLite savepoint，不再出现 “cannot start a transaction within a transaction”。
- **7788 静默启停**：计划任务入口改为 `wscript.exe` 启动隐藏 PowerShell，任务不再创建控制台窗口；启动脚本取消 `while($true)` 无限循环，改为单次启动 + 等待退出；任务重启上限从 999 改为 3 次。日志按 10MB 轮转，端口占用会先等待旧监听释放，仍被非 omni 进程占用则拒绝启动。
- **P2**：版本检查增加跨进程单飞锁（15 秒 stale 回收），多个宿主同时读记忆只发一次 GitHub 请求；`daily-sync` 状态文件按 `0600` 原子写入。

### 测试与发布
- 新增 `test/update-signature.test.mjs`：固定公钥指纹、签名/验签、字段篡改、未知字段、错误密钥、版本错配；`test/sign-release.test.mjs` 覆盖发布端清单生成与版本错配拒绝。
- 新增迁移备份/全新库不备份断言；`test/daily-sync-cli.test.mjs` 补“默认不移动 HEAD”和 `--apply` 脏树分支；`test/version-check.test.mjs` 补并发单飞锁与跨进程缓存刷新。
- 完整 `npm test` **401/401** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.6。

## [3.11.5] — 2026-11-23

### 修复 · 读路径版本提醒不再驱动自动更新
- **撤回 3.11.4 的同日自动放行**：`daily-sync` 恢复本地日期 gate，同一天只自动执行一次；任何失败态都不会在当天自动重开。用户确认后要重试，必须显式 `--force`。这消除了“读记忆 → 被要求同步 → `git merge` → 校验失败 `reset --hard` → 再读再擦”的循环。
- **提醒改为只报告**：文本标题从 `## 版本提醒（优先处理）` 改为 `## 版本提醒（需用户确认）`，不再命令 AI 执行；`AGENTS.md` 与用户 skill 同步改为“告诉用户，等用户同意后再运行”。
- **缓存不再能注入上下文**：回读缓存时校验 `ok`、`localVersion`、`remoteVersion` 的 semver 结构、`checkedAtMs`、`source` 白名单；`formatUpdateNotice` 再次校验版本，非法内容直接丢弃。网络失败不再继承旧 `remoteVersion`，改为写 `null`。
- **超时与版本解析**：Contents API 与 raw 回退共享一个 2.5 秒总预算；本地版本改为按需读取并容忍 BOM；版本解析支持 `-rc.1` 与 `+build`，预发布版本不再静默关闭整条功能。
- **服务副作用收敛**：`blocked-dirty`、`blocked-diverged`、`verification-failed` 等 7 条失败分支只探测 `/health`，不再重启 7788；重启只保留在真正更新成功后。`ensureService` 的失败返回值补 `error`，端口占用、任务缺失、版本不符不再都是同一个 `healthy:false`。
- **更新作用域收紧**：`daily-sync` 默认操作脚本自身所在 checkout；执行前校验包名 `@local/omni-memory` 与 `origin` 必须是 `wangzhen110/omni-memory`，拒绝在任意有 `package.json` 的仓库里 fetch/merge。`node --check` 从只查 `index.js` 扩大到 `index.js`、`client.js`、`lib/`、`hosts/`、`scripts/` 的全部运行时 JS。
- **分发补齐**：`files` 加入 `scripts/`、`AGENTS.md`、`package.json`，提醒指向的同步脚本在非 git 分发包里也存在。

### 测试与发布
- 新增 `test/daily-sync-cli.test.mjs`：非本仓库拒绝、坏版本结构化报错、缺 `package.json` 不崩溃。
- `test/daily-sync.test.mjs` 补预发布比较与“同日失败不自动重开 gate”；`test/version-check.test.mjs` 补缓存注入拒绝、失败清空旧远端版本、无效提醒不输出；`test/api.test.mjs` 补 `/packet` 文本提醒。
- 完整 `npm test` **391/391** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.5。

## [3.11.4] — 2026-11-23

### 修复 · 读取提醒不再被“今天已同步”挡住
- 之前 `daily-sync` 在当天已跑过后直接返回 `already-ran-today`，即使读取缓存已经发现云端发布了更高版本，也不会更新。现在当日 gate 会读取 `omni-version-check.json` 的远端版本；只要它比当前本地版本高，就放行这次同步，无需 `--force`。
- 没有更高版本、也没有读取缓存时，仍然保持一天一次，不增加网络请求。
- `test/daily-sync.test.mjs` 的日期 gate 用例补了同日更高版本放行、同日同版本跳过、跨日放行三种断言。

### 测试与发布
- 完整 `npm test` **384/384** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.4。

## [3.11.3] — 2026-11-23

### 新增 · 读取记忆时自动提醒云端新版本
- **读路径检查**：新增 `lib/version-check.mjs`。`memory_context`（MCP/CLI）、`/omni-memory/packet` 在读取时并发检查 GitHub `main/package.json`；发现远端更高，就在返回文本最前面插入 `## 版本提醒（优先处理）`，告诉 AI 先运行 `node scripts/daily-sync.mjs`。
- **不拖慢读取**：检查带缓存（成功 30 分钟、失败 5 分钟），单次网络上限 2.5 秒，超时或 GitHub 不可达只返回“无更新”，不阻塞记忆读取；`OMNI_VERSION_CHECK_DISABLED=1` 可关闭。
- **结构化字段**：`memory_context` 与 `/packet` 的返回对象新增 `update`（无更新为 `null`），调用方可直接读 `localVersion` / `remoteVersion`，不用解析中文文本。
- **边界**：只提醒，不自动改代码；真正更新仍由 `daily-sync` 做 dirty/分叉/校验/重启检查。

### 测试与发布
- 新增 `test/version-check.test.mjs`：无更新不提示、contents API 命中并复用缓存、API 403 回退 raw 且网络失败不抛、`memory_context` 顶部带提醒和 `update.remoteVersion` 4 项。
- HTTP/MCP/boot 测试显式关闭版本检查，避免全量测试访问 GitHub。
- 完整 `npm test` **384/384** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.3。

## [3.11.2] — 2026-11-23

### 新增 · 用户怎么知道云端更新了
- **三个可见面**：`/health` 保留 `version`；`/omni-memory/status` 与 `/omni-memory/overview` 新增 `version`；HTTP 概览顶栏新增 `v3.11.2` 版本角标。打开面板即可看到当前版本，不必再翻日志或目录。
- **发布通道补齐**：GitHub Releases 已补 `v3.11.1`（tag 指向 `3c5c504`），后续版本按 `vX.Y.Z` 建 Release；仓库仍是 `private:true`，不引入 npm 发布通道。
- **每日一次云端对齐**：新增 `lib/daily-sync.mjs`（版本解析/数字段比较/本地日期 gate）与 `scripts/daily-sync.mjs`。每天第一次记忆操作前，脚本读取 GitHub `main/package.json`；远端版本更高且工作树无 tracked 修改时 `git merge --ff-only origin/main`，`node --check index.js` 通过后再重启 `OmniMemory7788` 并探测 `/health`。状态写入 `~/.dsh/omni-daily-sync.json`，同一天后续调用直接返回 `already-ran-today`。
- **同步可靠性**：远端版本优先读 GitHub contents API（推送后立即可见），raw CDN 仅作回退，避免 CDN 缓存把新版本读成旧版本；Windows 用 `%SystemRoot%\System32\schtasks.exe` 绝对路径，避免 PATH 缺 System32 时误报“任务不存在”；重启前只清理命令行含 `cli.mjs ... serve ... 7788` 的孤儿监听进程，避免旧 node 占着端口导致新进程空转。
- **安全边界**：dirty tracked tree、分叉、fetch 失败、语法校验失败都不更新；校验失败自动 `git reset --hard` 回滚到更新前提交；无计划任务时只报告 `service.exists=false`，不擅自创建系统任务。`--check` 只检查不写状态、不更新、不重启；`--force` 强制重跑当天检查；`--no-restart` 只更新代码。

### 测试与发布
- 新增 `test/daily-sync.test.mjs`：版本解析、数字段比较、本地日期 gate 3 项。
- `test/api.test.mjs` 新增 `/status` 与 `/overview` 版本字段断言。
- 完整 `npm test` **380/380** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.2。

## [3.11.1] — 2026-11-22

### 修复 · 3.11.0 复审 P2/P3
- **P2-1 启动空扫描**：新增部分索引 `notes_text_hash_missing(id) WHERE text_hash IS NULL`。稳态打开时缺失探针走空索引，不再全表扫描 `notes`；1M `openStore()` 46.5ms。
- **P2-2 迁移内存峰值**：`ensureNoteTextHash` 改为 `ORDER BY id LIMIT 1000` 分批回填，每批独立事务；1M notes 迁移 73.01s，RSS 增量 58.9MB，NULL 归零，样本哈希正确。
- **P3-1**：`/omni-memory/node` 移除未使用的 `requestedScope`。
- **P3-3**：`bench/release.mjs` 版本从 `package.json` 读取；新增 `openMs` 与 `BENCH_LOAD`，发布文档补负载条件与区间。
- **P3-2 复核**：`/health`、`/rules`、`/`、静态页已有 loopback 403 守卫，`test/http-security.test.mjs` 覆盖 `127.0.0.2`；复审该项为误报，无代码改动。

### 测试与基准
- `test/migration.test.mjs` 覆盖 2500 条多批回填、部分索引查询计划、碰撞区分与重开幂等。
- 新增 `bench/migrate.mjs`：100k/1M v16→v17 存量迁移基准。
- 完整 `npm test` **376/376** 通过；`npm run check` 通过；schema 仍为 v17、版本 3.11.1。

## [3.11.0] — 2026-11-22

### 结构整改 · 3.10.4 复审第 6/7 节
- **HTTP 路由收敛（M-01/M-02/M-07）**：新增 `httpScope()` 统一 scope 解析；所有 21 条路由经统一守卫处理 loopback、方法、CSRF 与 Host/Origin；`registerRoutes` 从 1100 行降到 70 行，按 read/admin/write/persona 拆成四组；`importLineage` 改为语义明确的 `positiveIdOrNull`。
- **工具注册拆分（M-03）**：`defineTools` 从 1336 行降到 18 行，23 个内核工具按 capture / write-read / maintenance / graph 四组注册；工具名、参数 schema 与 execute 行为不变。
- **数据层拆分（M-04/M-05/M-06）**：`mergeSnapshot` 317→41 行，按 notes/facts/chunks/edges/candidates/meta 拆 planner 与 writer，保留单事务、`idMap` 血缘重映射和 edge 失效；`openStore` 205→109 行，抽出 `lib/schema.mjs` 的 `createBaseSchema()` / `createFtsTables()`；新增 `reindexRow()` 统一 FTS + bigram + vector 重建，dream rollback 也恢复完整派生索引。

### 性能与数据
- **`/overview` SQL 聚合（M-08）**：周序列、84 日热力图与窗口基线改由 SQL 分组计数，不再全量 `SELECT ts` 到 JS；100k 临时库与旧实现逐字段一致。
- **`notes.text_hash`（M-09，schema v17）**：新增 `text_hash` 与 `(scope, text_hash)` 索引；`memory_write`、候选写入、导入预筛、restore、amend 先走索引再比对原文。迁移回填 NULL，重开幂等；哈希碰撞不会误判重复。
- **100k/1M 复测（M-10）**：新增 `bench/release.mjs`，隔离临时库 5 次取中位数。100k：写入 **4.4ms**（旧 45.8ms）、`/list` 96.4ms、`/overview` 187.2ms（旧 321ms）、搜索 2.8ms（旧 12ms）。1M：写入 4.4ms、`/list` 966.4ms、`/overview` 2026ms、搜索 2.8ms。1M 面板全库统计超出 300ms 交互预算，检索/写入不受影响；原始值见 `docs/BENCH-3.11.0-2026-11-22.md`。

### 测试与发布
- 新增 v17 迁移测试：旧库回填 `text_hash`、重开幂等、哈希碰撞按原文区分。
- 新增 `/overview` SQL 分桶与旧实现逐字段对照测试。
- 完整 `npm test` **376/376** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v17、3.11.0。
- 不改变 21 条路由路径/响应字段、23 个内核工具/25 个 MCP 工具名称与权限，不改变 scope 语义。

## [3.10.5] — 2026-11-22

### 修复 · 3.10.4 复查 B-1 至 B-4
- **B-1 恢复事实不再制造双 active**：`restoreMemory` 恢复事实前先检查同三元组 active 行；单值关系再检查同 `subject+relation+scope` 的其他 active 值，存在时返回 `{restored:false, reason:'single-valued relation already has an active value', activeId, activeObject}`，要求先遗忘/过期当前值再恢复。多值关系仍允许并存。
- **B-2 persona 不再静默清空**：HTTP body 改为严格解析。空 body、非法 JSON、超限 body 分别返回 400/400/413，绝不进入 `personaSet`；只有非空 `values` 才替换，清空必须显式 `action=clear`。body 上限从 8KB 提到 64KB，覆盖 4000 字符总上限的中文。
- **B-3 长中文可写入**：`/ingest` body 上限提到 64KB，4000 字中文（约 12KB）不再被截断；超限返回 413，不静默丢内容。URL query 仍只适合短文本。
- **B-4 恢复笔记去重**：恢复墓碑笔记前检查同 scope、同文本是否已有 active 笔记；存在时返回 `active duplicate` 与 `activeId`，不再生成两条同文本 active。
- **B-5 复核结论**：`hosts/http/server.mjs` 当前已在 `/health`、`/rules`、`/` 和所有静态 GET 上做 loopback 403；本轮补了 127.0.0.2 非 loopback 回归，确认不是漏洞。报告中的行号描述与当前 3.10.4 代码不一致。

### 清理与边界
- 删除死代码：`dropSemanticIndex`、`PERSONA_DEFAULT_KEYS`、未使用的 `statSync` / `homedir` 导入、只写不读的 `lastClaimAt`、未使用的 `projectActive` / `transcriptProjectActive`、未挂载的 `GraphBoundary`；清理两处 oxlint 可简化的字符类转义与 `...(model ?? {})`。
- **未做结构拆分**：`defineTools` / `registerRoutes` / `mergeSnapshot` 的模块化拆分与 `/overview` 聚合 SQL、`notes.text_hash` 索引属于大重构，本轮不混入 bugfix；留待独立版本并用基准回归。
- **性能**：本轮未重跑 100k；3.10.5 的新增 restore 检查只走已有索引，不改变写入路径。

### 测试与发布
- 新增 `test/review-3.10.4.test.mjs`（6 项）：单值事实恢复冲突、同文本笔记恢复冲突、persona 空/非法/超长 body 不清空、显式 clear、长中文 ingest、超限 413。
- `test/http-security.test.mjs` 新增非 loopback 的 `/health` `/rules` `/` `/index.html` 403 回归。
- 完整 `npm test` **374/374** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v16、3.10.5。

## [3.10.4] — 2026-11-21

### 修复 · 3.10.3 复审 P1/P2
- **面板写操作回到项目层**：`/omni-memory/forget`、`/restore`、`/dream/replace`、`/dream/rollback` 现在读取 `scope`，缺省仍是 `global`，显式项目键时只操作该项目；`scope=all` 才跨层并写审计。`forget` / `restore` / `dream` 的 `kind`、`id`、`scope` 既支持查询参数，也支持 JSON body 兜底（宿主可能已消费请求体）。`client.js` 的遗忘、恢复、dream 回滚与人物设定都改为携带条目真实 `scope` / JSON body。
- **恢复真正可见**：`restoreMemory` 恢复笔记时同时清 `superseded_by`，恢复事实时清 `valid_to`；若同三元组已有 active 行，返回 `{restored:false, reason:'active duplicate', activeId}`，不制造双活。边（edge）恢复时重新置为 active。
- **导入不再信任快照**：`mergeSnapshot` 先做计划阶段校验——`verification` / `solution_status` 只接受白名单，`importance` / `confidence` 等数值必须有限并 clamp 到合法范围；非法数值直接抛 `imported numeric field is not finite`，写库前拒绝，库不变。`superseded_by` 只映射到本次导入的新 id，映射不到就置空，绝不回退源 id。`evidence` 保留原值。
- **实体合并补全方向**：`linkEntity` 同时更新 `facts.subject`、`facts.object`、`edges.src`、`edges.dst`，并按 `COLLATE NOCASE` 匹配旧数据里未归一化的大小写，返回 `affectedObjectFacts` / `affectedDstEdges`。
- **dream 与热路径**：`coverageScore` 的证据 haystack 统一 `toLowerCase()`，避免 `Docker` 与 token `docker` 永远不匹配；schema v16 为 notes/facts/chunks/edges 补 scope+状态+时间复合索引，v16 迁移与 marker 修复路径都幂等创建。
- **HTTP 边界**：`hosts/http/server.mjs` 的 `/health`、`/rules`、`/` 及所有静态 GET 在非 loopback 时返回 403，`0.0.0.0` 绑定不再泄露元数据或页面；`readJsonBody` 改为 `Buffer.concat` 后按字节截断再解码，跨 chunk 的 UTF-8 不再被 `String()` 破坏；`likeClause` 用 `ESCAPE '!'` 转义 `%` / `_` / `!`。
- **日志与迁移清理**：路由注册 debug 日志只在 `OMNI_ROUTE_DEBUG=1` 时写，不再常驻；`migrateScopeAlias` 墓碑重复 chunk 时同步清理 FTS / bigram / vector / semantic 派生行，避免迁移留下幽灵索引。
- **scope 语义写入文档**：项目键定位为同一用户本机数据的命名空间，不是认证边界；精确 `proj:*` 键允许读写，`scope=all` 只读或走显式审计写，HTTP 写必须 loopback + CSRF。R-13 的“键可达是否允许”从此有明确口径。

### 测试与发布
- 新增 `test/review-3.10.3-p1.test.mjs`：HTTP 项目层 forget/restore、恢复后可见性、导入字段清洗与悬空 lineage、`link_entity` object 方向、跨 chunk UTF-8。
- 完整 `npm test` **367/367** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、schema v16、3.10.4。
- **热重载边界**：DSH 更新插件后新实例不会自动接管旧实例的路由，必须重启 DSH；本版不声称热重载可用。
- **性能口径**：本轮未重跑 100k 基准，不沿用 3.10.1 的延迟数字作为 3.10.4 实测。

## [3.10.3] — 2026-11-21

### 修复 · 把冷启动轮询真正纳入发布
- **发布包不再只有一次性 `ctx.inject`**：3.10.2 工作区的 `registerWhenAvailable()` 已包含 250ms 轮询（最多 60s），但此前 Git/GitHub 的发布提交只含 `ctx.inject` 分支；干净安装或从仓库更新后，DSH 冷启动仍可能在 `webServer` 晚到时静默 404。3.10.3 将轮询段纳入版本发布，`not ready at apply` 后会继续等待并注册路由。
- **冷启动可观测**：注册成功/失败继续写 `%TEMP%\omni-route-debug.log`，并通过 `/omni-memory/status` 的 `routes.status/count/at/error` 与 `lastInjection.routes` 暴露；真实 DSH 冷启动实测 `not ready at apply → inject fired → registered after 277ms`，路由数 21。
- **DSH Desktop 端口不要写死**：`dsh-desktop-host` 固定以 `--host 127.0.0.1 --port 0` 启动 Web 应用，端口由操作系统每次随机分配；`9230` 是 inspector ingest，`59273` 是上一进程的旧 GUI 端口，均不是插件 `/omni-memory/*` 的验收入口。固定可见入口用独立 `http://127.0.0.1:7788/` 仪表盘，或 DSH 客户端侧栏（内部相对请求，不依赖端口）。

### 测试与发布
- 测试基线保持 **362/362**；`npm run check` 为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、3.10.3。
- 真实库项目键修复保持生效：`proj:全息记忆#767039` 的 10 条转录已并入 `proj:全息记忆#604dba`，旧键 0 行，`scope_alias_repair_version='1'`。

## [3.10.2] — 2026-11-21

### 修复 · DSH 冷启动与项目键分裂
- **路由和画像不再依赖“启动瞬间恰好就绪”的服务**：`apply()` 改为通过 `ctx.inject([...])` 等待 `webServer` / `systemPrompt` 就绪；没有 `inject` 的轻量宿主仍回退到一次立即注册。`registerRoutes()` 兼容传入 context 或 webServer 服务，回调参数为 prompt 服务时也能正确取到 `.section`。`/omni-memory/status` 新增 `routes.pending/registered/disposed`、`routes.count`、`aliasRepair`、`aliasMigration`，画像注入失败不再完全静默。
- **项目键只认 canonical**：新增 `resolveProjectKey()`，所有读取/写入入口（转录 scope、候选、agent、session、`/packet`、自动召回）统一先走 `scope_aliases`；旧键写操作不再继续制造分裂行。
- **迁移按字面旧键执行**：`migrateScopeAlias()` 新增 `literal` 选项，CLI `scope-alias --apply` 和启动自愈都不会把旧键先解析成 canonical 后误判为 “source=target”。
- **启动自愈**：`repairScopeAliases()` 在 `openStore()` 取得维护租约后扫描 `scope_aliases`，有旧键行的按字面迁移；成功写 `scope_alias_repair_version='1'`，失败写 `scope_alias_repair_last_error` / `scope_alias_repair_failed_at` 供下次重试，并通过 `/status` 暴露。
- **真实库数据修复**：真实库备份到 `C:\Users\64627\.dsh\memory\backup-3.10.2-pre-repair-20261121-222309` 后，启动自愈把 `proj:全息记忆#767039` 的 10 条转录合并进 canonical `proj:全息记忆#604dba`；修复后旧键 0 行、canonical 17 条、`repairMarker=1`，alias 保留。

### 测试与发布
- 新增 `test/cold-start.test.mjs`（服务晚到 + 到达顺序无关）、`test/project-key-resolution.test.mjs`（字面迁移、session/HTTP canonical、no-op）、`test/project-key-repair.test.mjs`（启动自愈幂等）；测试基线 362 用例。
- `npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、3.10.2。

## [3.10.1] — 2026-11-21

### 修复 · 深度审计 P0（安全与数据一致性）
- **导出/导入不再是任意文件读写**：`memory_export` / `memory_import` 只接受 `memory/backups/` 内的单个 `.json` 文件名；拒绝绝对路径、盘符、UNC、`..`、子目录和符号链接；导出拒绝覆盖已有文件，写入临时文件后 `rename`；导入限制 64MB、只返回固定错误，不回显输入前缀。备份目录可用 `OMNI_BACKUP_DIR` 改到受控位置。
- **同源校验不再用 Host 自证**：`Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`、配置的绑定地址或 `OMNI_TRUSTED_HOSTS`；`Origin` 必须与之同主机同端口；`Sec-Fetch-Site: cross-site` 直接拒绝。`hosts/http/server.mjs` 的 `POST /mcp` 使用同一套规则，DNS 重绑定页不能只靠自洽的 Host/Origin 通过。
- **按 id 的写操作回到项目边界**：`memory_forget` / `memory_restore` / `memory_dream_replace` / `memory_dream_rollback` / `memory_solution_report` / `memory_amend` / `memory_feedback` 统一按调用方当前项目 + global 过滤；项目上下文不能改另一个项目。`scope=all` 只在 amend/feedback 显式请求时放行，并写入 `meta.audit:cross-scope` 审计环（保留最近 100 条）。
- **导入复用事实失效规则**：`mergeSnapshot` 按 `valid_from` 排序；单值关系导入前关闭同 `(subject, relation, scope)` 的旧 active 行与对应 edge；若本地已有更新的事实，则导入值落为历史值，保证同一键最多一条 `valid_to IS NULL`。
- **dream 证据按轮次匹配**：`dreamEvidence` 优先精确匹配 `session:<id>#<seq>`，旧式 session source 按 `ts` 倒序取最近 300 条，再按文本覆盖率选最佳证据；同一 session 的多轮 transcript 不再让正确笔记被第一行误判为 `contradicted`。
- **CI / 测试隔离**：`.github/workflows/ci.yml` 增加 `npm ci`、`fetch-depth: 0`、Node 22.13/24 × Ubuntu/Windows 矩阵；`test/helpers.mjs` 同时固定 `OMNI_HOME` 和 `DSH_HOME`，清除继承的 `OMNI_BACKUP_DIR` / `OMNI_TRUSTED_HOSTS`，避免测试写入真实库。

### 测试与发布
- 新增 `test/security-p0.test.mjs`（路径越界、覆盖保护、项目越权、事实失效、dream 轮次、OMNI_HOME 隔离）与伪造 Host 的 HTTP 回归；备份测试改为只传 basename，跨库导入走显式文件复制。
- 测试基线 356 用例；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、3.10.1。

## [3.10.0] — 2026-11-21

### 新增 · 记忆概览仪表盘（真实数据）
- **`GET /omni-memory/overview`**：新增只读聚合端点，默认监听 loopback，非 loopback 返回 403；参数 `range=4w/6w/12w/26w`、`scope=all/global/project/项目键`。返回 `stats`、`health`、`series`、`daily`、`projects`、`profile`、`activity`、`graph`，不返回正文，不把 1,000+ 条笔记一次塞进页面。
- **真实口径**：活跃笔记只算未删除且未被 `superseded_by` 替代；活跃事实只算未删除且 `valid_to IS NULL`；有争议 = notes + facts 的 `contested` 之和；已失效 = 被替代笔记 + 过期事实；`recall_count=0` 时 `usefulRate=null`，页面显示「暂无反馈」，不伪造 82%。`persona` 表为空时只展示可回原文的偏好信号，不生成推断画像。**增长柱、累积曲线、84 天日历只统计 notes + facts；chunks 只作为会话存储量展示，避免 28 条笔记被 889 个会话块放大成 923 条新增。**
- **默认入口改版**：`hosts/http/web/index.html` 从旧列表面板改为「记忆概览」：一句话结论、5 个 KPI、记忆增长双轴图（周柱 + 累积曲线，4/6/12 周可切）、健康环、项目分布（全局单列 + 项目层内归一）、84 天活跃日历、项目活跃带、事实关系迷你图、画像/信号和最近动态；`/panel.html` 保留旧列表 / 搜索 / 星图 / 规则面板。
- **图表边界**：项目活跃带只画项目首次 / 最近写入区间，并明确标注「不是任务甘特」；当前 schema 无 tasks / start_at / due_at / status / depends_on，不伪造甘特。项目分布含全局层，否则 1,000+ 条全局记忆会看起来缺一大块；`global` 与 `proj:*`（含旧 `project` scope）分别统计。项目记忆量只算 notes + facts，只有 chunks 的项目标「仅转写」，不进入活跃项目数。
- **前端依赖**：`dashboard.css` / `dashboard.js` 单页内联资源，无外部 CDN；`index.html` 默认 `/`，`panel.html` 旧面板，`star-map.html` 星图不变。移动端已验证无横向溢出；范围切换、层级过滤无未捕获异常。

### 测试与发布
- 路由由 20 条增至 21 条；`test/api.test.mjs` 与 `test/http.test.mjs` 同步为 21，并新增 overview 聚合用例（notes / facts / series / daily / projects / profile / signals / activity）。
- 测试基线 349 用例；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、21 路由、31 ADR、3.10.0。
- 数据探察结论：旧库 `proj:全息记忆#30534c` + `proj:专业知识#967a81` + global；facts 少、chunks 0、persona 空、召回反馈 0，仪表盘必须显示「暂无反馈 / 偏好信号」而不是示例数字。新 Windows 库实测 28 notes / 6 facts / 889 chunks / 3 scopes，暴露并修复 chunks 混入增长的问题；真实库备份不受影响。

## [3.9.5] — 2026-11-21

### 修复 · 语义可靠性收尾（复核 P2/P3）
- **冷却期漏调度**：`runSemanticWorker` 在 `retryAt` 未来时早退，调度条件补上 `|| !state.backfillDone`；冷却结束后即使 `pending` 为空，也会继续未完成的回填。
- **派生 GC 原子化**：`pruneSemanticVectors` 改为单个事务，失败不再逐条吞掉，写入 `semantic_gc_last_error` / `semantic_gc_failed_at` 并通过 `semantic.gcError` / `gcFailedAt` 暴露；`dropDerivedIndexes` 只在表确实存在时删除，已有表上的删除失败会让事务回滚。
- **替代路径清全索引**：`memory_amend`、dream replace、consolidate、rollback 从“只清 semantic_vectors”改为清理 FTS / bigram / hashed/remote `vectors` / `semantic_vectors`，避免被替代笔记的派生索引长期累积。
- **远程向量队列可观测**：`enqueueVector` 队列满时记录 `dropped` / `lastDropAt`，`/omni-memory/status` 的 `embedding` 暴露，不再无声丢弃。
- **手工 scope 迁移**：新增 `omni scope-alias --from <旧键> --to <新键> --apply` 与 `--list`；没有 `project_path` 证据的历史旧键可以在确认归属后显式迁移，默认只预览，不自动猜测。

### 测试与发布
- 新增 `test/derived-gc.test.mjs`：amend 后旧 note 的 FTS / bigram / vector 清零。
- 新增 `test/property.test.mjs`（devDependency `fast-check`，仅测试期）：4 条不变量属性测试，各 60 组随机输入——写入→problemKey 精确召回往返、项目 scope 不跨项目泄漏、墓碑后不可召回、任意文本安全存储与越界参数拒绝。经变异测试验证：临时禁用 `scopeClause` 隔离时恰好只有隔离属性失败，证明属性确实锁定对应不变量。
- 新增 `test/property-reliability.test.mjs`：3 条针对 3.9.5 可靠性修复的属性测试（各 50 组随机输入）——amend 后旧笔记派生索引全清、墓碑跨重开不复活、任意写/改/删序列后库完整且计数自洽。变异测试验证：跳过 amend 的派生清理时恰好只有对应属性失败。
- 深度测试阶段（audit-tooling 落地·第二轮）：新增 `test/fuzz-inputs.test.mjs`（4 条：MCP JSON-RPC 任意值、tools/call 恶意名、拆句输出契约、候选抽取边界）、`test/property-ranking.test.mjs`（5 条：status 排序、exact 硬优先、feedback 单调、状态过滤、排序稳定性）、`test/property-concurrency.test.mjs`（4 条：同 key 并发写不丢、并发反馈无丢失更新、跨 scope 隔离、混合并发库完整）、`test/property-scope-alias.test.mjs`（4 条：跨平台大小写归一、legacy 键关系、迁移幂等无损、循环别名终止）。fuzz 用 fast-check 任意值生成，未引入 jazzer.js（native 插桩对零依赖项目侵入过大）。三组变异测试（去拆句去重、反转 exact 优先级、去大小写归一）各自精确命中对应属性，其中“去拆句去重”首轮未被捕获，补入必然重复的输入后锁定——印证变异测试的价值。
- 第四/五轮补测：新增 `fault-injection`、`semantic-reliability-regression`、`http-security`、`install-smoke`、`perf-budget`、`backup-edge`、`http-lifecycle`、`vector-queue-saturation`，并给 `rerank` / `embed-provider` 补故障用例；覆盖索引缺失、GC 错误可见、冷却期回填、路径穿越/CSRF、安装冒烟、10k/100k p95、坏快照事务回滚、端口冲突与向量队列饱和。测试 313 → 348。
- 完整 `npm test` **348/348** 通过；`npm run check` 同步为 23 个内核工具、25 个 MCP 工具、20 路由、31 ADR、3.9.5。

## [3.9.4] — 2026-11-21

### 修复 · 跨平台项目键与旧 scope 迁移（复核 P1）
- **大小写归一**：`projectKeyFromCwd(cwd, platform)` 在 Windows/macOS 生成哈希前将规范化路径转小写，Linux 保留大小写；同一工作区 `D:\Repo` / `d:\repo` 不再分裂成两个项目层。
- **旧键迁移**：schema v15 新增 `scope_aliases(alias, canonical, created_at)`；`legacyProjectKeyFromCwd` 保留旧算法，`ensureProjectAlias` 在 `openStore(process.cwd())`、`attachSession`、`scopeForSession` 把当前路径可推导的旧键迁移到 canonical 键，并同步 `agent_project:*` 与 `project_path:<scope>`。
- **迁移安全**：只迁移能由完整路径确定的旧键，不按 basename 猜测；`chunks` 的 `(hash, scope)` 活跃唯一索引冲突时，目标行保留，源行 tombstone，不硬删、不覆盖；迁移幂等并由 `scope_aliases` 留痕。
- **真实库副本验证**：`proj:全息记忆#deff23` → `proj:全息记忆#30534c`，40 条 notes、12 条 facts、12 条 edges 保留；`--scope project` 重新命中，重开无重复迁移。

### 修复 · P3 收尾
- **资产完整性**：`scripts/check-semantic-assets.mjs` 对 11 个模型/WASM/许可证文件同时校验字节数与 SHA-256，防止同长度替换。
- **体积口径**：检查输出改用 `MiB`（11 files, 37.5 MiB），发布文档标注 MB/MiB 口径。
- **署名**：`ATTRIBUTION.md` 补充 `Xenova/bge-small-zh-v1.5` ONNX 导出来源。
- **scope NULL 口径**：明确 `notes` 的 `scope` NOT NULL 不包含 NULL；`facts`/`chunks`/`edges` 的 legacy NULL 继续按 global 可见，仅用于兼容旧库，不改变现有查询。
- **reindex 计数**：`memory_reindex` 的顶层 `processed` 明确定义为当前向量后端的行数，语义回填数量始终在 `semantic.processed` 子对象中；不把两种计数混成一个数字。
- **文档计数**：按真实 MCP `tools/list` 修正为 25 个工具（23 个内核 + 2 个适配器），同步修正 HTTP 适配器 README 的 20 条路由与 Node 版本声明；`check-docs` 增加 MCP 工具数与适配器路由数门禁，防止再次漂移。

### 测试与发布
- 新增 `test/scope-alias.test.mjs`：Windows/macOS 同键、Linux 保持大小写、旧 scope 迁移与重开幂等、chunk 冲突 tombstone。
- 完整 `npm test` **288/288** 通过；`npm run check` 同步为 23 工具、20 路由、31 ADR、schema v15、3.9.4；`semantic assets OK: 11 files, 37.5 MiB`。

## [3.9.3] — 2026-11-21

### 修复 · 语义索引生命周期（复核 RECHECK-3.9.2）
- **陈旧向量**：`flushSemanticPending` 的待处理项增加版本号；amend / replace 在推理飞行中覆盖同一 key 时，旧快照不再写入或删除新条目，避免“旧文本向量永久保留、新文本永不入索引”。
- **派生 GC**：`memory_forget`、`memory_compact` 与 `memory_amend` / dream replace / consolidate / rollback 同步清理 `semantic_vectors`；启动时按 schema 版本执行一次孤儿向量清扫。删除/替代后的向量不再占磁盘。
- **队列可观测**：语义队列满时不再静默丢弃；`semantic.dropped`、`lastDropAt` 进入 `memory_status` 与 `/omni-memory/status`。
- **失败退避**：语义写入/查询失败按 1s→30s 指数退避，状态暴露 `failureCount` 与 `retryAt`；冷却期内搜索直接走词面/hashed/图，不再反复加载损坏模型。
- **回填租约**：TTL 从 600s 缩短为 120s，并在每批 worker 处理前续租；崩溃后最多 2 分钟即可被其他宿主接管，长回填不会被误抢。
- **强制重算**：`memory_reindex({semantic:true, semanticForce:true})` 会先清当前签名再按源文本重建，修复历史陈旧向量；`semantic` 状态新增 `forced` 结果字段。
- **清理**：`dispose` 释放 worker timer 与 exit listener；`semantic_vectors` 启动清扫使用 `semantic_gc_version` 标记，避免每次启动重复全表删除。
- **测试**：新增“遗忘/修订清理陈旧向量”和“首次 flush 期间 amend 不被旧快照吞掉”用例；完整 `npm test` **285/285** 通过；`npm run check` 同步为 23 工具、20 路由、30 ADR、schema v14、3.9.3。

## [3.9.2] — 2026-11-21

### 新增 · 默认零配置真语义检索
- **模型随包**：新增 `lib/semantic-embed.mjs`，使用 `BAAI/bge-small-zh-v1.5` int8 ONNX（MIT）+ `onnxruntime-web` WASM + HuggingFace tokenizers WASM，进程内 CPU 推理。用户不需要安装 Ollama / LM Studio、不需要拉模型、不需要 API key；默认离线。包体增加约 39MB，其中模型权重 23.9MB、WASM 运行时 14.8MB。
- **schema v14**：新增 `semantic_vectors(kind, owner_id, model, dim, vec)` 与 `semantic_vectors_model` 索引；`model` 存签名 `local:bge-small-zh-v1.5:int8:512`，与旧 hashed `vectors` 完全隔离，老库可边服务边回填。
- **四路融合**：检索从词面 / hashed 或远程向量 / 图三路，扩展为词面 / hashed 或远程向量 / 本地语义 / 图四路 RRF；权重为词面 1、hashed/远程 1、本地语义 2、图 0.5（等权时全量 MRR 只有 0.938，加权后 0.979）。`memory_search` 命中新增 `semanticScore`，`via` 可为 `semantic`。
- **后台回填**：新写入进入内存队列，后台 worker 每批 8 条写入；检索前先冲刷一小批待处理项，保证同轮写入后立刻可召回；旧库首次打开先检查是否缺向量，有才启动回填；回填持有 `semantic-backfill` 跨进程租约，进程退出即释放，已索引库启动时不加载模型。`memory_reindex({semantic:true})` 可强制回填。
- **状态可见**：`memory_status` 与 `/omni-memory/status` 新增 `semantic` 块（`enabled/model/dim/pending/indexed/running/backfillDone/lastError`）。
- **质量实测**：黄金集 20 条语料 / 24 个问题，本地语义单独 recall 1.000、MRR 0.979；旧 hashed 混合 MRR 0.927，纯词面 0.776。冷加载 208ms，RSS 216MB，20 次查询 191ms（约 9.5ms/query）。语义阈值取 0.25；真改写对 0.479–0.621，不相关中文约 0.217。
- **发布闸门**：`scripts/check-semantic-assets.mjs` 校验模型、tokenizer、WASM 与许可证文件的存在与字节数，缺文件或截断会让 `npm run check` 失败；`models` 加入 `package.json` 的 `files`；`engines` 改为 `>=22.13`（本机 Node 22.23.2 实测）。
- **测试**：默认测试进程设置 `OMNI_DISABLE_SEMANTIC=1`，只有显式 `boot({ semantic: true })` 才加载 216MB 模型；新增本地语义改写召回用例。完整 `npm test` **283/283** 通过；`npm run check` 同步为 23 工具、20 路由、29 ADR、schema v14、3.9.2。
- **降级**：模型缺失、WASM 加载失败、内存不足或推理异常时语义路线返回空并写 `lastError`，词面 / hashed / 图路线继续工作；`OMNI_DISABLE_SEMANTIC=1` 单独关闭，`OMNI_DISABLE_VECTOR=1` 同时关闭 hashed/远程与本地语义（诊断用）。

## [3.9.1] — 2026-11-21

### 修复 · 复核发现的边界问题
- **英文自动捕获（B1）**：`lib/capture-rules.mjs` 改用 `Intl.Segmenter` 分句，英文句点、缩写和中文标点都能正确拆分；长英文转录不再被当成单条 >400 字符整段丢弃。
- **备份候选幂等（B2）**：`memory_import` 的候选去重改为按 `hash + scope` 查任意状态，旧 pending 快照不会把本地已接受/已拒绝的候选重新灌回队列。
- **scope 大小写（B3）**：`all` / `project` / `global` 在写入、ingest、候选、巩固、搜索、列表等入口统一大小写归一化；`ALL`、`All` 不再能绕过 `scope=all` 拒写。
- **rerank 分数（M-2）**：原融合分与 rerank 分先各自归一化到 0..1，再按 25/75 混合；exact `problemKey` 命中改为硬优先排序，不再被高分弱命中反超。负 logits 不再被 `score > 0` 误判为无信号；只对 top-20 候选调用重排，成本有上限。
- **隐私告知（M-1）**：README、DESIGN NFR-08、THREAT-MODEL 明确说明 `OMNI_RERANK_*` 会外发 query 与候选正文，敏感数据建议自建端点。
- **候选审核原子性**：`reviewNoteCandidate` 的 accept/reject 现在包在单个 `BEGIN IMMEDIATE` 事务内；事务内重新读取 pending 状态，写 note 与更新候选状态同进同退，不再出现“note 已写、候选仍 pending/未更新”的半状态。
- **候选字段保真（F1）**：accept 落 note 时保留候选原始 `ts`，并用 `confidence` 映射 `importance`，不再硬编码 0.55 / now()。
- **满结果去重（低）**：`finalizeHits` 不再在达到 limit 时提前退出，排位靠后的 note/fact 仍可替换同文本 chunk，替换后按分数重排。
- **画像边界（低）**：`capProfileLines` 清理尾部空标题；`addSection` 只有标题加首条内容能放下时才写标题，避免空的 `## 当前项目`。
- 测试：新增英文拆句 1、scope 大小写 1、rerank 负分 1、exact 保护 1；完整 `npm test` **280/280** 通过；`npm run check` 文档计数同步为 23 工具、20 路由、schema v13、3.9.1。

## [3.9.0] — 2026-11-21

### 新增 · 自动捕获、经验巩固与检索重排
- **会话自动捕获闭环（P0）**：schema v13 新增 `note_candidates`；`memory_ingest` 把任意宿主的 user/assistant 轮次写入转录，并按确定性规则抽取最多 3 条 pending 候选（不调用模型、不直接写正式笔记）。`memory_candidate` 提供 list/accept/reject，接受后才落为 note，拒绝保留 `reason`。`scope=all` 拒写，单条上限 4000 字，默认候选范围当前项目 + global。新增 3 条 loopback HTTP 路由与 `omni ingest/candidates/candidate` CLI；`omni ingest --stdin` 可直接解析 Claude Code hook JSON。
- **经验巩固（P1）**：`memory_consolidate` 按同一 `problemKey` 与精确 scope 合并活跃笔记。默认 dry-run；`apply` 生成 `source: consolidate:<ids>` 摘要，按 `[已验证]/[未验证]/[失败尝试]/[已过期]` 分组，汇总来源反馈计数，旧行只写 `superseded_by`，不删除。新增 `/omni-memory/consolidate` 与 `omni consolidate`。
- **分层画像（P1）**：注入画像与 `memory_profile` 统一为 `## 全局` → `## 当前项目`（跨项目视图为 `## 其他项目`）→ `相关事实：`，不再把全局规则和项目规则混成无边界列表；仍受 1200 字预算与 `capProfileLines` 兜底。
- **可选 cross-encoder rerank（P1）**：新增 `lib/rerank-provider.mjs`，支持 Cohere / Jina / SiliconFlow / 自建兼容端点；`OMNI_RERANK_*` 配置后对融合结果重排，未配置时零额外延迟，失败时静默回落。`memory_search` 增加 `rerank` 开关。
- **本地语义嵌入入口**：`OMNI_EMBED_PROVIDER` 新增 `ollama`、`lmstudio` 预设，仍不内置模型；默认 hashed 向量保持零配置可运行。
- **核心拆分**：候选抽取规则移入 `lib/capture-rules.mjs`，新增 `test/capture-rules.test.mjs`；重排提供方独立为 `lib/rerank-provider.mjs`。
- **备份完整性**：`memory_export` 快照新增 `candidates`（默认含全部待审/已审候选，`activeOnly` 只导 pending）；`memory_import` 按 `hash + scope` 只恢复 pending 候选，避免把已接受/已拒绝的审计行重新灌回队列。
- **检索去重优先级**：同一段文本同时命中转录 chunk 与已接受 note 时，最终结果优先保留 note/fact，不再让原始 chunk 把结论遮住；补回归断言。
- 测试：新增 ingest 7 项、consolidation 4 项、rerank 3 项、capture rules 4 项、候选备份 1 项；完整 `npm test` **276/276** 通过；`npm run check` 文档计数同步为 23 工具、20 路由、schema v13、3.9.0。

## [3.8.0] — 2026-11-21

### 变更 · 项目更名与跨宿主定位
- GitHub 仓库由 `wangzhen110/dsh-omni-memory` 更名为 `wangzhen110/omni-memory`；包名由 `@local/dsh-memory` 改为 `@local/omni-memory`。
- 定位从「DSH 长期记忆插件」改为「任意 AI 宿主的长期记忆库」：DSH 仍是原生插件入口，MCP / HTTP / OpenAPI / CLI 是第一等接入方式，不再把 DSH 写进项目名。
- 数据目录、`omni.db` 文件名、`/omni-memory/*` 路由、工具名与协议面全部不变；已有记忆无需迁移。
- DSH 旧安装需要移除 `@local/dsh-memory` 后安装 `@local/omni-memory`，两者不要同时启用；共用同一份数据库。

## [3.7.2] — 2026-11-21

### 新增 · 宿主适配层
- **`GET /omni-memory/packet`**：无 MCP 宿主的预检索出口。返回画像、用户设定与当前任务相关记忆的可注入文本；支持 `scope` / `cwd` / `budget` / `limit`，`format=text` 可直接粘贴到对话开头。
- **`GET /omni-memory/openapi.json`**：导出 OpenAPI 3.0 描述，供只支持 OpenAPI / function calling 的客户端接入。
- **`POST /omni-memory/tool`**：受限 HTTP 工具桥，暴露 `memory_write`、`memory_search`、`memory_solution_report`、`memory_feedback`、`memory_get`、`memory_amend`、`memory_profile`、`memory_timeline`；导出、导入、dream、compact、reindex 等维护操作仍留在 MCP/CLI。写操作要求 `x-omni-csrf: 1`。
- **文档**：新增 [`docs/HOST-ADAPTERS.md`](HOST-ADAPTERS.md)，明确 DSH 原生 / MCP / OpenAPI / 闭源聊天端四类宿主的接入路径与安全边界。
- 测试：新增 `test/host-adapter.test.mjs` 4 项（packet 画像与召回、项目隔离与文本模式、OpenAPI、tool 桥），完整 `npm test` 257/257 通过。

## [3.7.1] — 2026-11-21

### 修复 · 3.7.0 复核报告（N-1 / N-2 / N-3）
- **N-1 `memory_amend` 字段保真**：修订时透传 `contested`、`verification`、`verified_at`、`recall_count`、`last_recall_at`、`useful_count`、`misleading_count`；`source` 保留原出处，`reason` 以 `[amend]` 追加进 `evidence`，不再覆盖原始来源。修订不会清零已验证状态或质量信号。
- **N-2 跨项目越权**：`memory_feedback` 与 `memory_amend` 接收 `toolContext`，默认按当前项目 + global 过滤；跨项目操作必须显式 `scope='all'`。与 `memory_get` 的隔离语义对齐，补跨项目拒绝回归用例。
- **N-3 命名纠正**：对外字段由误导性的 `recallCount` / `lastRecallAt` 改为 `feedbackCount` / `lastFeedbackAt`；物理列名保留以兼容 schema v12，不再声称“每次召回都计数”。
- 测试：新增 2 项回归（字段保真、跨项目拒绝），完整 `npm test` 253/253 通过。

## [3.7.0] — 2026-11-21

### 新增 · 与竞品对齐的记忆质量闭环
- **召回质量反馈**：`notes`/`facts` 增加 `recall_count`、`last_recall_at`、`useful_count`、`misleading_count`（schema v12）。新增 `memory_feedback`，搜索命中返回反馈计数与 `quality`，排序使用 Bayesian 平滑后的 `feedbackBoost`——错误召回会被后续投票压下去，不再反复污染上下文。
- **渐进披露**：新增 `memory_get`，用 `{kind,id}` 一次展开最多 20 条完整记录，默认当前项目 + global，跨全部项目需显式 `scope=all`；补齐 `memory_search` 只给 400 字片段后的读取断点。
- **笔记修订链**：新增 `memory_amend`，修订生成新 revision，旧行 `superseded_by` 指向新行并保留；搜索只返回新行，旧行留给审计与回滚。
- **检索质量门禁**：`bench/golden.mjs` 从“只打印”改为断言 `recall ≥ 0.85`、`MRR ≥ 0.9`，CI 增加 `bench:golden`；同时移除 note/fact 文本分的 0.6/0.7 地板，让 `Math.max(textScore, matchRatio)` 真正参与排序。默认后端实测 MRR 0.927、recall 1.0。
- **导入导出**：`memory_import` 的 notes/facts 合并保留四列反馈计数；`memory_export` 的 `SELECT *` 快照自然包含。
- 测试：新增 `test/quality-loop.test.mjs` 5 项；完整 `npm test` 251/251 通过。

## [3.6.1] — 2026-11-18

### 修复 · 按用户层面功能测试报告（14 项）
- **安全**：`POST /mcp` 补同源与 CSRF 防护。跨站 `Origin` 直接 403；无 `Origin` 时必须是 `application/json` 或带 `x-omni-csrf: 1`，跨站表单的 `text/plain` 被挡。REST 行为不变。
- **去重**：笔记写入先 `trim()` 再查重（与 chunks 对齐），前后空格/尾随换行不再产生重复条目。
- **权重**：`memory_write` 的 `importance` 默认从 0.5 降到 0.35；非数字或越界（<0、>1）直接报错，不再把 `5`/`-1` 写进库。
- **persona**：提炼时过滤标题残片——含 Markdown 标记、`——`、多个分句或章节引用开头的值不再进入「偏好」。
- **参数校验**：`memory_search` 的 `limit` 非数字/越界报错；`contradicts` 中无法解析的 id 通过 `contradictsIgnored` 显式返回；新项目层写入返回 `scopeNew:true` 提示。
- **长度**：笔记超过 4000 字拒绝入库并提示拆分；画像最终字符串按 1200 字硬截断（标题与换行计入预算）。
- **一致性**：`memory_forget` 失败时返回 `forgotten:false` + `reason`，与 `memory_restore` 同形；`memory_compact` / `memory_dream` 的描述注明纯 MCP 宿主下的空操作语义。
- **schema**：`memory_write` 不再要求所有 kind 都带 `text`（fact 可只给三元组），服务端仍按 kind 校验。
- 版本号统一为 3.6.1。

### 安全与可靠性 · 2026-11-20 审计 P0/P1 加固
- **P0 `/mcp`**：在原有来源校验前先做 socket 回环校验；`omni serve --bind 0.0.0.0` 不再把全工具面暴露给远端。
- **P0 规则文件**：托管区块标记不成对或出现多块时直接拒绝改写；CLI 跳过并保留用户原文，不再吞掉孤立 `start` 后的正文。
- **P1 有争议事实**：`memory_profile` 与 persona 证据只读取 `contested = 0`，避免未决结论污染画像。
- **P1 启动租约**：`migrate()`、FTS/向量回填、远端状态恢复全部在维护租约内执行；租约不可得时拒绝读取未迁移库。
- **P1 租约释放**：租约写入持有者 token，释放时按 token 条件删除，过期持有者不会误删新持有者的租约。
- **P1 MCP 协议**：`id: null` 按合法请求处理；通知（无 `id`）对 initialize/list/ping/资源读取等一律不回帧；内部异常也只在存在 `id` 时回复。
- 新增回归用例：孤立标记、`id:null`/通知、contested 事实、6 进程并发租约。测试 246 / 246。

### 稳定性 · 2026-11-21 二次评审复核
- **并发首次打开竞态**：`PRAGMA busy_timeout` 提前到 `journal_mode = WAL` 之前；多进程同时首次打开不再偶发 `database is locked`。
- **Windows 测试清理**：并发测试改用带条件重试的临时目录清理；`EBUSY` 不再把功能测试误判为失败。
- **project 伪层级回归**：新增 `/search?scope=project` 与 `/node?scope=project` 用例，锁定「跨全部项目层、排除 global」的语义。
- 连续 20 次并发用例、3 次完整测试均通过；测试 246 / 246。

### 版本
- 3.6.0 → 3.6.1；测试 246 / 246。

## [3.6.0] — 2026-11-18

### 改进 · 面板星图移植客户端 MemoryGraph
- 面板星图不再另写简化版，直接移植 `client.js` 里已有的 `MemoryGraph`：四旋臂螺旋、`yaw/pitch` 三维旋转 + 透视投影、深度衰减、三层辉光、虚线 mentions/实线事实箭头。
- 背景星尘 12000 颗（暖芯冷边、闪烁、深度亮度），叠加两层星云与暖色核心辉光；俯角默认 `-0.55`，旋臂全貌可见。
- 交互与 DSH 客户端一致：拖拽旋转（`yaw += dx*0.006`，`pitch` 限 ±1.3）、惯性衰减、闲置 2.5s 后自转、滚轮 0.45–2.8 缩放、16px 拾取、hover 提示、点击节点查详情。
- 保留自适应降质（帧耗时 > 34ms 时按 stride 抽稀背景星）与窗口隐藏暂停。

### 版本
- 3.5.1 → 3.6.0；测试 242 / 242。

## [3.5.1] — 2026-11-18

### 修复 · 独立面板星图
- 默认视图由 `scope=global` 改为 `all`：记忆几乎都在项目层时，全局视图只剩一圈无连线的散点。
- 布局改为螺旋银河：半径与权重决定旋臂位置，`spin` 随半径变化，另加 1500 颗星尘与脉动核心；参数沿用 three.js "Galaxy Generator" 的公开做法（branches / spin / randomness），零依赖用 Canvas 2D 实现。
- 恢复持续旋转：`requestAnimationFrame` 循环，切走页签或窗口隐藏时停止，回来再启动。
- 交互修复：拖拽平移、滚轮以光标为中心缩放、悬停高亮、点击节点选中并查询详情；指针事件不再依赖画布预先有尺寸。
- 背景星点改用独立随机：原先复用节点 id 的 FNV 哈希，`star#N` 相邻编号相关，背景被画成一条斜线。
- 支持 `?tab=map` 深链直接打开星图。

### 版本
- 3.5.0 → 3.5.1；测试 242 / 242。

## [3.5.0] — 2026-11-18

### 新增 · 多进程并发：多个 AI 客户端共用一份记忆
- `PRAGMA busy_timeout`（默认 5000ms，`OMNI_BUSY_TIMEOUT_MS` 可调，上限 60s）：写锁被占时等待而不是立刻 `SQLITE_BUSY`。
- `PRAGMA journal_size_limit = 16MB`：多读者场景下给 WAL 设上限。
- 去重检查全部搬进 `BEGIN IMMEDIATE` 事务：笔记按 `(scope, text)`、转录按 `(hash, scope)`、事实按 `(subject, relation, scope)` 在写锁内复查，输的一方返回 `deduped: true`，不再各插一条。
- `meta` 租约：`lease:open-maintenance`（迁移 + 索引回填）、`lease:dream`（定时校验）由全机一个进程持有，其余进程跳过而不是重复全量扫描。
- 新增 `test/concurrency.test.mjs` + `test/fixtures/concurrency-worker.mjs`：6 个真实进程同时写一个临时库，24 条不同文本全部落库，3 个进程写同一段文字只留 1 条。

### 文档
- 新增 ADR-028（多进程并发）；DESIGN 增加 NFR-12，NFR-10 更新为 242/242。
- REFERENCE 增补并发章节与 `OMNI_BUSY_TIMEOUT_MS`。

### 已知边界
- 写仍是串行（SQLite 单写者），几十进程持续写入会排队；个人机场景不做写队列。
- 画像缓存 30s 是每进程独立的，其他窗口刚写的规则最多 30s 后才进入本窗口注入；要即时一致请调 `memory_context`。

### 版本
- 3.4.0 → 3.5.0；测试 242 / 242。

## [3.4.0] — 2026-11-18

### 新增 · 多宿主收尾：规则固化、HTTP 传输、独立面板
- `hosts/shared/`：抽出三个入口共用的 `boot.mjs`、`headless.mjs`、`context-tool.mjs`、`rules.mjs`；MCP 与 HTTP 复用同一个协议内核，不再各写一套。
- `hosts/mcp/server.mjs` 重构为 `createProtocol()`（传输无关）+ stdio 包装；新增 `prompts/list|get`（`omni-bootstrap`）、`resources/list|read`（`omni://rules`）；通知类消息静默处理。
- 规则固化：同一份 `RULES_TEXT` 走五条通道——`initialize.instructions`、prompt、resource、`memory_rules` 工具、写进项目规则文件。`applyManagedBlock()` 幂等，可挂在 SessionStart 钩子上反复执行而不改脏文件。
- 新增 `hosts/cli.mjs`：`omni rules | context | search | serve | mcp`；`context` 直接输出纯文本上下文，供 hooks 拼接。
- CLI 补成完整入口：新增 `write` / `report` / `forget`（与 MCP 走同一套工具实现）、`context --stdin`（直接吃钩子 JSON）、`search --problem-key / --status / --kind`。
- 新增 `hosts/http/server.mjs`：实现 `webServer.register` 壳，原样挂载插件 13 条路由；提供 `POST /mcp`（Streamable HTTP 的 JSON 响应模式）、`/health`、`/rules` 与静态面板。
- 新增 `hosts/http/web/`：独立只读面板（记忆 / 星图 / 规则），Canvas 星图支持拖拽、缩放、点选节点查事实。
- 新增 `test/rules.test.mjs`（幂等、追加、替换、文本自洽）与 `test/http.test.mjs`（路由挂载 + HTTP MCP + 面板）。
- 工具数 18 → 19（新增 `memory_rules`）。

### 文档
- 新增 `docs/REFERENCE.md`：按源码与真实 schema v11 逐项核对的机理与接口手册（三层结构、11 张表、写入与检索机理、19 个工具、13 条路由、MCP 协议面、CLI、环境变量、边界、AI 调用剧本）。
- 新增 `scripts/reference-to-memory.mjs` 与 `npm run memory:sync`：把手册按章节拆成笔记写进库，`memory_write` 自身去重保证幂等；章节 `importance` 刻意压到 0.35，避免挤占 1200 字符的常驻画像预算。

### 已知边界
- HTTP MCP 只实现 JSON 响应模式，未提供 SSE 流与 OAuth 鉴权；服务默认只听 `127.0.0.1`。
- 面板只读：写入仍走 MCP 工具或 POST 路由。
- core 仍未拆分，`index.js` 保持单体。

### 版本
- 3.3.0 → 3.4.0；测试 241 / 241。

## [3.3.0] — 2026-11-18

### 新增 · MCP 适配层（可脱离 DSH 运行）
- `hosts/mcp/`：零依赖、纯 stdio 的 MCP 服务，把同一份内核的 17 个 `memory_*` 工具原样暴露给 Claude Code / Cursor / Cline / Codex CLI / Zed，并新增 `memory_context` 作为「画像 + 相关记忆」的一次性引导调用（共 18 个工具）。
- `hosts/mcp/headless.mjs`：最小宿主上下文，只实现插件真正调用的 `tools.register` / `effect` / `on` / `get`；`index.js` 的工具与检索逻辑一行未改，适配层不复制内核。
- `hosts/mcp/server.mjs`：手写 JSON-RPC 2.0（单行一帧、按到达顺序处理、stdout 只走协议），不引入任何运行时依赖。
- `index.js` 新增宿主端口 `attachSession(sessionId, cwd)`：非 DSH 宿主启动时登记工作目录，项目分层沿用同一套 `proj:*` 规则，并持久化到 `meta.agent_project:*`，与其后打开的 DSH 会话共用同一层。
- 数据目录新增 `OMNI_HOME` 优先级（`OMNI_HOME` → `DSH_HOME` → `~/.dsh`）：DSH 与 MCP 默认共用同一个 `memory/omni.db`，不是两份库。
- `test/mcp.test.mjs`：真进程 stdio 契约测试（握手、工具列表、写入、召回、错误路径、未知工具）。

### 已知边界
- MCP 没有系统提示注入点，自动召回退化为「先调 `memory_context`」，靠服务级 `instructions`、工具描述与客户端项目规则三层引导。
- MCP 没有 `session/event` 事件流，原文转录不会自动增长；MCP 侧只有显式 `memory_write` 的内容。
- 无模型复核与 dream 定时校验（缺 `llm` 与定时器）；无 HTTP/SSE 传输。

### 版本
- 3.2.2 → 3.3.0；测试 236 / 236。

## [3.2.2] — 2026-11-18

### 许可
- 许可升级为 **全息记忆个人使用许可 1.1**：只允许个人、非商业使用；禁止任何形式的商业使用，包括直接商用、修改后商用，以及复制、改写、重写、反向工程或提取本软件**源码/架构**后制作商业替代、竞品、商业插件或商业服务。
- `LICENSE` 新增“架构”“商业替代/商业抄袭”定义，并明确“是否保留原代码、文件名或注释不影响禁止条款的适用”。
- README、`ATTRIBUTION.md`、`package.json`、`index.js`、`client.js` 的许可名称与 SPDX 标识同步到 1.1。

## [3.2.1] — 2026-11-18

### 许可
- 许可从 CC BY-NC 4.0 切换为 **全息记忆个人使用许可 1.0**：允许个人非商业使用、学习、复制、修改和非商业分发；禁止任何商业使用，**修改版尤其不得商用**；商用需取得作者书面许可。
- `package.json` 的 `license` 改为 `SEE LICENSE IN LICENSE`；`index.js`、`client.js` 的 SPDX 标识改为 `LicenseRef-Omni-Memory-Personal-Use-1.0`；README 与 `ATTRIBUTION.md` 同步更新。
- `LICENSE` 改为中文权威条款 + 英文非约束性摘要，保留署名、修改标记、免责声明与商业授权渠道。

## [3.2.0] — 2026-11-18

### 故障经验库（ADR-027）
- **Schema v11**：`notes` 新增 `problem_key / solution_status / solution_verified_at / reuse_count / last_used_at`，并建立 `problem_key`、`solution_status` 索引；旧库迁移补齐，旧行按 `unverified` 读取。
- **写入**：`memory_write(kind='note')` 支持 `problemKey / solutionStatus / evidence`；问题指纹归一化为小写、压缩空白、限长 200；同文本重复写入可补写经验元数据。
- **检索**：`memory_search` 的 `query` 改为可选，新增 `problemKey` 精确检索、`status` 过滤、`kind` 过滤；命中返回 `problemKey / solutionStatus / reuseCount / lastUsedAt / verifiedAt / verification / evidence`。
- **排序**：verified `+0.2`、failed `-0.2`、expired `-0.35`，复用次数最多 `+0.15`；融合后再次叠加，避免 RRF 覆盖；精确指纹命中置顶。
- **闭环工具**：新增 `memory_solution_report({ id, outcome, evidence? })`；success 标记 verified、写 `solution_verified_at` 并累计 `reuse_count`，failed/expired 更新状态并清空解法验证时间。
- **备份**：schema 10 → 11；导出自动携带新字段，导入显式恢复并重建索引。
- **界面**：笔记卡片显示「已验证解法 / 失败尝试 / 已失效」与复用次数。
- **边界**：`problemKey / solutionStatus / evidence` 仅允许 note；不把经验写进常驻 prompt，协议放在工具描述与 README，由调用方在遇障时先检索。

### 测试
- **235 / 235 通过**（新增 10 条 `solution-memory` 回归；schema/backup/tools 断言同步 v11 与 17 工具）。
- 基准复核（Node 22.23.2）：10k p95 2.4ms、100k 2.4ms、1M 6.0ms、1M + 5 万向量 + 100 万 bigram 116.8ms；均断言真实命中。

## [3.1.3] — 2026-11-18

### 修复
- **画像跨项目泄漏**：未知项目（`projectKey` 为空）的 facts 只读 `global`，不再回退到所有项目；笔记查询也在 SQL 层过滤当前层，避免其他项目的高权重笔记挤掉全局画像。
- **项目层检索语义**：`scope=project` 只返回 `proj:` 层，不再退回 `all`；`/omni-memory/graph` 同步支持项目层。
- **笔记检索假阳性**：`searchNotes` 不再把 `scope` 字符串参与正文 `matchRatio` 和最近窗口匹配。
- **项目前缀解析**：优先 exact `cwd` 映射，再做唯一共同前缀（≥12）匹配；歧义返回 null；自动 recall 校验 TTL 内项目映射未变。
- **备份完整性**：导出增加 `relations / entity_aliases / persona`；`activeOnly` 排除 `superseded` 笔记和 `valid_to` 失效事实；导入恢复 `facts.cardinality` 并 upsert 前述三表。
- **恢复冲突**：chunk 恢复前检查同 `hash/scope` 已有活跃行，返回结构化 `{restored:false, reason, activeId}`，不再撞 `chunks_hash_active` 唯一索引；HTTP 400 + 客户端错误态。
- **reindex limit**：`backfillVectors` 对 note/fact/chunk 三表共用全局 `limit`，hashed reindex 不再超量。
- **persona 刷新覆盖**：刷新改为 `existing + rules + model` 合并，手工字段保留；证据只取全局层；默认离线规则，`useModel` / `OMNI_PERSONA_MODEL` 才调用模型；面板保存保留自定义字段。
- **judge 改 scope**：事实改 scope 时同步更新同 `src/rel/dst` 的活跃边 scope。
- **基准有效性**：`bench/bench.mjs` 插入 `scope='global'`，新增 `hitTotal / minHitsPerQuery`，`pass` 要求 p95 < 300ms 且真实命中。

### 测试
- **225 / 225 通过**（新增 7 条 3.1.3 回归；persona 默认离线规则测试替换旧宿主模型断言）。
- 基准复核（Node 22.23.2）：10k p95 1.7ms、100k 1.8ms、1M 5.3ms、1M + 5 万向量 + 100 万 bigram 109ms。

## [3.1.2] — 2026-11-17

### 修复
- **导航与面板一起消失**：v3.1.1 加错误边界时覆盖掉了 `const LocalizedView = withLocale(MemoryView);` 声明，`apply()` 里引用未定义变量抛错，客户端插件整体注册失败。
- 恢复声明；新增 `scripts/check-client-load.mjs` 冒烟：在假 loader + 桩 slots/locale 里真正执行 `apply()`，能抓到未定义引用这类 `node --check` 发现不了的问题，已接入 `npm run check`。

## [3.1.1] — 2026-11-17

### 修复
- **面板白屏**：`React.useState` 被误写进星图的 `useEffect` 回调（无效 Hook 调用，挂载即抛错）。已移到组件顶层。
- 新增面板错误边界：渲染异常时显示错误文本与刷新提示，而不是白屏。
- 新增 `scripts/check-client-hooks.mjs` 并接入 `npm run check`：扫描 `useEffect` 体内是否出现 Hook 调用，防止同类问题再次发布。

## [3.1.0] — 2026-11-17

### 设定改为自动提炼（ADR-026 修订）
- `memory_persona({ action: 'refresh' })`：从日常记忆（活跃事实 + 高重要度笔记）提炼称呼/性格/习惯/偏好/其他。
- 证据包括**用户自己的原话**（最近 100 条 user 转录）、活跃事实与高重要度笔记；技术/实现类文本被过滤。规则兜底（称呼/喜欢/习惯/性格句式），模型可用时精炼；两者都经过"技术词/斜杠"合理性过滤。
- 模型精炼：宿主有 `llm` 时用其小型模型输出 JSON，失败自动回退规则；来源记录为 `model` / `rules`。
- 自动触发：每 20 次相关写入且距上次 ≥1 小时，后台刷新一次，不阻塞写入。
- 面板「设定」：显示提炼结果，可修正后保存；新增「重新提炼」按钮。
- HTTP：`POST /omni-memory/persona/refresh`（POST + CSRF + 同源）。

### 测试
- **217 / 217 通过**（新增 6 条：规则提炼、实现笔记过滤、用户原话提炼、直接指令提炼、宿主模型提炼、refresh 路由鉴权）。

## [3.0.1] — 2026-11-17

### 修复
- 星图新增「自转中 / 已暂停」按钮：`prefers-reduced-motion`（Windows 关闭动画效果）仍会默认暂停自动旋转，现在可以显式强制开启，选择存入 localStorage。
- 悬停停转的根因修复随 3.0.0 一起发布（`pointerInside` 未清除）；3.0.1 只是补一个手动开关，避免系统动画设置让用户以为"又坏了"。

## [3.0.0] — 2026-11-17

### 用户设定（ADR-026）
- **Schema v10**：`persona(key, value, updated_at)`，与 notes/facts 分离，不参与检索与 dream 校验。
- 工具 `memory_persona({ action: 'get' | 'set', values })`；面板新增「设定」按钮（称呼 / 性格 / 习惯 / 偏好 / 其他）。
- HTTP `GET/POST /omni-memory/persona`（写操作 POST + CSRF + 同源；参数在查询串）。
- 设定注入在系统提示最前，明确"高于临时指令"；单值 ≤1200 字、总量 ≤4000 字，空值删除。

### 修复
- **星图悬停后不再旋转**：`pointerInside` 在鼠标进入时被置 true 且从未清除，帧循环因此永久跳过自动旋转；现在仅在拖拽时暂停，并补了 `pointerleave` 清理 tooltip。
- **迁移顺序再次修正**：v10 曾插到 v9 之前，导致 v9 库升级后 marker=10 但没有 persona 表；已修正顺序，并把 repair 扩展为"当前版本缺表就补建"（v8/v9/v10 全量检查）。

### 测试
- **211 / 211 通过**（新增 5 条 persona + 2 条迁移：v9→v10、标记已是 v10 但缺表的修复）。

## [2.9.0] — 2026-11-17

### 实体别名与多值画像（ADR-024）
- **Schema v9**：`entity_aliases(alias PK, canonical, updated_at)`；事实 subject 写入前规范化（空白/全角/大小写/首尾标点），再沿别名链解析到规范名。
- 新工具 `memory_link_entity({ alias, canonical, apply })`：默认 dry-run 报告影响面；`apply: true` 合并 facts.subject 与 edges.src，之后经该别名的写入自动落到规范名。
- `memory_timeline` 按规范名查询；object 同时匹配原始写法。
- **画像事实块**：注入与 `memory_profile` 共用，只取 active facts，按 subject·relation 分组，多值关系显示最多 3 个值，与笔记共用 1200 字预算。

### 远程 embedding 加固（ADR-025）
- `OMNI_EMBED_PROVIDER` 预设（openai/dashscope/zhipu/siliconflow）；`OMNI_EMBED_BATCH`（默认 64）分批；`OMNI_EMBED_RETRIES`（默认 2）对 429/5xx 退避重试，其它 4xx 不重试。
- ANN 评估结论：保持有界采样 + 词面补集；引入原生扩展或自研 LSH 需要标注集/重建/回滚，列为独立项目。

### 测试
- **204 / 204 通过**（新增 4 条实体别名/画像 + 3 条 provider 加固；补齐既有 provider 单测）。

## [2.8.0] — 2026-11-17

### 多值关系（ADR-023 从提案到实现）
- **Schema v8**：`facts.cardinality`（默认 `single`）+ `relations` 注册表（cardinality/aliases/updated_at）。
- `memory_write({ kind: 'fact', cardinality: 'multi' })`：同 `subject+relation` 的多个值并存，不再互相过期；未声明的写入沿用注册表基数，默认仍是单值。
- 重复写入同一 object 视为同一条事实（`deduped: true`），不产生重复行。
- scope 隔离保持：项目层写入不会过期全局事实，反之亦然。
- 老库迁移：所有既有事实标记为 `single`，行为不变。
- 迁移顺序修正：v8 步骤曾误插到 v7 之前，导致 v7 库升级时只跑旧步骤；已修正顺序并加防御性修复（版本标记是 8 但缺列时补跑 v8）。

### 测试
- **197 / 197 通过**（新增 4 条多值用例 + 2 条迁移用例：v7→v8 升级、版本标记已为 8 但缺列时的修复路径）。

## [2.7.0] — 2026-11-17

### 索引与远程后端（路线第 4、5 项）
- **bigram 全量重建**：`memory_reindex({ bigrams: true })` 在一次调用内按批重建整个 CJK 两字索引（老库不再需要多次重启）；`vectors: true` 可同时跑向量回填。
- **远程嵌入 provider 集成验证**：新增 3 条真实 HTTP 测试（loopback 模拟 OpenAI 兼容端点）：
  - 探针维度与 signature 持久化，重启后不重新探测；
  - 写入入队、检索时 flush，向量分数出现在结果里；
  - 端点不可达时降级到词面检索且不挂起（<3s）。
- **ADR-022**：进程级鉴权与数据库加密的评估结论——在"宿主进程 + 同用户 + loopback HTTP"模型下插件层无法实现真正的进程认证；应用层加密会破坏 FTS/向量/图索引。措施改为：CSRF/同源、scope 隔离、明示明文风险、建议开启全盘加密。
- **ADR-023**：多值关系与实体消歧的设计提案（关系基数注册表 + 迁移策略），明确未实施与前置条件。

### 测试
- **191 / 191 通过**（新增：bigram 全量重建 1 条、远程 provider 3 条）。

## [2.6.0] — 2026-11-17

### dream 安全化（路线第 3 项）
- **破坏性变更**：`memory_dream({ apply: true })` 默认**只标记**（写 verification/evidence、置 contested、返回 `proposedText`），不再自动替代。
- 批量替代需显式 `commit: true`（apply + commit），文档标注为危险操作。
- 新增 `memory_dream_proposals`（只读候选列表）、`memory_dream_replace({ noteId, confirm: true })`（单条替代）、`memory_dream_rollback({ noteId })`（反替代：复活原笔记、墓碑化生成笔记）。
- HTTP：`GET /omni-memory/dream/proposals`、`POST /omni-memory/dream/replace`、`POST /omni-memory/dream/rollback`（POST + CSRF + 同源）。
- 面板审计视图：被替代的行显示「反替代」按钮。
- 设计边界见 ADR-021：dream 仍是词面启发式，proposals 的 `proposedText` 只是证据摘录，确认者需自己判断。

### 测试
- **187 / 187 通过**（新增 6 条 dream 安全用例；原替代用例改为显式 `commit: true`）。

## [2.5.0] — 2026-11-17

### 1M 行检索（路线第 2 项）
- **根因**：1M 行 p95 911–1452ms 不是单一查询慢，而是两个结构问题叠加：
  1. `ORDER BY bm25(...)` 必须物化全部匹配行，`LIMIT` 无法提前停止；
  2. scope / 活跃过滤发生在 JOIN 采样之后，过滤把样本全部排除时会退化为全表扫描（向量路径同样）。
- **词面检索改为两段式**：最近窗口 LIKE（默认 20,000 行，`OMNI_SEARCH_WINDOW`）+ FTS 无排序采样（120/词）+ bigram 索引反向扫描（200），候选上限内后用原有公式在 JS 打分；scope 过滤在 JS 复核，保证 `LIMIT` 先于过滤生效。
- **向量检索有界**：先取最近 `OMNI_VECTOR_SAMPLE`（默认 5,000）个 owner_id，再补词面候选 id（每层 ≤400），分批取向量与行；不再全表扫描。
- **性能**：1M 行 p95 **1451.8ms → 13.3ms**；1M + 5 万向量 + 100 万 bigram **56.4ms**；10k 2.2ms；100k 5.8ms。
- **质量**：黄金集 lexical MRR **0.776**（不变），lexical+vector **0.927**，recall 1.0。
- **可观测**：`OMNI_PROFILE=1` 时 `/status` 返回 `lastSearch` 分段耗时；bench 支持 `BENCH_VECTORS` / `BENCH_BIGRAM` 派生索引压力。
- 取舍与残余风险见 ADR-020：窗口外旧记忆只靠精确词召回，纯语义旧记忆可能不出现；FTS 采样质量待长期数据验证。

### 测试
- **181 / 181 通过**（新增 2 条：窗口外精确词仍可召回、跨项目 scope 在 JS 复核后不泄漏）。

## [2.4.0] — 2026-11-17

### 备份 / 导出 / 恢复（路线第 1 项）
- **`memory_export`**：生成可移植 JSON 快照（notes / facts / chunks / edges / entities），默认包含墓碑与历史；`activeOnly` 只导出活跃行。向量是派生数据，不导出。
- **`memory_import`**：合并导入，**默认 dry-run**；按内容而非 id 去重；note 的 `superseded_by` 指针在 id 重排后自动重映射；导入后重建 FTS / bigram / 向量。
- **`memory_restore`**：复活单条墓碑化记忆并重建派生索引（事实恢复时同步恢复 edge）。
- **审计视图**：列表默认只显示活跃记忆；`?audit=1` 显示历史（被替代 / 已删除 / 失效），面板新增「审计」「导出」按钮，删除项可一键恢复。
- **HTTP**：`GET /omni-memory/export`（`download=1` 返回附件头）、`POST /omni-memory/restore`（POST + CSRF + 同源校验）。
- 导出/导入的格式与安全边界见 ADR-019，威胁模型同步更新（导出包含全量记忆、导入读取本地路径）。
- **agent→项目映射持久化**：重载插件后、下一条用户消息到达前，工具写入仍能落到正确项目层（此前会 fail-closed 到 global）。真实使用中发现的缺口，已补回归用例。

### 测试
- **179 / 179 通过**（新增 9 条：导出含墓碑、导出路由附件头、导入 dry-run/去重、lineage 重映射、restore、restore 路由 CSRF、审计列表可见墓碑、重载后项目映射持久化、未知 agent 仍 fail-closed）。

## [2.3.3] — 2026-11-17

### 防复发护栏（ADR-018）
- **状态×读取路径矩阵测试**：新增 `test/lifecycle.test.mjs`（7 例），覆盖 active / superseded / tombstoned / contested / expired × global / 项目 A / 项目 B × search / profile / graph / node / list / 重新捕获转录。首次运行即抓到真实泄漏：面板列表仍返回被替代笔记。
- **活跃视图与审计视图分离**：`/omni-memory/list` 默认只返回活跃记忆；新增 `?audit=1` 保留历史（被替代笔记、失效事实）可见，含 verification/evidence/superseded_by。
- **文档一致性门禁**：新增 `scripts/check-docs.mjs`，实测版本、用例数、工具数、路由数、ADR 数并与 README/DESIGN/CHANGELOG 核对，不一致即 `npm run check` 失败。
- **威胁模型**：新增 `docs/THREAT-MODEL.md`，写清资产、参与者、信任边界、现有控制、残余风险与新增路由检查清单。
- **CI**：`.github/workflows/ci.yml` 在 Node 24 上执行 `npm run check` + `npm test`。
- 外部补丁接收流程写入 ADR-018（核对声称文件、隔离分支、dry-run、通读 hunk、独立补测试、真机冒烟）。

### 测试
- **170 / 170 通过**（新增 7 条生命周期矩阵）。

## [2.3.2] — 2026-11-17

### 可靠性（代码级评审修复）
- **历史状态过滤**：`searchNotes` / `searchFacts` / `searchChunks`、向量召回和图游走统一排除 `superseded_by` 与过期的 `valid_to`；画像与自动召回不再注入 superseded / contested 笔记；事实失效时同步失效对应 `edges`。
- **Schema v7**：`chunks.hash` 的全局唯一索引改为按 `(hash, scope)` 的部分唯一索引，墓碑后同文可以重新捕获；`edges` 增加 `scope`，`facts` 增加 `recorded_at`；新增 `bigrams` 表支撑 2 字 CJK 查询。
- **远程嵌入生命周期**：持久化 `remote_dim` / `remote_signature`，重启后恢复维度；固定探针探测维度；旧库缺向量按批回填；新增第 8 个工具 `memory_reindex`（hashed / remote 两种后端均可回填）。
- **Scope 隔离**：HTTP 搜索、画像、时间线、节点详情支持 `scope`；裸请求默认 `global`；未知项目不再继承上一项目；`scope=all` 只读，写入直接报错；删除跨请求的 `lastProjectAny` / `lastRecallAny` 回退；工具调用不再回退到最近一次装配，无 context 时只走 `global`。
- **HTTP 安全**：`forget` 只接受 POST，GET 返回 405；写请求校验 `Origin` 与 `x-omni-csrf` 头；`OMNI_SCOPE_JUDGE` 默认从 `always` 改为 `off`，默认不把正文发给模型；judge 队列上限 256，无 `llm` 时不入队；模型空输出保留规则判定。
- **事务与去重**：`insertChunk`、事实/笔记写入、做梦应用、compact 全部包事务；`transaction()` 使用 `BEGIN IMMEDIATE`，失败回滚；compact 批量墓碑不再留下半截状态。
- **2 字中文**：`searchNotes` / `searchFacts` / `searchChunks` 对 2 字 CJK 查询走 `bigrams` 索引，不再直接退化为 `LIKE` 全表扫描。旧库索引采用增量回填：每次打开每层最多处理 10,000 行，游标持久化在 `meta`，需要完全补齐时多次打开或显式重建。

### 测试
- 新增 `test/fixes.test.mjs` 11 个回归用例（由本仓库独立编写，非评审补丁附带）：superseded / valid_to 过滤、跨 scope 事实隔离、HTTP scope 默认值、`scope=all` 写入拒绝、无 context fail-closed、CSRF（GET 405 / 缺头 403 / 跨站 403）、墓碑后同文重捕、跨项目同文各存一条、`memory_reindex`、v6→v7 迁移。
- **163 / 163 通过**。
- 真实库副本迁移验证：12 notes / 6 facts / 423 chunks 行数不变；`chunks_hash_active` 部分唯一索引建立；`edges.scope` 回填 8/9；`bigrams` 回填 41,241 条。
- 远程嵌入补充**失败退避**：端点不可用时 60 秒内不再探测，避免每次检索叠加超时。

### 文档
- DESIGN 更新到 2.3.2 / schema v7 / 8 工具 / 6 路由 / 新行数；NFR-08 明确“数据库未加密、loopback 无进程级鉴权”的边界；ADR-017 记录 HTTP 安全与默认隐私决策。
- README 更新测试数、配置默认值、隐私边界与 `memory_reindex`。

## [2.3.1] — 2026-11-15

### 许可协议：CC BY-NC 4.0
- 由「仅限个人自用」调整为 **知识共享 署名-非商业性使用 4.0 国际（CC BY-NC 4.0）**：
  - ✅ 允许公开使用、复制、修改、二次开发、借鉴与再分发（含发布修改版）
  - 🚫 禁止任何商业用途（含公司内部生产使用、付费服务、SaaS、外包交付、销售/转售/捆绑收费）
  - ⚠️ 必须署名：保留作者、项目链接、协议声明；修改需注明「已修改」；不得暗示作者背书
- 新增 `ATTRIBUTION.md`：署名最低要求、4 种可直接复制的模板（README/源码头/关于页/英文）、常见问题。
- `index.js`、`client.js` 增加 SPDX 标识与出处注释；`package.json` 的 `license` 改为 `CC-BY-NC-4.0`。
- LICENSE 含 CC 官方英文法律文本 + 中文摘要；商业授权需取得作者书面许可。

## [2.3.0] — 2026-11-15

### 关系线可读化
- **悬停看关系**：鼠标停在线条上，浮出「记忆插件 —包含→ 星图」；「提到」类显示「笔记 提到 实体」。
- **两类线分开画**：事实关系=实线 + 指向 object 的箭头；笔记提到=淡青虚线。
- **聚焦模式**：右上「聚焦」开关。点中一颗星后，只保留它的一跳邻居与相连的线，其余压暗到 22%，杂乱星图立刻变清楚。
- 触控不受影响：线命中判定只在「没有命中节点」时生效，避免抢星点的点击。

### 测试
- **152 / 152 通过**（宿主接口未变，前端改动由真机截图验证）。

## [2.2.1] — 2026-11-15

### 项目列表补全
- **问题**：面板「项目分层」只显示 3 个项目，而侧栏有很多工作区。
- **原因**（不是过滤 bug）：项目层来自真实记忆数据。当时全库只有 `deepseek-harness-插件`、`庆云圈`、`taptap游戏` 三个项目有记录（另有 62 条早期版本遗留的无归属片段），其余工作区从未被捕获过。
- **修复**：扫描 `$DSH_HOME/sessions` 下 DSH 记录的工作区目录，把**所有工作区**都列进「项目分层」，无记忆的显示「暂无记忆」并且不可点击（避免用伪造的 scope 制造重复项）；临时目录与内部 IM 工作区被排除。
- 目录名编码存在歧义（`-` 同时表示分隔符和字面量），因此只用于展示标签，去重采用归一化后缀匹配，绝不用它推导 scope。
- 标题显示总数：「项目分层 · 共 N 个（含暂无记忆）」。

### 测试
- **152 / 152 通过**（新增 2 例：无记忆工作区可见、有数据层排在占位层之前）。

## [2.2.0] — 2026-11-15

### 点星弹卡 + 搜索高亮
- **点星弹卡**：在星图上单击任意记忆节点，右侧浮出记忆卡——笔记显示全文、层级、重要度，可一键遗忘；实体显示它的关系三元组。
- **拖拽不误触**：按下后位移超过 4px 才算拖拽，松手不会弹卡。
- **搜索高亮**：抽屉里搜索后，命中的笔记与实体在星图上亮起**脉冲光环**，未命中的节点自动压暗，一眼看到结果落在哪。
- **节点详情接口**：新增 `GET /omni-memory/node?node=n:<id>|e:<name>`，仅 loopback 可访问；笔记返回全文与元数据，实体返回关系列表。

### 测试与版本
- 自动化用例：**150 / 150 通过**（新增 3 例：节点详情、实体关系、未知节点 404）。

## [2.1.0] — 2026-11-15

### 整屏星图
- 打开「全息记忆」即为**全屏星系**：画布铺满整个面板，记忆星图作为背景主体。
- 列表改为**右侧浮层抽屉**：默认隐藏，点「列表」展开；抽屉内含搜索、统计、项目分层、笔记/事实列表、翻页与遗忘。
- 顶部悬浮工具条：搜索框、搜索/重置、列表开关、刷新，全部半透明玻璃质感，叠在星图上。
- 左下角常驻统计（笔记/事实/片段/争议）。
- 分层切换（全局 / 各项目）仍在星图左上角。
- 折叠按钮在全屏模式下隐藏（全屏即展开）。

### 稳定性
- 全屏画布仍走 Canvas 2D 手写投影，零依赖；保留自适应降级、省电暂停、`prefers-reduced-motion` 支持。

## [2.0.0] — 2026-11-15

### 稳定性与上架加固
- **自动降级**：星图渲染异常时停止绘制并显示降级提示，面板其余功能不受影响（错误边界 + 循环 try/catch）。
- **性能自适应**：按帧耗时自动降低背景星绘制密度（1→2→3 步进），低配机器自动保帧率。
- **省电**：面板不可见（`document.hidden`）时暂停绘制；提供「收起/展开星图」按钮，收起后完全停止渲染。
- **无障碍**：尊重 `prefers-reduced-motion`，开启时关闭自动旋转，仅保留手动拖拽。
- **尺寸健壮性**：改用 `ResizeObserver` + 窗口 resize 双保险，画布尺寸为 0 时跳过绘制。
- **零依赖不变**：星图仍为 Canvas 2D 手写投影，不引入 WebGL/three.js（探索结论：DSH 渲染进程的 WebGL 输出不可用，见 ADR-016）。
- **上架元数据**：补齐 `license`、`keywords`、`README.md`、`LICENSE`，`files` 包含市场所需文件。

### 测试与指标
- 自动化用例：**147 / 147 通过（100%）**。
- 版本 2.0.0 表示可上架的稳定基线，而非功能冻结。

## [1.9.1] — 2026-11-15

### 尝试与回滚
- 尝试把星图升级为手写 **WebGL2**（GLSL 粒子 + 差速旋转 + bright-pass/blur 真 bloom + 程序化星云，零依赖）。着色器编译、`getContext('webgl2')`、离屏帧缓冲均成功，调试行显示 `gl 1859x460 dpr=1`、数据 `12/6200`，但画布在该 Electron 渲染进程中始终输出**空白白屏**（无 GL 错误、无 JS 异常）。
- 判定为渲染进程的 WebGL 合成限制（软件/禁用 GPU 路径下帧缓冲不落地，或 asar 渲染进程的 GL 上下文被回收），继续盲调成本过高，**回滚到已验证的 Canvas 2D 旋臂星系**（v1.9.0 观感）。
- 同时清理了 WebGL 尝试遗留的死代码（GL 常量、mat4 辅助、重复 RNG）。

### 结论
- 想达到 three.js 级效果，需要先解决该渲染进程的 WebGL 输出问题（或改用可离线打包的 three.js + 独立窗口），不是在组件里换 API 能绕过的。
- 当前交付：Canvas 2D 星系（1500 星 + 星云 + 分层切换），147/147 用例通过。

## [1.9.0] — 2026-11-15

### 重做（FR-29：记忆星图 → 旋臂星系）
- 视觉重写，参考开源程序化星系做法（4 条旋臂、半径按平方根分布、臂宽与厚度随半径衰减、叠加发光、蓝→暖色渐变，见 threejsroadmap 的 galaxy 实现与 open-design 的 particle-galaxy 示例）：
  - 1500 颗背景星（暖色/蓝色双色带、闪烁、深度衰减）
  - 记忆节点落在旋臂上，笔记=青色、实体=暖金色，带三层辉光
  - 星云径向渐变 + 明亮核心
  - 拖拽旋转、滚轮缩放、惯性、空闲自转、悬停标签
- **分层星图**：顶部切换「全局 / 各项目」，每层一张独立星图（`/omni-memory/graph?scope=global|<项目键>`），接口同时返回 `scopes[]` 目录（每层的事实/笔记计数）。
- 图数据改为按 scope 从 facts/notes 直接构建，项目图不会混入全局星，反之亦然。

### 测试与指标
- 自动化用例：**147 / 147 通过（100%）**；新增「全局图与项目图互不混入」用例。

## [1.8.1] — 2026-11-15

### 修复（重启后「连不上记忆服务」）
- 根因：DSH 在 **`/api` 前缀**上注册了连接鉴权（`connection.admit`），未带浏览器会话凭证的请求直接返回 `401 unauthorized`。插件原来的 `/api/memory/*` 路由正好撞在这个前缀下，重启后宿主开始拦截，面板 `fetch` 拿到非 JSON 响应、走异常分支，显示「连不上记忆服务」。
- 修复：记忆路由整体迁到 **`/omni-memory/*`**（宿主当前只守卫 `/api`）；宿主与客户端两半同步更新，`curl /omni-memory/status` 返回 200 已验证。
- 教训记录：DSH 插件自建 HTTP 路由**不要放在 `/api` 前缀下**，那是宿主 client-connection 的保留前缀。

### 测试与指标
- 自动化用例：**146 / 146 通过（100%）**（用例路径同步更新）。

## [1.8.0] — 2026-11-14

### 新增（FR-29：记忆星图）
- 面板顶部常驻**星图**：实体是星、开启中的事实边是连线、笔记挂到它提到的实体上。
- 交互：拖拽旋转（带惯性）、滚轮缩放（0.45–2.6）、空闲 2.5 秒后自动缓慢旋转、悬停显示节点标签。
- 视觉：斐波那契球面分布、深度透明度、径向辉光、视差背景星点；投影半径按画布高度自适应，铺满整条画布。
- 新接口 `GET /api/memory/graph`：节点 ≤300（180 实体 + 120 笔记），无悬空连线；空库返回空图。
- 星图包在错误边界里：渲染异常时显示原因而不是静默消失。

### 决策
- 用 Canvas 2D 手写 3D 投影，不引入 three.js（客户端是单文件、无打包步骤），见 ADR-016。

### 测试与指标
- 自动化用例：**146 / 146 通过（100%）**；新增 `test/graph-view.test.mjs`（5 例）：实体/连线生成、笔记挂载、节点上限与无悬空边、空库、仅 loopback。

## [1.7.0] — 2026-11-14

### 修复
- **项目视图看不到"只有转录、没有笔记"的项目**：转录由系统自动捕获，笔记由模型按判断写入，某项目可能只有前者。此前列表只查笔记/事实，导致另一个项目看起来是空的。
- 列表路由新增 `projects[]`：按项目汇总笔记 / 事实 / 转录条数与最近活动；精确项目键下额外返回最近 20 条 `chunks[]`。
- 面板「项目」筛选改为项目卡片列表（名称、三类计数、最近活动），点击进入该项目查看笔记与最近转录，并提供「返回项目列表」。

### 测试与指标
- 自动化用例：**141 / 141 通过（100%）**；新增 `test/project-view.test.mjs`（3 例）：项目汇总含转录计数、精确视图只返回本项目转录、只有转录的项目仍可见。

## [1.6.6] — 2026-11-14

### 文档与数据
- 记录冲突阈值 0.9 的实测依据：语义改写对余弦仅 0.688，字面近似对 0.913；**不降低阈值**，语义重复交给模型复核或人工。
- 清理一条与 note #14 语义重复的旧规则（note #9 墓碑化，行保留可审计）。
- 新增 `DESIGN.md` 第 14 节「配置项与默认值」，12 项环境变量的默认值、成本、依据集中记录。

## [1.6.5] — 2026-11-14

### 修复与改进
- 真实宿主的 `AssembleContext.scope.id` 是**截断 id**（如 `session-b707`），与捕获时的完整 id 不符，导致项目回退始终取不到。改为前缀匹配已知会话，且不回退到无关会话。
- `lastJudge` 现在记录**每一次**模型判定（含 `moved: false`），不再只在改判时出现——这样能验证 `always` 模式确实在调用模型。

## [1.6.4] — 2026-11-14

### 修复
- 项目回退改为「id 优先」：装配上下文带 id 时以 id 为准（未知 id 一律视为其他会话，不继承）；只有完全没有 id 时才用最近捕获的项目。上一版的 120 秒时间窗在长回合里会失效。
- `lastInjection.scopeId` 记录装配是否拿到可用 id，便于排查。

## [1.6.3] — 2026-11-14

### 修复
- 重载插件后的第一个回合里，`inbox` 事件早于任何捕获，工作目录尚未登记，`lastProjectAny` 一直为空，导致整轮写入被判成 `no-project`。现在捕获消息时也刷新该回退值，并用「最近一次用户消息 120 秒内」作为使用条件，避免把旧项目泄漏给无关会话。
- 真机复现：重载后连续两条写入返回 `no-project`；修复后应恢复为项目层判定。

## [1.6.2] — 2026-11-14

### 变更
- `OMNI_SCOPE_JUDGE` 默认值由 `auto` 改为 **`always`**：每条写入都让模型复核归属。
- 两条豁免：显式传入 `scope` 的不复核（调用方的决定优先）；没有项目上下文时不复核（无分歧可判）。

### 测试与指标
- 自动化用例：**138 / 138 通过（100%）**；新增「显式 scope 不被推翻」「无项目不调用模型」两例。

## [1.6.1] — 2026-11-14

### 修复
- 装配上下文里的 `scope` 在真实宿主中不总是带 `id`，导致项目判定偶发退化为 `no-project`（写入全落全局）。现回退到「最近一次用户消息所属项目」，并把该回退记录下来。
- 真机验证：note #12 以 `default-to-project` 落项目层，后台 `deepseek-official/deepseek-flash` 复核后改判 `global`，`lastJudge` 记录 from/to/model。

## [1.6.0] — 2026-11-14

### 新增（FR-28：模型复核归类）
- 写入仍按规则立即落层（不阻塞），随后由后台 `llm` 服务复核：含糊项让模型只回答 `global` / `project`，判错则迁移归属并留痕（`lastJudge`）。
- 模式开关 `OMNI_SCOPE_JUDGE=off|auto|always`（默认 `auto`，只复核规则没把握的项）。
- 模型路由：`OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL`，否则自动挑便宜的（flash/mini/haiku/small/lite）。
- 复核失败（无服务/超时/抛错）保留规则判定，写入不受影响；`/omni-memory/status` 暴露 `lastJudge`。

### 事故与修复
- 修复过程中误用 PowerShell 文本替换重写 `index.js`，导致 UTF-8 中文被 GBK 往返破坏。已按字节级逆变换 + 逐行重建恢复，1376 行全部通过 `node --check` 与 136 项用例；此后禁止用 shell 改 UTF-8 源文件。

### 测试与指标
- 自动化用例：**136 / 136 通过（100%）**；新增 `test/scope-model-judge.test.mjs`（7 例，假 llm 服务）。

## [1.5.0] — 2026-11-14

### 新增（FR-27：归属判断机制）
- **写入判断**：未显式传 `scope` 时按措辞判定层——跨项目措辞（偏好/以后/一律/铁律…）→ `global`；项目痕迹（本仓库/src//.mjs/构建/部署…）→ 当前项目；含糊时保守落当前项目。结果回传 `scope` 与 `scopeReason`，工具输出显示 `· project (reason)`。
- **检索判断**：`memory_search` 未传 scope 时默认搜「当前项目 + 全局」，不再扫全部层；返回 `scope` 并在输出里标注。
- 事实、笔记、episode 共用同一套判断。

### 修复
- 工具输出里中文被写成乱码箭头（`路`），统一改为 `·`。

### 测试与指标
- 自动化用例：**129 / 129 通过（100%）**；新增 `test/scope-judge.test.mjs`（8 例）。
- 显式 scope 永远优先；同一文本在两层仍是两条记录（既有契约不变）。

## [1.4.2] — 2026-11-14

### 修复
- 面板分页标签把事实算进了笔记区间，显示成 `1–5 / 4`；改为只统计本页笔记数（`1–4 / 4`）。

## [1.4.1] — 2026-11-14

### 修复
- 迁移 v6：升级前手写的 `proj:<name>`（无哈希）作用域统一归为 `global`。否则分层上线后这些行既不属于任何项目键、也不是全局，会从画像与检索里静默消失。
- `meta.schema_version` 升到 6；新增迁移用例（把库版本退回 5、写入旧作用域、再启动插件，断言被归一为 global）。

## [1.4.0] — 2026-11-14

### 新增（FR-26：项目级/全局级分层）
- 转录捕获按 `session.header.cwd` 自动写入项目层（`proj:<目录名>#<哈希>`）；无工作目录写 `global`。
- 常驻画像改为「全局 + 当前项目」，未知项目时只注入全局——项目细节不再泄漏到其他会话。
- 检索作用域语义统一：项目视图 = 该项目 + 全局 + 历史无 scope 行；`all` 不过滤；`global` 只看全局。
- 注入块新增 `Current project scope: proj:…`，模型可把它作为 `scope` 传给 `memory_write` / `memory_search`。
- 面板新增「全部 / 全局 / 项目」筛选，列表路由按层过滤并返回 `stats.globalNotes / projectNotes`。

### 修复
- 笔记检索的作用域过滤此前用精确匹配，项目查询看不到全局层；现与事实/转录一致。
- 向量与图路线的 scope 过滤同步改为分层语义。

### 测试与指标
- 自动化用例：**120 / 120 通过（100%）**；新增 `test/scope-layers.test.mjs`（6 例）覆盖捕获落层、画像隔离、检索跨层、面板过滤。
- 既有数据保持 `global`，不做自动改判（归属是人的判断）。

## [1.3.2] — 2026-11-14

### 变更
- 悬停详情改为**自绘浮层**（位于圆点上方、窗口内），替代系统原生 `title` tooltip——后者在输入框贴近屏幕底部时会飘到窗口外。
- 浮层字号 `0.9em`、圆点 `0.42em`，全部相对继承，随应用字体缩放。

## [1.3.1] — 2026-11-14

### 变更
- 状态条极简：只保留「圆点 + 全息记忆」，注入字数/召回条数/存量移到悬停提示（`tailHover`）。
- 字号与行高改为 `inherit`，跟随应用字体设置；圆点尺寸改用 `em`，随字号缩放。
- 移除固定 10px 字号与额外内边距，占用空间降到一行内联文本。

## [1.3.0] — 2026-11-14

### 新增
- **自动召回开关**（FR-24）：`OMNI_AUTO_RECALL=0` 关闭，默认开启。监听 `agent/inbox/claimed` 捕获用户消息并异步预取 top-3，装配时同步读缓存追加到提示段（ADR-012）。竞态未命中时降级为仅画像。
- **对话结尾状态条**（FR-25）：`conversation.composer.dock`（id `memory-tail`, order 3）显示 `● 记忆 · 注入 N 字 · 召回 M · 共 K 条`，5 秒轮询，60 秒内生效亮绿点。
- **状态接口** `GET /omni-memory/status`：返回 `autoRecall`、`lastInjection{at,chars,recall}` 与存储统计（仅 loopback）。

### 测试与指标
- 自动化用例：**114 / 114 通过（100%）**。
- 新增 `test/autorecall.test.mjs`（5 例）：开时召回进提示、关时不进、状态接口统计正确、仅 loopback、无消息时降级为仅画像。

## [1.2.0] — 2026-11-14

### 修复
- `memory_timeline` 现在同时返回**提到该实体的笔记**，与事实按时间合并排序（此前只查 facts，D-07）。
- 时间线要求 `entity` 非空；空输入给出明确错误。
- 顺带清掉时间线渲染里的乱码箭头（`鈫?` → `→`）。

### 测试与指标
- 自动化用例：**109 / 109 通过（100%）**。
- 已知缺陷表中除 D-12（捕获不含工具调用，按设计）外全部关闭。

## [1.1.0] — 2026-11-14

### 新增（M5 收尾）
- **面板分页**：`/api/memory/list` 支持 `limit/offset`，返回 `page`（总数、是否还有更多）与 `stats.contested/verified`；面板显示「起–止 / 总数」与上一页/下一页。
- **状态展示**：卡片新增 `contested`、`verification`（supported/weak/contradicted/unsupported/no_source）、`evidence`、`superseded` 标记。
- **中英本地化**：注册 zh/en 词典，`ctx.locale.subscribe` 触发重渲染；左栏入口文字跟随语言。
- **增长治理**：`memory_compact({ keepChunks, apply })`——按保留上限墓碑化最旧转录（默认 5000、下限 50、dry-run 默认），不物理删除。

### 修复
- 面板原先固定拉 120 条、无法翻页；状态字段（校验结论、证据）不可见。

### 测试与指标
- 自动化用例：**107 / 107 通过（100%）**。
- 新增 `test/compact.test.mjs`：dry-run 不写库、apply 只墓碑超出部分、下限钳制、墓碑行退出召回、分页元数据、列表暴露校验状态。
- 已知缺陷 D-10（面板无分页）与 D-11（无 i18n）关闭。

## [1.0.0] — 2026-11-14

### 新增（M4 / FR-20：做梦校验）
- `memory_dream` 工具：拿转录原文核对笔记，输出 `supported / weak / contradicted / unsupported / no_source` 判定与证据指针。
- 默认 dry-run；`apply=true` 时写入 `verified_at / verification / evidence`，对 `contradicted`、`unsupported` 用证据原文生成替代笔记（`source: dream:<id>`、`revision+1`），旧笔记写 `superseded_by` 并置 `contested=1`——只修订，不删除。
- 判定为确定性算法：覆盖度 + 「笔记含证据里缺失的拉丁/数字特征词」；不调用模型（ADR-010）。
- 可选定时执行：`OMNI_DREAM_INTERVAL_MS > 0` 时后台按间隔 apply，默认关闭。
- 迁移 v5：`notes.verified_at / verification / evidence`。

### 测试
- `test/dream.test.mjs`（5 个用例）：正确笔记判 `supported`；「笔记写 Docker、转录写裸机」判 `contradicted` 且替代笔记来自转录；无来源判 `no_source`；已替代不再重复校验；dry-run 不写库。

### 测试与指标
- 自动化用例：**101 / 101 通过（100%）**。
- 检索延迟（10,000 行）：p50 5.5ms / **p95 10.4ms**，预算 300ms。
- 全部 20 条功能需求（FR-01..21）中，除 M5 的收尾项外均已实现并有测试覆盖。

### 版本说明
- 1.0.0 表示功能里程碑完整（M0–M4），不代表「永不再改」；后续按 M5 加固。

## [0.9.0] — 2026-11-14

### 新增（M3 / FR-18、FR-19）
- **图路线**：从 top-6 命中抽取实体作种子，沿 `edges` 最多 2 跳、`0.5^hop` 衰减，按**被遍历的边**精确回查事实，作为第三条排名列表进入 RRF。开关 `OMNI_DISABLE_GRAPH=1`。
- **冲突标记**：`memory_write(kind='note', contradicts=[id...])` 显式声明；未声明时按哈希余弦 ≥0.9 自动标记近重复。仅标记，不合并、不删除。
- 实体列表带 30 秒缓存，事实写入立即失效。

### 修复（由测试发现）
- 实体缓存初始 `at: 0` 被误判为"刚缓存"，导致图路线永远拿到空实体表。
- 图路线最初返回"提到邻居的事实"，会跳脱语义并越过预期深度；改为返回遍历到的边。
- 显式 `contradicts` 未校验 id 是否存在，会标记不存在的行。

### 测试与指标
- 自动化用例：**96 / 96 通过（100%）**。
- 黄金集（20 语料 / 24 问）：词面 MRR 0.791 → 加向量 **0.927**（+0.136）→ 加图 0.927（纯笔记语料无增益，属预期）。
- 检索延迟（10,000 行）：p50 5.5ms / **p95 10.2ms**。

## [0.8.0] — 2026-11-14

### 新增（M2b / FR-21）
- `lib/embed-provider.mjs`：嵌入后端可插拔。默认 `hashed`（零依赖、离线）；设置 `OMNI_EMBED_URL` 切换为 OpenAI 兼容 `/embeddings`。
- 远程模式**写入只入队**，检索前批量刷新（≤32 条/次），失败保留队列并回退词面——回合路径零网络调用。
- `vectors.dim` 参与检索过滤：切换后端无需迁移，旧维度行自然失效。
- 查询侧使用同一后端嵌入，保证向量空间一致。

### 测试
- 新增 `test/semantic.test.mjs`（本地 mock 端点）：
  - 零共享字符的改写查询可召回，且 `lexicalScore` 为空 → 证明是语义路径在起作用；
  - 同一查询在 hashed 后端无命中 → 证明两种后端确有差异；
  - 端点不可用时检索不报错，词面照常返回。

### 测试与指标
- 自动化用例：**87 / 87 通过（100%）**。
- 默认（hashed）路径指标不变：MRR 0.917、p95 12.6ms @ 10k 行。

### 配置
```
OMNI_EMBED_URL=https://api.example.com/v1/embeddings
OMNI_EMBED_MODEL=text-embedding-3-small
OMNI_EMBED_KEY=sk-...
OMNI_EMBED_TIMEOUT_MS=10000
```

## [0.7.0] — 2026-11-14

### 新增（M2a）
- `lib/embed.mjs`：零依赖、确定性、512 维哈希字符 n-gram 嵌入（CJK 二元组 + 拉丁整词，L2 归一化）。
- `vectors` 表（迁移 v3）+ 写入同步 + 启动回填；维度调整用迁移 v4 重建派生索引。
- 检索改为 **RRF 融合**（词面 + 向量，k=60），命中项同时暴露 `lexicalScore` / `vectorScore` / `rrf`。
- 黄金集评测 `bench/golden.mjs`（20 条语料 / 24 个问题，含改写问句）。
- 诊断开关 `OMNI_DISABLE_VECTOR=1`，用于对比纯词面基线。

### 修复（由测试发现）
- 无关查询会因哈希碰撞拿到 0.12 以上的余弦 → 提高维度到 512、阈值提到 0.2，并强制「至少共享一个 token」。

### 测试与指标
- 自动化用例：**78 / 78 通过（100%）**。
- 黄金集：recall@10 1.000（两路相同）；**MRR 0.770 → 0.917（+0.147）**。
- 检索延迟（10,000 行）：p50 5.5ms / **p95 12.6ms**，预算 300ms。

### 已知局限
- 该嵌入**不是语义模型**，换说法且无共享字时仍召回不到；真语义列为 FR-21 / M2b。

## [0.6.0] — 2026-11-14

### 新增（M1 收尾）
- **迁移框架**：`meta.schema_version` + 顺序迁移（`MIGRATIONS`），旧库就地升级到 v2（D-08）。
- **notes/facts 全文索引**：`notes_fts`、`facts_fts`（trigram），启动时回填历史行；词面检索优先 `MATCH`，LIKE 仅兜底（D-03）。
- **分层作用域**：`facts.scope`、`chunks.scope` 列，作用域过滤覆盖三层；无作用域的行对任意项目可见（D-06）。
- **`forget` 改为 POST**（参数走查询串），GET 保留兼容旧客户端（D-04）。
  真机验证时发现：DSH web server 会先读空请求体（`complete=true/readable=false`），JSON body 一律拿不到，因此写操作参数统一放查询串。
- 性能基准 `bench/bench.mjs`。

### 修复（由测试发现）
- 迁移测试暴露：`openStore()` 惰性打开导致迁移时机依赖首次访问 → 测试已改为显式预热，行为符合设计（迁移发生在首次打开存储时）。

### 测试与指标
- 自动化用例：**63 / 63 通过（100%）**，达标线 95%。
- 检索延迟（10,000 行，40 次查询）：p50 5.6ms / **p95 11.7ms** / max 12.2ms，预算 300ms（NFR-01）。

## [0.5.0] — 2026-11-14

### 新增
- 设计规格 v1.0（`docs/DESIGN.md`）：需求编号、追溯矩阵、失败模式、可靠性口径。
- 6 份 ADR（存储/删除/捕获/注入/坐席/检索顺序）。
- 自动化测试工程（`node:test`，7 个文件 51 个用例），覆盖 FR-01..13 与 NFR-02/04/06/07。
- `npm test` / `npm run check` 脚本。

### 修复（由测试发现的两个真实缺陷）
- `memory_write(kind=note)` 接受纯空白文本 → 现在抛 `text is required`。
- 遗忘记忆后注入画像仍含旧条目 → `memory_forget` 现在立即失效画像缓存（FR-10）。

### 可靠性
- 自动化用例：**51 / 51 通过（100%）**，达标线 95%。
- FR-17..20 未实现，单列为已知缺陷，不计入通过率。

### 变更
- 文档与代码版本对齐（此前文档停留在 0.2.0）。

### 已知问题
- FR-17..20 未实现（向量/图/冲突/做梦），按缺陷单列。

## [0.4.0] — 2026-11-14

### 新增
- `session/event` 自动捕获（FR-04/05）。
- `systemPrompt.section` 常驻注入（FR-09/10），1200 字预算 + 30 秒缓存 + 写入即失效。

## [0.3.0] — 2026-11-14

### 变更
- 界面从 `conversation.view` 迁到 `sidebar.panellist` + `main`（ADR-005）。
- 增加插件详情文档入口。

## [0.2.0] — 2026-11-14

### 新增
- 3 条 loopback HTTP 路由与「记忆」界面（浏览/搜索/遗忘）。

## [0.1.0] — 2026-11-14

### 新增
- SQLite schema（chunks/notes/facts/entities/edges/meta）+ FTS5 trigram。
- 5 个模型工具：write / search / profile / timeline / forget。
- 中文二元切分与分层打分。
