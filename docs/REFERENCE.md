# 全息记忆 · 机理与接口参考

> 版本 4.1.1 · 生成日期 2026-11-24 · 依据源码与真实 schema v17 核对
>
> **给 AI 的用法**：这份文档按「先原理、后接口、最后剧本」组织。第一次接触时读第 1、2、9 章即可开工；要精确调用某个工具，直接跳到第 9 章对应小节。若这份文档已同步进记忆库（`omni memory:sync`），也可以先用 `memory_search` 搜"全息记忆 接口"定位。

---

## 1. 系统全貌

### 1.1 一句话

一个本地长期记忆内核：**只增不改的原文留底 + 会自我校验的结论 + 按项目分层 + 三路混合召回 + 可复用的故障经验沉淀**。

### 1.2 三层结构

```
宿主（DSH / MCP 客户端 / CLI / 浏览器）
        │
   适配层 hosts/          薄壳：把宿主接口翻译成 ctx
        │
   内核 index.js           记忆的全部语义都在这里，不认识任何宿主
        │
   SQLite（omni.db）        单文件、本地、可备份
```

- **内核**：schema、写入、检索、事实、实体图、画像、dream、备份。只依赖 `node:sqlite`、`node:crypto`、`node:fs`、`node:os`、`node:path`，加上自有的 `lib/embed*.mjs`、`lib/semantic-embed.mjs` 与 `lib/vendor/` 内的 ONNX Runtime / tokenizers WASM。
- **适配层**：`hosts/shared/headless.mjs` 提供最小宿主上下文；`hosts/mcp/`、`hosts/http/`、`hosts/cli.mjs` 各自只写传输代码。
- **宿主**：DSH 插件（`apply(ctx)`）、MCP stdio、MCP over HTTP、REST、CLI。

### 1.3 进程与数据

| 形态 | 入口 | 数据 |
|---|---|---|
| DSH 插件 | `index.js` 的 `apply(ctx)` | `$DSH_HOME/memory/omni.db` |
| MCP stdio | `hosts/mcp/bin.mjs` | 同上（`OMNI_HOME` 可覆盖） |
| HTTP 面板 / REST / HTTP MCP | `hosts/cli.mjs serve` | 同上，**同一个库** |
| CLI | `hosts/cli.mjs <命令>` | 同上 |

同一个 `OMNI_HOME`（或同一个 `DSH_HOME`）意味着**所有宿主共享一份记忆**，不是各存各的。这也是本项目的核心卖点。

### 1.4 数据目录优先级

1. `OMNI_HOME`——非 DSH 宿主显式指定
2. `DSH_HOME`——兼容已有 DSH 安装
3. `~/.dsh`——历史默认

库文件固定为 `<home>/memory/omni.db`。

---

## 2. 生命周期：一条记忆的完整旅程

### 2.1 写入

```
memory_write(kind, text, scope?)
  → decideScope()        决定落哪一层
  → 去重检查              同层同内容跳过（返回 deduped=true）
  → 落库                  note / fact / chunk
  → 派生                  facts 自动生成 entities + edges；notes/chunks/facts 生成向量与本地语义向量
```

三种 `kind`：

- `note`：**结论**。项目约定、踩坑经验、用户偏好、可复用解法。这是最该写的一种。
- `fact`：**事实三元组**。`subject / relation / object`，带双时态。
- `episode`：**原始观察**。一般由宿主事件流自动产生，手工写较少。

### 2.2 分层判定（`decideScope`）

优先级从高到低：

1. 显式 `scope`（`global` 或 `proj:*`）；传 `all` 会被拒绝，因为 `all` 只读。
2. 文本命中**强全局提示词**（用户偏好、跨项目、所有项目、以后所有、今后所有、一律、永远、铁律、禁止、不要再、宁可不）→ `global`；弱全局词（偏好、习惯、以后、总是、通用）只在没有项目提示词时生效。
3. 文本命中**项目提示词** → 当前项目层。项目提示词包括：本项目、这个项目、本仓库、src/、docs/、package.json、.mjs、.ts、.js、构建、部署、迁移、表结构、字段，以及项目名、CLI、search/write/context、scope、proj:、note#、盘符路径。
4. 都没命中 → 落到当前项目层（`default-to-project`）。
5. 没有项目信息 → `global`。

CLI 的 `--dir` 不是提示词，而是硬绑定：给了 `--dir` 且没给 `--scope` 时，`write` / `ingest` / `candidates` / `consolidate` 直接写该项目层；要写全局规则必须显式 `--scope global`。这样“项目审计”不会因为出现“偏好/规则”被误抬到 global。

设计取向：**宁可把该升级为全局的规则先留在项目层，也不让项目细节泄漏到全局**。项目层的东西以后好找，泄漏出去的收不回来。

`scope` 是同一用户本机数据的命名空间，不是权限边界：只要调用方（本机 CLI、loopback HTTP、DSH 工具）能给出精确 `proj:*` 键，就允许读该层；写工具也接受显式项目键，因为新工作区必须先能创建自己。跨层 `scope=all` 只允许读，或在 `memory_amend` / HTTP 写操作中显式请求并留下 `meta.audit:cross-scope` 审计；HTTP 写还要求 loopback + CSRF。项目键不是秘密，不要把它当认证令牌。

### 2.3 项目键

仓库根可以放一个 `.omni-project` 文件声明稳定身份：

```json
{"key":"proj:全息记忆#30534c","name":"全息记忆"}
```

有文件时优先用它，路径哈希只作为旧仓库的 fallback。这样同一个仓库通过 `D:\...`、`C:\...`、大写盘符或不同 shell 进入，都落到同一个项目层，不再产生第二份键。

没有文件时仍按路径生成：

```
proj:<目录名（截 40 字符，非法字符转 -）>#<路径 FNV-1a 哈希前 6 位>
```

Windows 与 macOS 在哈希前把规范化路径转小写，Linux 保留大小写；因此同一工作区在这些平台上不因大小写分裂。

例：`D:\xiangmu\全息记忆` 的旧路径键是 `proj:全息记忆#deff23`；仓库根 `.omni-project` 把稳定键钉在 `proj:全息记忆#30534c`。首次打开时 schema v15 的 `scope_aliases` 仍会把旧键迁到 canonical 键；迁移只针对由完整路径可确定的键，不按目录名猜测合并。

没有留下 `project_path` 的旧键不会被自动猜测合并；确认两个 scope 属于同一项目后，用 CLI 显式补：

```powershell
omni scope-alias --from proj:旧名#旧哈希 --to proj:新名#新哈希 --apply
omni scope-alias --list
```

默认只预览 `fromHasRows` / `toHasRows` 与将写入的映射；`--apply` 才会在事务内迁移 notes/facts/chunks/note_candidates/edges 与 `agent_project`。不要用它合并同名不同盘的项目。

3.10.2 起，`--apply` 和启动自愈都按**字面旧键**迁移（`migrateScopeAlias(..., { literal: true })`），不会先把旧键解析成 canonical 后误判为 `source === target`。所有入口（转录 scope、候选、agent/session、`/packet`、自动召回）统一走 `resolveProjectKey()`，旧键写操作不会再制造新的分裂行。升级后第一次 `openStore()` 会运行 `repairScopeAliases()`：alias 已记录但行仍在旧键时自动迁移；成功写 `scope_alias_repair_version='1'`，失败留 `scope_alias_repair_last_error` / `scope_alias_repair_failed_at` 并下次重试。

同名目录靠哈希区分，所以两个不同路径的同名项目不会串层。宿主通过"工作目录"推导，DSH 用 `session.header.cwd`，MCP/HTTP 用 `OMNI_PROJECT_DIR`；CLI 未显式 `--dir` 时先向上查找 `.omni-project`，再回落到 CLI 所在仓库根。落库时同时写入 `meta.agent_project:<sessionId>` 与 `meta.project_path:<scope>`，重启后仍能恢复。

### 2.4 事实的冲突与时效

同一 `subject + relation` 在同一层出现新值：

- `cardinality=single`（默认）：旧值 `valid_to` 置为当前时间——**失效但不删除**，历史仍可审计。
- `cardinality=multi`：多个值并存。
- 层的边界严格：项目层写新值不会让全局旧值失效，反之亦然。

`facts` 的 `valid_from / valid_to` 就是双时态里的"世界时间"，`recorded_at` 是"记录时间"。

### 2.5 笔记的修订与争议

- 同层同文本 → 去重，不新建。
- 近重复 → 自动标 `contested`（只标记，不删除、不合并）。
- 显式 `contradicts: [旧id]` → 新旧双方都标 contested，等人复核。
- 替代（supersede）只由 dream 的单条确认产生，旧笔记保留、`superseded_by` 指向新笔记。
- 删除一律是墓碑：`deleted_at` 有值，行还在，`memory_restore` 可复活。

### 2.6 故障经验闭环

`note` 可带四个经验字段：

| 字段 | 含义 |
|---|---|
| `problemKey` | 问题指纹。大小写不敏感、空白归一化。命中它就能精确找回 |
| `solutionStatus` | `verified` / `unverified` / `failed` / `expired` |
| `evidence` | 证明状态的东西：命令输出、测试结果、URL |
| `reuseCount` / `lastUsedAt` | 复用统计，由 `memory_solution_report` 维护 |

沉淀一条解法时的标准写法：

```
症状：npm test 在 Node 22 上 ENOENT，找不到 xyz.mjs
失败尝试：升级依赖、清 node_modules 都无效
有效解法：test 脚本改成 node --test "test/*.test.mjs"，让 glob 由 shell 展开
前提：Windows + PowerShell 7；bash 下不需要
problemKey: npm test ENOENT on node 22
solutionStatus: verified
evidence: npm test → 242/242 passed
```

### 2.7 检索

三路并行，然后在融合层合并：

1. **词面**：SQLite FTS5（trigram）＋中文二元索引（`bigrams` 表，逐字切 2 字组合）。
2. **向量**：默认 512 维字符 n-gram 哈希向量（零依赖、离线可用）；配置 `OMNI_EMBED_URL` 后这一路改走远程真语义嵌入，维度持久化在 `meta`，换模型会触发回填。
3. **本地语义**：包内 `BAAI/bge-small-zh-v1.5` int8 ONNX + ONNX Runtime WASM，512 维，进程内 CPU；查询加 BGE 指令前缀，阈值 0.25；与 hashed 向量分表存放，互不混算。旧库按 `semantic-backfill` 跨进程租约分批回填，租约 TTL 120 秒并按批续租；已索引库启动时不加载模型。
4. **图**：从 `facts` 生成的 `entities` + `edges`，做 2 跳关联召回。
四路排名用 RRF 融合（词面 1 / hashed 或远程 1 / 本地语义 2 / 图 0.5）；命中项分别带 `lexicalScore`、`vectorScore`、`semanticScore`、`rrf`。

融合用 RRF（Reciprocal Rank Fusion，`K=60`），再叠加重要性、problemKey 精确命中、状态修正。候选池按 `limit × 4` 取，避免小样本抖动。

检索结果默认过滤掉：已删除、被替代、已失效、contested（画像与自动召回尤其严格），以及 `failed` / `expired` 的经验。

`problemKey` 有独立索引，精确命中优先，`verified` 排在 `unverified` 之前，`failed` 保留可见但排后。

### 2.8 注入

DSH 内：

- 每轮从 `agent/inbox/claimed` 拿到用户消息，预取 top-3，缓 120 秒。
- `systemPrompt.section` 每次装配时输出：persona + 常驻画像（预算 1200 字符，缓存 30 秒）+ 本次预召回 3 条 + 当前项目提示。
- 预算超了就砍召回，先保画像。

DSH 外（MCP 等）：没有注入点，改为 `memory_context` 显式调用，语义等价。

### 2.9 治理

- `memory_forget`：墓碑单条。
- `memory_restore`：复活单条。
- `memory_compact`：把超出保留量的最老转录墓碑化（默认留 5000，最小 50）。
- `memory_dream`：拿原文核对笔记，结论"与原文矛盾"的只标 contested；`commit=true` 才替代。
- `memory_export` / `memory_import`：可移植 JSON，默认含墓碑；导入按内容去重、默认 dry-run。
- `memory_reindex`：hashed/远程向量回填、本地语义回填、bigram 全量重建。

---

## 3. 数据模型（schema v17，实测）

共 13 张业务表（不含 FTS 影子表）。字段按真实 `PRAGMA table_info` 导出。

### 3.1 meta
`key`(pk), `value`
键值元数据：`schema_version`、`agent_project:<id>`、嵌入维度等。

### 3.2 chunks（原文转录）
`id`(pk), `ts`, `session_id`, `role`, `text`, `hash`, `source`, `importance`, `deleted_at`, `scope`
唯一索引 `chunks_hash_active(hash, scope) WHERE deleted_at IS NULL`——同一层同内容只留一份。单条入库上限 4000 字符。

### 3.3 notes（结论）
`id`(pk), `ts`, `scope`, `text`, `text_hash`, `importance`, `source`, `revision`, `superseded_by`, `contested`, `deleted_at`, `problem_key`, `solution_status`, `solution_verified_at`, `reuse_count`, `last_used_at`, `verified_at`, `verification`, `evidence`, `recall_count`, `last_recall_at`, `useful_count`, `misleading_count`

`text_hash` 是 `sha256(text)` 前 32 位十六进制，索引 `notes_scope_text_hash(scope, text_hash)`。去重查询同时比对 `text`，哈希碰撞不会合并不同笔记；旧库 v17 迁移按 1000 行/批回填 NULL，并用 `notes_text_hash_missing(id) WHERE text_hash IS NULL` 部分索引让稳态缺失探针保持 O(1)，失败重开可续跑。

`scope` 为 NOT NULL，因此项目查询不把 NULL 当 global；`facts` / `chunks` / `edges` 的历史列允许 NULL，只有这些旧行按 `global` 兼容可见。这个口径由 `scopeClause(..., nulls)` 显式表达，不靠查询条件隐式决定。

### 3.4 facts（事实）
`id`(pk), `subject`, `relation`, `object`, `text`, `valid_from`, `valid_to`, `recorded_at`, `confidence`, `source`, `contested`, `deleted_at`, `scope`, `cardinality`

### 3.5 entities / edges（实体图）
- `entities`: `id`, `name`, `kind`
- `edges`: `id`, `src`, `rel`, `dst`, `valid_from`, `valid_to`, `scope`, `source`

`edges` 由 `facts` 派生，事实失效时对应边同步失效。

### 3.6 relations（关系基数登记）
`name`(pk), `cardinality`, `aliases`, `updated_at`

### 3.7 entity_aliases（实体别名）
`alias`(pk), `canonical`, `updated_at`

### 3.8 persona（用户设定）
`key`(pk), `value`, `updated_at`。总长度上限 4000 字符。

### 3.9 vectors（派生向量）
`kind`(pk), `owner_id`(pk), `dim`, `vec`。`kind` 区分 note / chunk / fact。

### 3.10 semantic_vectors（本地语义向量）
`kind`(pk), `owner_id`(pk), `model`(pk), `dim`, `vec`。`model` 是签名 `local:bge-small-zh-v1.5:int8:512`；与 `vectors` 分开，避免 512 维 hashed 与 512 维 BGE 混算。索引 `semantic_vectors_model(model)`。

### 3.11 bigrams（中文二元索引）
`layer`(pk), `owner_id`(pk), `gram`(pk)，索引 `bigrams_gram(gram, layer, owner_id)`。

### 3.12 FTS 影子表
`notes_fts`、`facts_fts`、`chunks_fts` 及 SQLite 内部表。由触发器/回填维护，不要手写。

### 3.13 scope_aliases（项目键别名）
`alias`(pk), `canonical`, `created_at`，索引 `scope_aliases_canonical(canonical)`。记录旧的项目 scope 键到 canonical 键的映射；只用于跨平台路径大小写归一与显式运维迁移，不改变笔记的可见性规则。`canonical` 本身仍遵循 `proj:<basename>#<hash>` 格式。

---

## 4. 宿主适配机理

### 4.1 契约只有四个必选接口

`apply(ctx)` 实际调用：

| 接口 | 用途 | 适配层实现 |
|---|---|---|
| `ctx.tools.register(def)` | 注册工具，返回释放函数 | 存入 Map |
| `ctx.effect(fn)` | 启动副作用，返回释放函数 | 立即执行并记录释放器 |
| `ctx.on(event, handler)` | 订阅宿主事件 | 无事件流时返回 undefined（内核按 no-op 处理） |
| `ctx.get(service)` | 取服务：`llm` / `systemPrompt` / `webServer` | 由调用方注入，缺省 undefined 即优雅降级 |
| `ctx.inject(names, callback)` | 等可选服务就绪后再注册 | DSH 冷启动时 `webServer` / `systemPrompt` 可能晚于插件激活；回调参数可能是宿主 context，也可能是服务对象 |

可选服务：`llm`（模型复核、persona 提炼）、`systemPrompt`（DSH 注入）、`webServer`（挂 REST 路由）。

3.10.2 起路由和画像 section 不再只做一次 `ctx.get()`：有 `ctx.inject` 时等待服务就绪，没有 `inject` 的轻量测试宿主回退到一次立即注册；`/omni-memory/status` 的 `routes` 会显示 `pending/registered/disposed`、注册数量和最后错误，画像注入失败也会记录到 `lastInjection.routes`。3.10.3 起发布包同时包含 `ctx.inject` 之后的 250ms 轮询（最多 60s）：`not ready at apply` 不再等于放弃，真实 DSH 冷启动会继续尝试注册。

### 4.2 启动顺序（重要）

`index.js` 在被 import 时就解析数据目录。所以适配器必须**先设好环境变量，再动态 import**。`hosts/shared/boot.mjs` 已经封装好这个顺序。

### 4.3 非 DSH 宿主的作用域登记

`attachSession(sessionId, cwd)`：

- 写入 `cwdBySession`（内存）与 `projectByAgent`（内存）；
- 持久化 `meta.agent_project:<sessionId>`；
- 返回解析出的 `proj:*` 键。

MCP 的 sessionId 默认是 `host-<工作目录哈希>`，稳定可复现；同目录再次启动会命中同一层。

### 4.4 规则的五条通道

MCP 无法写客户端系统提示，所以同一份 `RULES_TEXT` 铺五条路：

1. `initialize.instructions`
2. `prompts/get` 的 `omni-bootstrap`（可带 task）
3. `resources/read` `omni://rules`
4. 工具 `memory_rules`
5. `omni rules --write` 写入项目规则文件的托管区块

托管区块带标记，幂等：

```
<!-- omni-memory:rules v1 start · 由全息记忆维护，区块内容会被覆盖，请勿手改 -->
...
<!-- omni-memory:rules v1 end -->
```

### 4.5 多进程并发（同一台机器、多个 AI 客户端）

典型场景：一个人同时开 Claude Code、Cursor、Codex、本面板与 CLI，每个客户端各拉起一份服务进程，全部指向同一个 `omni.db`。

| 机制 | 实现 | 原因 |
|---|---|---|
| 等锁 | `PRAGMA busy_timeout`（默认 5000ms，`OMNI_BUSY_TIMEOUT_MS`） | 默认拿不到写锁立刻 `SQLITE_BUSY`，第二个窗口会偶发「database is locked」 |
| 写事务 | 一律 `BEGIN IMMEDIATE` | 进入即抢写锁，避免读后升级写造成死锁 |
| 去重 | 笔记 `(scope,text)`、转录 `(hash,scope)`、事实 `(subject,relation,scope)` 在写锁内复查 | 事务外检查会让两个进程各插一条相同内容 |
| 维护租约 | `meta` 的 `lease:open-maintenance`（120s）与 `lease:dream`（一个间隔） | 启动迁移、索引回填、定时做梦全机只跑一份，不然 N 个进程同时全量扫描 |
| WAL 上限 | `journal_size_limit = 16MB` | 多读者持有快照时 WAL 不会无限增长 |

写仍是串行的：SQLite 单写者。写入是毫秒级，正常排队很短；等待超过 `busy_timeout` 才报错。画像缓存 30s 是**每进程独立**的，要即时一致就调 `memory_context`。

---

## 5. 工具参考（23 个内核工具）

MCP / HTTP 适配器在启动时会额外注册 `memory_context` 与 `memory_rules`；因此真实 `tools/list` 返回 **25 个 MCP 工具**，而插件内核本身仍是 23 个 `memory_*` 工具。

所有工具都是"失败即报错、成功即返回值"；MCP 侧错误统一转成 `isError: true` 的文本块。

### 5.1 memory_context（建议每次会话第一个调）
参数：
- `query` string，当前任务原文（用户请求、报错、路径）。首轮可省略，只拿画像。
- `scope` string，可选；省略则用当前项目层 + global。
- `limit` number，默认 5，最大 10。

返回：`text`（用户设定 + 常驻画像 + 相关记忆 + 风险提示；发现云端新版本时，`text` 顶部先出现 `## 版本提醒（需用户确认）`），`hits`（召回条数），`update`（有更新时为 `{localVersion, remoteVersion, checkedAt, source}`，否则 `null`）。

版本检查在读取时自动触发：成功缓存 30 分钟，失败缓存 5 分钟，Contents API 与 raw 回退共享 2.5 秒总预算；并发读取用进程间单飞锁只发一次请求；GitHub 不可达不会阻塞记忆读取。它只负责告诉模型，不自动改代码、不重启服务；是否更新由用户决定，用户确认后才运行 `scripts/daily-sync.mjs --apply`。

### 5.2 memory_rules
参数：无。返回工作规则全文。

### 5.3 memory_write
参数：
- `kind` string，必填，`note|fact|episode`
- `text` string，note/episode 必填；fact 给了完整三元组时可省；note 上限 4000 字（超长会报错要求拆分）
- `scope` string，可选；`all` 会被拒绝；写入未出现过的项目层会返回 `scopeNew:true` 提醒
- `importance` number，0..1，默认 0.35；越界或非数字直接报错
- `source` string，可选，如 `session:xxx#3` 或文件路径
- fact 专用：`subject`（必填）、`relation`（默认 `is`）、`object`、`cardinality`（`single|multi`）
- note 专用：`contradicts`（number[]，旧笔记 id；无法解析的 id 会出现在 `contradictsIgnored`）、`problemKey`、`solutionStatus`（`verified|unverified|failed|expired`）、`evidence`

返回：`id`、`kind`、`scope`、`scopeReason`、`deduped`、`contradictsIgnored`（如有）、`scopeNew`（如有）。

### 5.4 memory_search
参数：
- `query` string，关键词/实体/路径/原话；给了 `problemKey` 时可省
- `problemKey` string，精确问题指纹
- `status` string，`all|verified|unverified|failed|expired`，默认 all
- `kind` string，`all|note|fact|chunk`，默认 all
- `limit` number，默认 8，1..30；非数字或越界直接报错，不再静默返回空结果
- `offset` number，默认 0，0..100；跳过前面已排序的候选，用于分页
- `cwd` string，可选；按工作目录解析项目层，CLI `--dir` 用它
- `scope` string，可选；`all` 表示跨所有项目

返回：`total`、`returned`、`offset`、`truncated`、`scope`、`problemKey`、`hits[]`（含完整的 `text`、`snippet`、`matchedTerms`、`score`、`why`、`recencyBoost`、可选 `staleVersion`，以及 kind/id/scope/contested/solutionStatus）。文本不再按 400 字硬截；分页用 `offset`，`truncated` 表示当前页之后还有候选。命中排序会给近期笔记很小的时间加权，并把带旧产品版本号的结论标记为 `staleVersion`、轻微降权；旧结论仍可检索，但不会盖过当前版本。

### 5.5 memory_solution_report
参数：
- `id` number，必填
- `outcome` string，必填，`success|failed|expired`
- `evidence` string，可选

作用：`success` 标 verified 并累加 `reuseCount`；`failed`/`expired` 记死路。调用时机是"结果已知之后"，不是写入时。

### 5.6 memory_profile
参数：`scope` 可选。返回常驻画像文本（预算 1200 字符）与存储统计。画像只收用户规则、项目结论与稳定设置；`专业知识/`、知识库、测试/审计/部署报告和工具清单不进入预算。跨项目部分按 `文档版本` 分层显示；项目技术笔记可被检索，但不会自动变成用户偏好。

### 5.7 memory_persona
参数：
- `action` string，必填，`get|set|refresh`
- `values` object，set 专用；空值删除条目，总长 4000 字符。HTTP 侧要求非空 JSON body（或 `values` 查询参数），body 上限 64KB；清空必须显式传 `action=clear`，非法/超长 body 返回 400/413 且不改动已有画像。
- `apply` boolean，refresh 专用，默认 true
- `useModel` boolean，refresh 专用，默认 false（只用离线规则）

### 5.8 memory_timeline
参数：`entity` 必填、`scope` 可选。返回该实体的有效区间事实与提及它的笔记。

### 5.9 memory_link_entity
参数：`alias` 必填、`canonical` 必填、`apply` boolean（默认 false 演练）。把别名下的 facts/edges 并入规范名。

### 5.10 memory_forget
参数：`kind`（`note|fact|chunk`）、`id`，均必填。墓碑化，可恢复。返回 `forgotten`；不存在或已墓碑时返回 `forgotten:false` 与 `reason`，与 `memory_restore` 的失败形状一致。

### 5.11 memory_restore
参数：`kind`、`id`，均必填。复活墓碑。

### 5.12 memory_compact
参数：`keepChunks` number（默认 5000，最小 50）、`apply` boolean（默认 false）。把最老的转录墓碑化。只对捕获过会话流的宿主有意义；纯 MCP 宿主无转录时返回 `total:0`，是空操作。

### 5.13 memory_dream
参数：`apply` boolean（默认 false，只报告）、`commit` boolean（仅配合 apply，直接替代）。用原文核对笔记，只标 contested，替代需另走 `memory_dream_replace`。需要会话流与 LLM；纯 MCP 宿主返回 `no_source`。

### 5.14 memory_dream_proposals
参数：`limit` number（默认 50，最大 200）。列出待替代候选与证据文本。

### 5.15 memory_dream_replace
参数：`noteId` number、`confirm` boolean（必须 true）。旧笔记被替代但保留，可回滚。

### 5.16 memory_dream_rollback
参数：`noteId` number（原笔记 id）。撤销 dream 替代。

### 5.17 memory_export
参数：`path` string（可选，**单个 basename、必须以 `.json` 结尾**，不允许绝对路径/目录分隔符/`..`；默认写到 `$OMNI_HOME/memory/backups/omni-backup-<时间戳>.json`，已存在同名文件时拒绝覆盖）、`activeOnly` boolean（默认 false，含墓碑与全部候选；true 时只导活跃行和 pending 候选）。向量是派生数据，不导出。

### 5.18 memory_import
参数：`path` 必填（同样只接受 `$OMNI_HOME/memory/backups/` 下的单个 `.json` basename，最大 64 MiB）、`dryRun` boolean（默认 true）。按内容去重合并；导入前先校验所有数值字段与枚举，非法数值直接拒绝，不进入写库阶段。`verification` / `solution_status` 只接受白名单值，`superseded_by` 只映射到本次导入的新 id，映射不到时置空。

### 5.19 memory_reindex
参数：`limit` number（默认 200，最大 1000）、`bigrams` boolean、`vectors` boolean、`semantic` boolean、`semanticForce` boolean。换嵌入模型、恢复旧库或模型升级后使用。`semantic=true` 只跑本地语义回填（`backend:"local"`，返回 `{processed,pending,backfillDone,forced,...}`）；`semanticForce=true` 需与 `semantic=true` 同用，先删除当前模型签名再按源文本重建，用于修复陈旧向量；`semantic=true, vectors=true` 同时跑两套向量。顶层 `processed` 只表示**当前向量后端实际写入的行数**，语义回填数量另见 `semantic.processed`；两套同时运行时不把两个口径相加，避免把“条目”和“向量行”混成同一个数字。`bigrams=true` 单独触发中文二元索引全量重建。

### 5.20 memory_feedback
参数：`kind`（`note|fact`）、`id`、`rating`（`useful|misleading`），均必填。写入召回质量投票；`memory_search` 命中项返回 `usefulCount`、`misleadingCount`、`feedbackCount`、`lastFeedbackAt`、`quality`，排序使用 Bayesian 平滑后的反馈分。

### 5.21 memory_get
参数：`items`（最多 20 个 `{kind,id}`）、`scope` 可选。渐进披露：`memory_search` 只给片段，命中后用本工具取完整正文与全部审计字段。默认当前项目层 + global；跨全部项目需显式 `scope=all`。

### 5.22 memory_amend
参数：`id`（note）、`text`（新正文），可选 `reason`、`scope`（`all` 用于显式跨项目）。默认仅当前项目 + global。生成新 revision，旧行 `superseded_by` 指向新行并保留；搜索只返回新行，`memory_get` 取不到旧行。修订透传 `contested`、`verification`、反馈计数与原始 `source`；`reason` 以 `[amend]` 追加进 `evidence`。

### 5.23 memory_ingest
参数：`text` 必填；可选 `role`（user/assistant/system/tool/note）、`scope`、`sessionId`、`source`、`cwd`、`importance`、`extract`（默认 true）。
作用：把一条对话轮次写入 chunks，并按 `lib/capture-rules.mjs` 的确定性规则抽取最多 3 条 pending 候选。`scope=all` 拒写；正文超过 4000 字截断；候选绝不直接成为 note。返回 `{id,deduped,scope,sessionId,chars,truncated,candidates[]}`。

### 5.24 memory_candidate
参数：`action`（`list|accept|reject`）、`id`（accept/reject 必填）、`status`（list；默认 pending）、`scope`、`cwd`、`limit`、`reason`。
作用：候选审阅。`accept` 才写入正式 note（`source: chunk:<id> · candidate:<id>`，自动去重）；`reject` 只标记并保留原因。默认当前项目 + global，跨项目需 `scope=all`。

### 5.25 memory_consolidate
参数：`problemKey` 必填；`scope`、`minNotes`（2..10，默认 2）、`apply`（默认 false）。
作用：同一 `problemKey` + 同一精确 scope 的活跃笔记压成一条来源链摘要；默认 dry-run。`apply` 时按 `[已验证]/[未验证]/[失败尝试]/[已过期]` 分组，旧行只写 `superseded_by`，不删除；反馈计数汇总到摘要。`scope=all/project` 被拒绝。

---

## 6. REST 接口（21 条）

统一前缀 `/omni-memory`，默认只听回环。写操作要求 `POST` 且同源（有 `Origin` 时必须与 Host 一致）；不带 `Origin` 的本地客户端放行。

`POST /mcp` 与 REST 同级防护：跨站 `Origin` 直接 403；没有 `Origin` 时必须 `Content-Type: application/json` 或带 `x-omni-csrf: 1`。跨站表单只能发 `text/plain`，因此无法借此写入。

| 路径 | 方法 | 参数 | 说明 |
|---|---|---|---|
| `/list` | GET | `limit` `offset` `scope` `audit` | 记忆列表 + 统计 + 项目目录；`audit=1` 含墓碑与被替代 |
| `/overview` | GET | `range`（`4w`/`6w`/`12w`/`26w`，默认 `12w`）`scope` | 网页概览用真实聚合：`version` / `stats` / `health` / `series` / `daily` / `projects` / `profile` / `activity` / `graph`；不返回全文 |
| `/graph` | GET | `scope` | 星图：`nodes[]`、`links[]`（`source/target/rel`）、`scopes[]` |
| `/node` | GET | `node` `scope` | 单实体详情与关联事实 |
| `/persona` | GET/POST | body `values`（≤64KB），清空显式 `action=clear` | 读/写用户设定；空/非法 body 返回 400，不静默清空 |
| `/persona/refresh` | POST | `dryRun` `model` | 从近期全局记忆提炼 |
| `/dream/proposals` | GET | `limit` | 待替代候选 |
| `/dream/replace` | POST | `noteId` | 确认替代 |
| `/dream/rollback` | POST | `noteId` | 撤销替代 |
| `/export` | GET | `activeOnly` `download` | 备份；`download=1` 走附件下载 |
| `/restore` | POST | `kind` `id` `scope` | 复活墓碑；同 key 已有 active 值/同文本 active 笔记时返回 `restored:false` 与 `activeId`，不制造双活 |
| `/status` | GET | — | 运行态：`version`（来自 `package.json`）、注入统计、嵌入后端、`routes`（pending/registered/disposed、count、lastError）、`aliasRepair`、`aliasMigration`；`embedding.dropped` / `lastDropAt` 与 `semantic.gcError` / `gcFailedAt` 可观测队列丢弃和启动 GC 失败 |
| `/search` | GET | `q` `limit` `scope` | 混合检索 |
| `/packet` | GET | `q` `scope` `cwd` `limit` `budget` `format` | 无 MCP 宿主的可注入记忆包；`cwd` 先走 `resolveProjectKey()`（3.10.2 起），`format=text` 直接输出纯文本；有云端新版本时 `text` 顶部带版本提醒，JSON 含 `update` |
| `/openapi.json` | GET | — | HTTP adapter 的 OpenAPI 3.0 描述（packet/search/list/node/status/tool） |
| `/tool` | POST | body `name` `arguments`；header `x-omni-csrf: 1` | 受限工具桥：write/search/solution_report/feedback/get/amend/profile/timeline |
| `/ingest` | POST | `text` 必填；`role` `scope` `cwd` `sessionId` `source` `importance` `extract`；body 上限 64KB（长中文走 JSON body，不塞 URL） | 写转录 + 抽取 pending 候选；超限返回 413 |
| `/candidates` | GET | `status` `scope` `cwd` `limit` | 列出候选 |
| `/candidate` | POST | `id` `action` `scope` `cwd` `reason` | 接受/拒绝候选 |
| `/consolidate` | POST | `problemKey` `scope` `minNotes` `apply` | 按问题指纹巩固笔记 |
| `/forget` | POST | `kind` `id`（body 或 query） | 墓碑化 |

响应统一带 `ok`。错误为 `{ ok: false, error }`。

`GET /metrics` 是服务级只读指标，不属于 21 条插件 REST 路由：返回 `uptimeSeconds`、`requests`、`errors`、`mcpRequests`、`mcpMessages`、`tools`、`routes` 与 `process.memoryUsage()` 的 RSS/heap。和 `/health` 一样只接受 loopback，非回环请求 403；不包含记忆正文、查询或凭据。

静态入口挂在 `GET /`、`GET /hub`、`GET /m`，三者都只允许 loopback：

- `/`：原有完整仪表盘（KPI、健康度、增长、项目、热力图、画像、活跃带、星图、动态）。
- `/hub`：本机记忆档案索引。横向非等宽索引行（记忆库 / 检索 / 关系图 / 项目 / 接入 / 状态），数字来自 `/omni-memory/overview` 与 `/health`；搜索框跳转 `/panel.html?q=`。视觉是墨色底稿，不是六卡网格。
- `/m`：竖屏只读手机端，纸质底稿式最近归档 + `/omni-memory/search` 搜索；顶部一行档案读数（活跃/健康/工具），不提供写入入口。

`/hub` 与 `/m` 是无扩展名的 pretty-path，由 `hosts/http/server.mjs` 的 `STATIC_ALIASES` 映射到 `hub.html` / `m.html`，不是新增 REST 路由。星图默认读 `scope=all`，四旋臂三维投影（移植客户端 `MemoryGraph`），自动旋转、拖拽旋转、滚轮缩放、点选节点查详情；`/?tab=map` 可直接打开星图页签。

### 6.1 版本可见、读取提醒与每日同步

当前版本在四处可见：面板顶栏 `vX.Y.Z`、`GET /health.version`、`GET /omni-memory/status.version`、`GET /omni-memory/overview.version`。`/health` 便于脚本探测，`/status` 与 `/overview` 便于面板和 AI 读取；历史版本看 GitHub Releases。

`memory_context`、CLI `context` 和 `/omni-memory/packet` 在读取时会调用 `lib/version-check.mjs`：读取 GitHub contents API 的 `main/package.json`，失败回退 raw CDN；发现远端更高时，在返回文本顶部插入 `## 版本提醒（需用户确认）`，并把 `update` 字段放进 JSON。成功检查缓存 30 分钟，失败缓存 5 分钟，两段网络共享 2.5 秒总预算；缓存回读会校验版本结构与 TTL，失败不保留旧远端版本；并发读取用进程间单飞锁只发一次请求。`OMNI_VERSION_CHECK_DISABLED=1` 可关闭该检查。它只提醒，不自动更新；是否执行由用户决定。

每日同步不是常驻服务，而是按需脚本：

```bash
node scripts/daily-sync.mjs            # 只报告 update-available / up-to-date，不合并、不重启
node scripts/daily-sync.mjs --apply    # 验签后更新到签名提交；默认不重启
node scripts/daily-sync.mjs --check    # 只检查，不写状态
node scripts/daily-sync.mjs --force    # 用户确认后，强制重跑当天检查
node scripts/daily-sync.mjs --apply --restart  # 更新成功后显式重启 7788
node scripts/daily-sync.mjs --apply --run-tests # 快进后额外跑 npm test，失败回滚
```

状态文件默认 `$DSH_HOME/omni-daily-sync.json`（未设置时 `~/.dsh/omni-daily-sync.json`），按 `0600` 原子写入，记录 `lastCheckDate`、`localVersion`、`remoteVersion`、`action`、`headBefore/headAfter`、`signature`。`localDateKey()` 按用户本地日历日计算，不按 UTC；`lastCheckDate` 与本地 `YYYY-MM-DD` 相同就返回 `already-ran-today`，任何失败态都不会在当天自动重开，用户确认后要重试必须显式 `--force`。

更新顺序：默认只读 GitHub `main/package.json` 报告版本 → `--apply` 时校验包名与 `origin` 是本项目 checkout → 检查 tracked 文件干净 → 从 `v<remote>` Release 下载 `omni-update-manifest.json` → 用固定 Ed25519 公钥验签，校验 `version`、`tag`、`commit`、`package.json` SHA-256 → `git fetch`，确认签名提交在 `origin/main` 历史内 → `git merge --ff-only <签名提交>` → 对运行时 JS 执行 `node --check`（可选 `npm test`）→ 可选 `--restart` 重启 `OmniMemory7788` 并轮询 `/health`。任何一步失败都返回结构化 JSON；dirty tracked tree、无签名 Release、签名无效、包哈希不符、签名提交不在 main 历史、fetch 失败、语法/测试失败都不覆盖现有代码，校验失败会 `git reset --hard` 回到更新前提交。失败分支只探测服务，不重启；没有 `OmniMemory7788` 计划任务时返回 `service.exists=false` 和 `error`，不自动创建系统任务。

---

## 7. MCP 协议面

### 7.1 方法

- `initialize` / `notifications/initialized`
- `ping`
- `tools/list` / `tools/call`
- `prompts/list` / `prompts/get`（`omni-bootstrap`）
- `resources/list` / `resources/read`（`omni://rules`）
- `resources/templates/list`（空）
- `logging/setLevel`

协议版本支持 `2024-11-05`、`2025-03-26`、`2025-06-18`，按客户端请求回选，缺省 `2025-06-18`。
能力声明：`tools.listChanged=false`、`prompts`、`resources`（`subscribe=false`）。

### 7.2 传输

- **stdio**：一行一帧 JSON-RPC，stdout 只走协议，日志进 stderr，请求按到达顺序处理。
- **HTTP**：`POST /mcp`，JSON 响应模式；通知返回 202；响应头带 `mcp-session-id`。暂不提供 SSE 流。

### 7.3 错误契约

标准 JSON-RPC 码：`-32700` 解析、`-32600` 非法请求、`-32601` 方法不存在、`-32602` 参数错、`-32603` 内部错。
**工具执行失败不是 JSON-RPC 错误**，而是结果里的 `{ isError: true, content: [{type:'text', text:'error: ...'}] }`——这样客户端能把失败喂回模型继续处理。

---

## 8. CLI

```
node hosts/cli.mjs <命令>

rules    [--file <路径>]... [--write] [--create]
         默认预览；--write 落盘，区块幂等
context  [--dir <项目>] [--query <文本> | --stdin] [--scope <层级>] [--limit <n>]
         --stdin 读钩子传入的 JSON，取其中的 prompt / user_prompt / text
         输出纯文本上下文，供 SessionStart / UserPromptSubmit 钩子拼接
search   <关键词> | --problem-key <指纹>  [--dir <项目>] [--scope] [--status] [--kind]
         [--limit] [--offset] [--json]
         输出 matched N / showing M、分数、why、snippet；--json 返回 total/returned/offset/truncated
write    --kind note|fact|episode (--text <文本> | --stdin | --file <路径>)
         [--dir <项目>] [--scope] [--importance] [--source]
         [--problem-key] [--status] [--evidence]
         [--subject --relation --object] [--cardinality] [--contradicts <id,id>]
         给 --dir 且没给 --scope 时强制项目层；全局规则显式 --scope global
report   --id <笔记id> --outcome success|failed|expired [--evidence <证据>]
feedback --kind note|fact --id <id> --rating useful|misleading [--dir <项目>] [--scope]
         记录一次真实召回反馈；quality 排序的闭环信号
forget   --kind note|fact|chunk --id <行id>
project  show --dir <项目>
         init --dir <项目> [--name <名称>] [--key <proj键>]
         link --from <旧proj键> --to <新proj键> [--apply]
         默认预览；--apply 事务内合并历史键
scope-alias --from <旧proj键> --to <新proj键> [--apply]
         默认预览；--apply 事务内合并 scope；--list 列出已记录别名
kb-migrate [--source-prefix 专业知识/] [--from global] [--to proj:专业知识#967a81] [--apply]
         把导入的领域知识从 global 移到独立项目层；默认 dry-run
serve    [--port <端口>] [--bind <地址>]
doctor   [--home <目录>] [--port <端口>] [--task <任务名>] [--json] [--strict]
         [--skip-http] [--skip-task]
         只读诊断 Node、数据目录、SQLite 完整性、语义资产、HTTP、计划任务
mcp      以 stdio 启动 MCP（等同 hosts/mcp/bin.mjs）
```

所有命令共用 `--dir`（项目目录）与 `OMNI_*` 环境变量。`--dir` 会读取仓库根 `.omni-project` 的稳定键，并硬绑定写入层；未给 `--dir` 时先向上查找项目身份文件，找不到再用 CLI 所在仓库根，最后才用当前目录。不想要项目绑定就显式写 `--scope global`。`write` / `report` / `forget` 走的是与 MCP 完全相同的工具实现，不存在第二套写入路径。

一键安装不在 CLI 里，而是独立入口：`npm run setup:dry:release` 看计划并验签，`npm run setup` 等价于 `node scripts/install.mjs --apply --start --require-release`；它先跑 `omni doctor` 的只读 preflight，验证官方 Release 清单、签名 commit、干净工作树与启动器 SHA-256，再安装内容寻址启动器、写侧车配置，并在任务缺失时创建 `OmniMemory7788`。本地开发用 `npm run setup:dev`，只校验同提交哈希。

---

## 9. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `OMNI_HOME` | `$DSH_HOME` → `~/.dsh` | 数据根目录 |
| `OMNI_PROJECT_DIR` | 当前目录 | 项目层绑定目录（MCP/CLI/HTTP） |
| `OMNI_SESSION_ID` | `host-<哈希>` | 作用域标识 |
| `OMNI_HTTP_PORT` / `OMNI_HTTP_BIND` | `7788` / `127.0.0.1` | 面板与 HTTP MCP 监听 |
| `OMNI_BACKUP_DIR` | `$OMNI_HOME/memory/backups` | `memory_export` / `memory_import` 与迁移前备份共用的目录；迁移备份也写入这里 |
| `OMNI_MIGRATION_BACKUP` | 未设置 | `0` 关闭迁移前 `VACUUM INTO` 备份；默认开启 |
| `OMNI_MIGRATION_BACKUP_KEEP` | `5` | 保留最近几份 `pre-migrate-*.db` |
| `OMNI_MIGRATION_BACKUP_STRICT` | 未设置 | `1` 时备份失败直接阻断启动；默认只告警并继续迁移 |
| `OMNI_TRUSTED_HOSTS` | 空 | 额外允许的 HTTP `Host`（逗号分隔；回环名与绑定地址始终允许） |
| `OMNI_VERSION_CHECK_DISABLED` | 未设置 | `1` 关闭读路径版本探测，完全不访问 GitHub |
| `OMNI_VERSION_CHECK_TIMEOUT_MS` | `2500` | 版本探测总网络预算（Contents API + raw 回退共享） |
| `OMNI_VERSION_CHECK_TTL_MS` | `1800000` | 成功版本检查缓存时长 |
| `OMNI_UPDATE_SIGNING_KEY` | `~/.dsh/omni-update-signing-key.pem` | 仅发布端 `scripts/sign-release.mjs` 使用的 Ed25519 私钥路径；不要放进仓库 |
| `OMNI_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` | 未设置 | 私有仓库下载 Release 签名资产时可选；公开仓库不需要 |
| `OMNI_AUTO_RECALL` | 开 | `0` 关闭自动预召回（DSH 内有效） |
| `OMNI_PROFILE` | 未设置 | 画像预算覆盖 |
| `OMNI_SCOPE_JUDGE` | `off` | 模型复核归类：`off`/`auto`/`always` |
| `OMNI_JUDGE_PROVIDER` / `OMNI_JUDGE_MODEL` | 自动 | 复核用模型 |
| `OMNI_PERSONA_MODEL` | `off` | persona 提炼是否允许调模型 |
| `OMNI_DISABLE_SEMANTIC` | 未设置 | `1` 关闭包内本地语义 |
| `OMNI_SEMANTIC_MODEL_DIR` / `OMNI_SEMANTIC_BATCH` | 包内模型 / `8` | 本地语义模型目录与批大小 |
| `OMNI_EMBED_URL` / `OMNI_EMBED_MODEL` / `OMNI_EMBED_KEY` | 未设置 | 可选：远程语义嵌入（OpenAI 兼容），覆盖 hashed 这一路 |
| `OMNI_EMBED_PROVIDER` | 未设置 | 预设：openai/dashscope/zhipu/siliconflow |
| `OMNI_EMBED_BATCH` / `OMNI_EMBED_RETRIES` / `OMNI_EMBED_TIMEOUT_MS` | `64` / `2` / `10000` | 嵌入批处理与重试 |
| `OMNI_DREAM_INTERVAL_MS` | `0`（关） | 定时做梦校验 |
| `OMNI_BUSY_TIMEOUT_MS` | `5000` | 写锁等待上限（毫秒，上限 60000）；多客户端共用一库时调大更稳 |
| `OMNI_SEARCH_WINDOW` / `OMNI_VECTOR_SAMPLE` | 自适应：小库 20000/5000；大库 5000/1000 | 检索候选窗口与向量采样；显式设置即固定，不再自适应 |
| `OMNI_LARGE_STORE_ROWS` | `250000` | 大库阈值；先比较 `MAX(id)`，再用可召回行数确认。低于 10000 时取 10000 并打 warning |
| `OMNI_ACTIVE_COUNT_TTL_MS` | `60000` | 可召回行数缓存时间；0 表示每次判定都重新 COUNT，主要用于测试 |
| `OMNI_OPEN_LEASE_WAIT_MS` | `150000` | 打开时等待迁移租约的上限（毫秒，上限 300000）；0 表示立即失败 |
| `OMNI_DISABLE_VECTOR` / `OMNI_DISABLE_GRAPH` / `OMNI_DISABLE_SEMANTIC` | 未设置 | 诊断：关闭对应路线；`DISABLE_VECTOR` 同时关本地语义 |

---

## 10. 已知边界

- **MCP 无系统提示注入**：只能靠五条规则通道 + 主动调用 `memory_context`。
- **MCP 无事件流**：原文转录不会自动增长，只有显式写入。
- **无模型复核 / dream 定时**：非 DSH 宿主不提供 `llm`，两项能力自然关闭。
- **HTTP 无鉴权**：靠回环 + 同源校验；跨机部署前必须自己加反代与鉴权。
- **Node 22 上 `node:sqlite` 是实验特性**：可用，但会有一条已被入口屏蔽的警告；`engines` 声明 `>=22.13`，本机实测 Node 22.23.2。
- **core 未拆分**：`index.js` 仍是单体，新增宿主要走 `hosts/shared/boot.mjs`，不要再写第二套内核。
- **默认语义是本地模型**：`BAAI/bge-small-zh-v1.5` int8，随包 37.5 MiB，零配置离线；只有想换远程嵌入时才配 `OMNI_EMBED_URL` 并 `memory_reindex(vectors=true)`。本地语义用 `memory_reindex(semantic=true)`。

---

## 11. AI 调用剧本

### 11.1 新会话开场

```
memory_context(query = 用户第一条消息原文)
```
读返回的「用户设定」定语言与风格，读「相关记忆」避免重复造轮子。若返回为空，直接干活，不要为了"存点东西"而写。

### 11.2 遇到报错

```
1) memory_search(problemKey = 报错指纹)          // 精确
2) memory_search(query = 关键词 / 文件名)         // 放宽
3) 仍未命中 → 查文档、搜全网
4) 解决后 memory_write(kind=note, problemKey=..., solutionStatus=..., evidence=...)
```

### 11.3 用户陈述偏好或铁律

```
memory_write(kind=note, text="用户偏好：...", scope="global")
```
出现「以后」「所有项目」「一律」这类词，落全局；具体到某个仓库的做法，落项目层。

### 11.4 结构化事实

```
memory_write(kind=fact, subject="全息记忆", relation="数据目录", object="%DSH_HOME%\\memory\\omni.db")
```
同一 subject+relation 换值会自动失效旧值，不要手删。多值关系（如"支持"多种格式）用 `cardinality=multi`。

### 11.5 复用别人的解法之后

```
memory_solution_report(id, outcome="success"|"failed", evidence="...")
```
成功会累加复用计数并标 verified；失败让下一个人少走一趟。

### 11.6 怀疑记忆过时

```
memory_dream(apply=true)            // 只标记，不改写
memory_dream_proposals()            // 看候选
memory_dream_replace(noteId, confirm=true)   // 单条确认替代
```

### 11.7 迁移 / 换机器

```
memory_export()                                      // 默认在 $OMNI_HOME/memory/backups/ 生成时间戳文件
memory_export(path="omni-before-upgrade.json")       // 只接受备份目录内的单个 .json basename
memory_import(path="omni-before-upgrade.json", dryRun=false)
memory_reindex(bigrams=true, vectors=true)
```

---

## 12. 文件地图

```
index.js                内核 + DSH 插件入口（约 4900 行）
client.js               DSH 客户端星图（React）
lib/embed.mjs           512 维字符 n-gram 哈希向量
lib/embed-provider.mjs  远程嵌入适配
lib/semantic-embed.mjs  包内 BGE-small-zh int8 本地语义
lib/vendor/             ONNX Runtime WASM + tokenizers WASM + 许可证
models/bge-small-zh-v1.5/  int8 ONNX 权重、tokenizer、模型卡
hosts/shared/headless.mjs   最小宿主上下文
hosts/shared/boot.mjs       三个入口共用启动
hosts/shared/context-tool.mjs  memory_context
hosts/shared/rules.mjs      规则文本 + 幂等区块 + memory_rules
hosts/mcp/bin.mjs       MCP stdio 入口
hosts/mcp/server.mjs    协议内核 createProtocol + stdio 传输
hosts/http/server.mjs   面板 / REST 挂载 / HTTP MCP
hosts/http/web/         独立面板（列表/星图/规则）
hosts/cli.mjs           omni 命令行
scripts/check-docs.mjs  文档漂移闸门
scripts/check-semantic-assets.mjs  模型与运行时完整性闸门
test/*.test.mjs         289 个用例
```


