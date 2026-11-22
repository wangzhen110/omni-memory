# 3.11.0 整改文档（2026-11-22）

来源：`docs/REVIEW-3.10.4-2026-11-22.md` 第 5–7 节，以及 3.10.5 发布时明确未做的结构与性能项。

## 1. 目标与边界

**目标**
- 把 `index.js` 的注册枢纽、导入器、store 初始化和重复索引逻辑拆成可独立阅读/测试的单元。
- 把 `/overview` 的周序列从“全量取时间戳再内存分桶”改为 SQL 聚合，保持响应字段与数值完全一致。
- 用 `notes.text_hash`（schema v17）降低写入去重和恢复查重的文本扫描成本，并提供可回滚迁移。
- 重跑 100k / 1M 基准，给出 3.11.0 的可复现实测数字，而不是沿用旧版。

**非目标**
- 不改变 21 条 HTTP 路由的路径、响应字段和既有业务语义。
- 不改变 23 个内核工具 / 25 个 MCP 工具的名称、参数 schema 和权限。
- 不改变项目层 scope 语义，不引入新的权限模型。
- 不在本版做前端改版或星图重构。

**回滚原则**
- 每个整改项一个独立提交，提交后跑全量 `npm test` 与 `npm run check`；任一项失败只回滚该项提交。
- schema v17 单独提交，迁移必须可重入；升级前自动备份不做（沿用现有备份策略），但提供 `PRAGMA user_version` 版本判断与回滚说明。
- 性能项不通过就不写入 README 的新数字，保留“未复测”标注。

## 2. 当前基线

| 项 | 3.10.5 实测 |
|---|---|
| 全量测试 | 374 / 374 |
| 文档门禁 | 23 内核工具 / 25 MCP 工具 / 21 路由 / 31 ADR / schema v16 / version 3.10.5 |
| 真实 DSH | 路由 21、schema 16、32 notes / 7 facts（含一条 3.10.5 验收笔记） |
| 仓库 | `fbd87d4`，`origin/main` 同点 |
| 性能 | 100k/1M 旧数字来自 3.10.1；3.10.5 未重跑 |

## 3. 整改项清单

| ID | 来源 | 整改内容 | 验收标准 | 状态 |
|---|---|---|---|---|
| M-01 | 第 6 节“路由 scope / 21 条路由” | 抽 `httpScope()`；引入统一 route wrapper，集中 loopback / 方法 / CSRF / 域名 | 21 条路由仍注册；403/405/CSRF 回归不变；scope=all 审计仍触发 | 已完成（374/374） |
| M-02 | 第 6 节“registerRoutes 1082 行” | 按 packet/read、write/candidate、persona/dream、admin 拆路由组；`registerRoutes` 只做装配 | `registerRoutes` 降到 300 行内；路由计数 21；全量测试通过 | 已完成（70 行，21 路由，374/374） |
| M-03 | 第 6 节“defineTools 1336 行” | 按 capture / write-read / maintenance / graph 拆工具组；`defineTools` 只做注册与装配 | 工具计数 23/25；工具 schema 与 execute 行为不变 | 待实施 |
| M-04 | 第 6 节“mergeSnapshot 317 行” | 按实体拆 importer（notes/facts/chunks/candidates/edges/meta）；保留单一事务与 idMap | 导入 dry-run/apply/血缘重映射回归不变；函数降到 80 行内 | 待实施 |
| M-05 | 第 6 节“openStore 205 行” | 抽 `createBaseSchema()`、`createFtsTables()`；迁移/GC/回填仍由 `openStore` 编排 | 新库与旧库 schema 一致；schema 16→17 迁移可重入 | 待实施 |
| M-06 | 第 6 节“restore/import/dream 重建重复” | 抽 `reindexRow(s, kind, id, text)` 统一 FTS + bigram + vector；restore/import/dream 复用 | 恢复后 FTS/向量/bigram 可搜；去重/回滚测试通过 | 待实施 |
| M-07 | 第 6 节“importLineage” | 将 `importLineage` 改为语义明确的 `positiveIdOrNull`，仅保留一处调用 | 导入非法 lineage 仍变 null；无死代码 | 已完成（374/374） |
| M-08 | 第 7 节“/overview 全量物化” | 周序列与 84 日热力图改为 SQL 分组聚合；基线窗口计数用 SQL `SUM(ts < ?)` | 与旧实现在 100k 临时库逐字段一致；`/overview` 延迟写入基准报告 | 待实施 |
| M-09 | 第 7 节“notes text_hash” | schema v17：`notes.text_hash` + `(scope, text_hash)` 索引；写入去重、restore、import 预筛走哈希再比对原文 | 现有去重语义不变；哈希碰撞回查原文；迁移可重入；100k 写入基准改善 | 待实施 |
| M-10 | 第 7 节“1M 复测” | 隔离临时库生成 100k/1M fixture，跑 write/list/overview/search，记录 5 次中位数 | 报告含机器、Node、fixture、命令、原始值；不达标不写 README | 待实施 |

## 4. 实施顺序

1. **M-07 → M-01**：先清小死代码，再抽 `httpScope` 与 wrapper；风险最低，先建立路由回归。
2. **M-05 → M-04 → M-06**：先拆 store 初始化，再拆导入器，最后抽索引重建；数据层改动按事务边界逐项验证。
3. **M-03 → M-02**：先拆工具注册，再拆路由组；每步核对 23/25 工具与 21 路由。
4. **M-08**：聚合 SQL 先做“旧实现快照 vs 新实现”并行对比，再切换。
5. **M-09**：schema v17 独立提交，补迁移/碰撞/回滚测试后再改写入路径。
6. **M-10**：最后跑基准；若 1M 结果不回退，才更新 README 与 DESIGN 的性能数字。

## 5. 每项验收命令

```powershell
npm test
npm run check
node --check index.js
node --check client.js
```

路由/工具专项：

```powershell
node --test test/http-security.test.mjs test/persona.test.mjs test/review-3.10.4.test.mjs
node --test test/import-export.test.mjs test/restore.test.mjs
```

性能专项（隔离临时库，不碰真实 `~/.dsh/memory/omni.db`）：

```powershell
npm run bench
```

## 6. 状态记录

| 日期 | 项 | 结果 | 证据 |
|---|---|---|---|
| 2026-11-22 | 文档建立 | 待实施 | 本文件 |
| 2026-11-22 | M-01 / M-07 | 完成 | 统一 route guard；`httpScope` 替换 6 处；`positiveIdOrNull`；`npm test` 374/374 |
| 2026-11-22 | M-02 | 完成 | `registerRoutes` 1100→70 行；四组 read/admin/write/persona 共 6/5/4/6 路由；路由计数 21；`npm test` 374/374 |

## 7. 明确不做

- 不做前端改版。
- 不改变路由响应契约。
- 不为性能数字牺牲正确性；聚合 SQL 与旧实现不一致时以旧实现为准。
- 不在真实库上做破坏性迁移演练；迁移测试使用临时 `OMNI_HOME`。
