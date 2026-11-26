# ADR-032：项目代码索引作为可重建派生缓存

日期：2026-11-26 · 状态：已接受 · 版本：4.6.0

## 背景

全息记忆已经回答“为什么、历史、坑”，但无法精确回答代码问题：模块负责什么、函数在哪个文件哪一行、签名是什么、接口契约是什么、改它会波及谁。把这些塞进 note/fact 会让结论层变成代码副本，很快过期；只靠语义检索也无法稳定返回精确行号和签名。

另一个方向是把源码当唯一事实源，用一次性扫描建立结构化索引。问题在于索引一旦被当成“第二事实源”，就会与源码漂移；用户改代码后，旧签名仍被当成正确答案，比没有索引更危险。

## 决策

1. **源码权威，索引可重建**：代码索引只做派生缓存。任何结果都带 `sourceRef`、行号、`sha` 与 `stale`；用户要精确答案时回源文件核对。索引记录不标 `verified`，只标 `derived`。
2. **schema 20 五张派生表**：`code_files`、`code_symbols`、`code_apis`、`code_modules`、`code_edges`，均按 `scope` 隔离。只存路径、行号、签名、短摘要、`sourceRef`、`sha256`，**不存源码正文**，避免代码副本和隐私扩散。
3. **一条命令、增量重建**：`omni index --dir <项目>` 扫描、解析、比较 sha、替换变更文件的行、清理删除文件的行，并刷新模块快照。`full` 只用于用户显式要求丢弃缓存；日常同步必须走增量。
4. **模块发现服从仓库结构**：优先 manifest（`package.json`、`go.mod`、`Cargo.toml`、`pyproject.toml`、`pom.xml`、`build.gradle`、`pubspec.yaml`、`.csproj`）；monorepo 子包各自成模块；无 manifest 时按顶层源目录。根 package 仓库只有一个 `module:root`，不凭空制造 `module:src`。
5. **解析适配器分层**：
   - JS/TS：导出、函数、类、方法、`export {}`、`export ... from`、CommonJS、`import/require/import()`，以及 Express/Koa/Fastify、`route({method,url})`、装饰器、Next.js `app/**/route.ts` 与 `pages/api/**`。
   - OpenAPI/Swagger：JSON 与 YAML 都解析 paths、method、summary、operationId、tags、auth、request/response、errors、`components.schemas`。
   - GraphQL：SDL 的 type/input/interface/enum/union/scalar 入符号表；Query/Mutation/Subscription 字段转 API。
   - 其他语言：generic 解析声明/导入/常见路由；`ctags` 模式解析 universal-ctags JSON，作为增强而不是硬依赖。
6. **漂移按查询时计算**：`code_files` 不存 `stale` 列。查询时用当前文件的 `mtime_ms`/`bytes`/`sha256` 对比索引记录，内容变了标 `stale`，文件消失标 `missing`。`fileStamp` 在 stat 未变时仍重读哈希，覆盖“mtime/size 不变但内容变了”的窗口。
7. **删除清理只清该文件的行**：默认 `deleteFileRows` 只删该文件的符号/API/出边；只有删除文件时才连入边一起清。重索引单个文件不能误删其他文件指向它的 `imports` 入边，否则影响面会凭空消失。
8. **四个入口同一语义**：CLI、5 个 `project_*` MCP 工具、5 条 `/omni-memory/project/*` HTTP 路由、`/project` 页面都调用同一组 `lib/project-index.mjs` 函数，不在传输层复制查询逻辑。
9. **与 note/fact 合并而不是替代**：`project_search` / `project_context` 回答“在哪、签名、契约、波及谁”；`memory_search` / `memory_context` 回答“为什么、历史、坑”。`memory_context` 与显式项目 scope 的 `buildMemoryPacket` 在命中项目引用时追加有预算的项目包，带 `sourceRef`、行号、`sha`、`stale`。

## 后果

- 任意项目一条命令即可得到模块、符号、API、依赖索引；1,000 文件冷索引在本机 <1s，热增量不重复解析，精确查询 p95 <50ms。
- 索引过期不再静默：`stale`/`missing` 随查询返回；用户可以立即重跑 `omni index`。
- 不存源码正文，备份体积和泄漏面小于“把代码写进记忆”；代码检索仍以工作区文件为准。
- 根 package 仓库只有一个模块键；需要更细粒度时按 monorepo manifest 拆包，而不是按目录猜模块。
- `project_*` 工具没有 `memory_` 前缀，因为它们操作的是派生代码索引，不是记忆条目；文档与工具清单按实际名称列。
- 第一版影响面只覆盖静态 import/tests，不是运行时调用图；动态注册、反射和跨语言调用需要后续适配器补充。

## 验证

- `test/project-index.test.mjs` 24 项：五表 schema 与 scope 清理、JS/TS 解析、Express/Fastify/Next 路由、OpenAPI JSON/YAML、GraphQL SDL、generic Python/Go、ctags JSON、索引模块/符号/API/边、增量、sha 漂移、删除清理、全量重建、不存正文、精确查询、API 过滤、上下文预算、影响面、模块上下文、monorepo、状态、符号解析、1,000 文件性能。
- 本仓库实测：358 files / 1,287 symbols / 643 edges / 1 module / 206ms（`--no-ctags`）；`omni project impact lib/project-index.mjs` 返回 12 个 importer 与 93 个测试关联。
- 完整 `npm test` 476/476；`npm run check` 文档计数与 28 内核工具 / 30 MCP 工具 / 26 路由一致。
