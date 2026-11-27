# 全息记忆 v4.6.6 测试覆盖率评审报告

> **本报告是只读评审产物**：未修改任何源码、测试或配置；覆盖率数据采集用 Node 内置 reporter 完成，LCOV 核对在临时目录进行。本文件是本次唯一新增文件。
>
> 评审团：齐活林（交付总监 · 编排/汇编/裁决）、严过关（测试覆盖分析员）
> 评审日期：2026-11-26（修订版：已并入主理人 5 条复核补充及分析员逐条复核结论）

> **口径限制说明（4.6.8 追补）**：本报告的 `index.js 47.84%`、`all files 52.83%` 均为 Node 22 文本表“同一文件只打印单条代表记录”的产物。按 `(SF, DA line)` 取 max 的并集口径重测（`docs/覆盖率重测报告-4.6.7-2026-11-27.md`）：`index.js` 真实并集行覆盖 **97.18%**（586/603），P0-1 指定的三段 335-394 / 531-570 / 582-594 并集 **100% 命中**。本报告的优先顺序与 P0 清单仍然有效，但引用具体百分比时请使用并集口径，勿再用单记录数字。

---

## 结论先看（给不读全文的人）

**一句话**：源码核心 30 个模块行覆盖 87.77% 看着健康，但**分支只有 69.20%**，未覆盖的行高度集中在两个用户入口——`index.js` + `hosts/cli.mjs` 合计 773 行未覆盖，占源码核心未覆盖行的 **43.2%**。补测重点不是"再多加测试"，而是**把入口层的错误路径和条件分支补齐**。

⚠️ **一个必须纠正的数字**：覆盖率日志末尾的 `all files 52.83%` 是错的，不能拿来判断源码质量。它是 Node 22.22.2 多进程聚合缺陷——`index.js` 被重复记录 446 次，凭空多算 26.8 万行分母。分析员在临时目录用 LCOV 重跑核对：不去重恰好 52.83%、去重后 88.63%，与日志完全吻合。**真实源码覆盖率是 87.77% 行 / 69.20% 分支 / 86.20% 函数**。本报告一律用纠正后的口径。

**本迭代必须补齐的 5 处（P0，按优先级）**：

| # | 模块/段 | 当前 行/分支/函数 | 为什么排这里 |
|---:|---|---|---|
| 1 | `index.js` | 47.84 / 32.69 / 32.00 | 插件主入口；`335-394` 请求体安全边界为最高优先缺口，另含 prompt 注入与并发租约 |
| 2 | `hosts/cli.mjs` | 46.19 / 27.72 / 48.48 | 绝对未覆盖行最多（459）；`633-727` project 命令族含 scope 迁移，`218-272` rules 含写盘，误操作不可逆 |
| 3 | `lib/store.mjs` | 95.15 / 70.02 / 95.75 | 核心数据引擎，未覆盖集中在 force reindex 与 restore，都是数据一致性路径 |
| 4 | `lib/read-routes.mjs` | 86.27 / 70.12 / 82.35 | HTTP 读写面，含跨 scope 审计与 405/400 校验，属权限路径 |
| 5 | `hosts/mcp/server.mjs`（stdio 段） | 文件 72.57/77.27/75.00，**180-226 零覆盖** | **人工越级项**：MCP 宿主真正主链路，47 行连续零覆盖，出错直接表现为客户端协议故障 |

**前提**：覆盖率不是质量指标，只是线索。100% 行覆盖也完全可能是无断言的空测试；未出现在覆盖率表里的文件也不等于 0% 覆盖。本报告所有排名都是"补测线索"，不是质量评分；安全与架构评价不在本次范围。

---

## 0. 评审范围

| 项 | 内容 |
|---|---|
| 被评审对象 | `D:/xiangmu/全息记忆`，提交 `47ac157`（2026-11-26 docs: update per-commit update log） |
| 评审类型 | 覆盖率专项（Workflow D）—— 找最薄弱模块 + 补测优先级排序 |
| 参与角色 | 齐活林（编排/汇编/裁决）、严过关（测试覆盖分析） |
| 数据采集命令 | `node --test --experimental-test-coverage --test-concurrency=1 --test-timeout=120000 --test-reporter=spec "test/*.test.mjs"` |
| 测试执行结果 | 494 tests：493 pass / 1 skip / 0 fail / 0 todo，耗时 182.6s，96 个测试文件 |
| 原始数据 | `.coverage-run-4.6.6.log`（第 666–838 行为覆盖率表） |

**未覆盖范围（先声明）**：

1. 安全审计、架构与性能评价不在本次职责范围，未做。
2. **工具口径盲区（未测量，不是 0% 覆盖）**：`hosts/http/web/**` 7 个 JS 共 2468 行、`hosts/mcp/bin.mjs` 60 行、`scripts/` 下另 12 个脚本，全部未被测试进程加载，没有覆盖率数据。给它们标 0% 或算进分母都是错误结论。详见 6.1。
3. 性能 benchmark 的时延/吞吐、fuzz 输入充分性、真实外部服务（Jina/Cohere/SiliconFlow/vLLM/远程 embedding/Windows 计划任务）集成均未分析——覆盖率不回答这些问题。

---

## 1. 结论摘要

**总体判断（可反驳）**：源码核心行覆盖 87.77% 掩盖了入口层缺陷；行覆盖与分支覆盖差 18.6pp，说明大量条件/错误路径没测到。反例条件：如果后续补测证明这些未覆盖分支全是不可达的防御性代码，则本判断不成立——但从第 3 节列的具体函数看，多数是可触发的真实路径。

| 级别 | 数量 | 是否阻断上线 |
|---|---:|---|
| 严重（安全/数据/不可逆路径/生产主链路未测） | 8 | 本迭代必须处理 |
| 重要（分支缺口/核心数据一致性） | 8 | 排期处理 |
| 建议（边缘工具） | 2 | 有空再做 |

---

## 2. 量化基线

### 2.1 口径纠错：日志里的 `all files 52.83%` 不能用

分析员用 LCOV reporter 在临时目录重跑核对，结论如下（主理人已裁决采信）：

- LCOV 原始输出共 **590 条 SF 记录，但只有 145 个唯一文件**；其中 `index.js` 被重复记录 **446 次**（每个测试子进程一条），每条 LF=602（物理行数）。
- 文本报告的目录树按路径去重（表格里 `index.js` 只出现 1 行），但 `summary.totals` 不去重——`all files` 直接累加了 446 份 index.js，凭空多算 **267,890 行**分母。
- 重跑验证：**去重后** `all files` = 88.63% 行 / 70.02% 分支 / 79.78% 函数；**不去重**恰好 = 日志的 52.83% / 41.85% / 39.44%，完全对上。

因此"52.83% 被 vendor 和测试文件严重拉低"的判断需要修正：真正拉低 `all files` 的是 index.js 的 446 条重复记录；test 文件本身行覆盖 97.55%、vendor 90.28%，它们是拉高的。

### 2.2 重新计算的项目源码覆盖率

口径：唯一文件去重；行按物理行数 LF 加权，分支/函数按各文件 BRF/FNF 加权。

| 范围 | 文件数 | 行覆盖 | 分支覆盖 | 函数覆盖 |
|---|---:|---:|---:|---:|
| **源码核心 30 模块**（index + hosts + lib 非 vendor） | 30 | **87.77%**（12834/14622） | **69.20%**（2887/4172） | **86.20%**（781/906） |
| 源码核心 + 已测量 8 个脚本 | 38 | 84.50%（14430/17078） | 67.40%（3072/4555） | 84.52%（868/1027） |
| 参考：全部 145 文件去重后 | 145 | 88.63% | 70.02% | 79.78%（被 vendor 函数覆盖 40.26% 拉低） |

**结构性结论**：`index.js` + `hosts/cli.mjs` 两个入口合计 773 行未覆盖（314 + 459），占源码核心未覆盖行 1788 行的 **43.2%**；而 `lib/design-contract.mjs`、`lib/embed.mjs`、`lib/capture-rules.mjs` 等工具类普遍 92–100%。典型的"工具高覆盖、入口低覆盖"。

### 2.3 源码模块三维覆盖率（按行覆盖升序，30 个）

| 模块 | 行% | 分支% | 函数% | LF | 未覆盖行区间（摘要） |
|---|---:|---:|---:|---:|---|
| hosts/cli.mjs | 46.19 | 27.72 | 48.48 | 853 | 131-135 180-191 218-348 366-407 445-499 572-620 633-852 |
| index.js | 47.84 | 32.69 | 32.00 | 602 | 47-63 122-202 335-394 400-446 531-570 582-599 |
| hosts/mcp/server.mjs | 72.57 | 77.27 | 75.00 | 226 | 44 47-49 61-71 108-110 **180-226** |
| hosts/shared/doctor.mjs | 74.14 | 35.96 | 85.71 | 348 | 64-82 90-110 176-199 234-276 327-348 |
| lib/read-routes.mjs | 86.27 | 70.12 | 82.35 | 1296 | 65-80 831-872 996-1038 1108-1211 |
| lib/project-adapters/generic.mjs | 87.78 | 50.67 | 100.00 | 180 | 35 108-112 135-152 |
| lib/project-index.mjs | 88.51 | 64.47 | 87.21 | 914 | 135-173 358-386 584-586 815-820 |
| hosts/shared/context-tool.mjs | 88.96 | 55.56 | 50.00 | 154 | 30-31 91-111 |
| lib/tool-definitions.mjs | 91.00 | 77.38 | 84.78 | 1566 | 372-402 769-798 1374-1410 1466-1542 |
| hosts/http/server.mjs | 91.01 | 68.82 | 94.74 | 345 | 153-319（10 小段） |
| lib/project-adapters/js.mjs | 92.31 | 65.63 | 94.74 | 377 | 43-54 87-90 302-315 |
| lib/schema.mjs | 93.91 | **50.00** | 100.00 | 115 | 98-104 |
| hosts/shared/headless.mjs | 94.52 | 70.59 | 69.23 | 73 | 44-45 50 53 |
| lib/version-check.mjs | 94.98 | 78.48 | 100.00 | 279 | 49-50 112-118 137-139 212-213 |
| hosts/shared/http-guard.mjs | 95.06 | 78.57 | 100.00 | 81 | 41-42 70-71 |
| lib/store.mjs | 95.15 | 70.02 | 95.75 | 3529 | 789-797 1019-1027 2363-2395 3158-3172 3257-3261 |
| lib/profile.mjs | 95.35 | 66.03 | 86.49 | 731 | 320-327 414-419 721-722 |
| lib/search.mjs | 95.57 | 74.10 | 96.83 | 1579 | 784-819 994-997 1470-1521 |
| lib/daily-sync.mjs | 96.10 | 78.95 | 100.00 | 77 | 47-48 51 |
| lib/semantic-embed.mjs | 96.97 | 83.33 | 92.31 | 165 | 62-63 103-105 |
| lib/embed-provider.mjs | 98.08 | 88.24 | 100.00 | 104 | 67-68 |
| lib/capture-rules.mjs | 98.31 | 92.31 | 100.00 | 59 | 25 |
| lib/project-adapters/api.mjs | 98.39 | 66.17 | 92.31 | 311 | 31-32 106 113 232 |
| lib/project-schema.mjs | 98.64 | 75.00 | 100.00 | 147 | 138-139 |
| lib/update-signature.mjs | 98.68 | 88.33 | 100.00 | 152 | 60-61 |
| hosts/shared/rules.mjs | 99.12 | 92.86 | **60.00** | 114 | 69 |
| lib/rerank-provider.mjs | 100.00 | **74.19** | 100.00 | 67 | — |
| hosts/shared/boot.mjs | 100.00 | 83.33 | 100.00 | 69 | — |
| lib/embed.mjs | 100.00 | 96.67 | 100.00 | 107 | — |
| lib/design-contract.mjs | 100.00 | 100.00 | 100.00 | 5 | — |

**"行高分支低"重点信号（行−分支差 ≥ 25pp）**——这些模块行覆盖看着漂亮，但条件/错误路径基本没测，是补测真正的富矿：

| 模块 | 行−分支差 |
|---|---:|
| lib/schema.mjs | 43.91pp |
| hosts/shared/doctor.mjs | 38.18pp |
| lib/project-adapters/generic.mjs | 37.11pp |
| hosts/shared/context-tool.mjs | 33.40pp |
| lib/project-adapters/api.mjs | 32.22pp |
| lib/profile.mjs | 29.32pp |
| lib/project-adapters/js.mjs | 26.68pp |
| lib/rerank-provider.mjs | 25.81pp |
| lib/store.mjs | 25.13pp |

---

## 3. 问题清单

格式：`[级别] 维度 | 相对路径:行号 | 问题描述 | 建议动作`

### 3.1 严重（8 条，本迭代必须处理）

1. `[严重] 行/分支/函数 | index.js:335-394 | readJsonBody 安全边界整段未测：oversize(413)、invalid JSON、invalid object、空 body、strict/non-strict 分支全无覆盖，属请求体校验路径（主理人复核确认安全相关，升为最高优先） | 补 strict × {空体,非法 JSON,非对象,超限,流不可读} 矩阵，断言错误码+状态码+不抛异常`
2. `[严重] 行/分支 | index.js:531-570 | profile 注入预算裁剪与 setLastInjection 诊断未测，影响注入正确性（优先级次之） | 注入假 host ctx 触发 section 回调，断言 PROFILE_BUDGET 裁剪、争议记忆过滤、诊断字段`
3. `[严重] 行/分支 | index.js:582-594 | OMNI_DREAM_INTERVAL_MS 后台定时合并未测：acquireLease/releaseLease 并发租约与异常吞掉路径无覆盖 | 注入短间隔+可控 timer，断言多实例只跑一次、异常不影响宿主、退出释放租约`
4. `[严重] 行/分支/函数 | hosts/cli.mjs:633-727 | project 子命令族分发（context/impact/search/init/link）未测；其中 link 的 `--apply` 会真实迁移/合并 scope 数据，误操作不可逆 | 临时库构造 from/to 两 scope，断言预览不改库、--apply 后行数与别名一致、非法 proj: 与自链接被拒`
5. `[严重] 行/分支 | hosts/cli.mjs:218-272 | rules 命令写文件分支未测（--write 落盘、--create 新建、异常 marker 跳过不误删正文、预览不落盘） | spawnSync + 临时目录跑参数矩阵，断言写盘内容/退出码/预览无副作用`
6. `[严重] 行/分支/函数 | hosts/mcp/server.mjs:180-226 | MCP 宿主实际主链路：serveStdio 的 readline 帧处理、JSON.parse 错误回复、chain 串行化、dispatch 失败带 id 回复、SIGINT/SIGTERM/stdin end 关闭、stop() 等待链，47 行连续零覆盖 | 内存流驱动 rl，逐条断言 JSON-RPC 错误码、chain 顺序、closed/stop 行为`
7. `[严重] 未测量（非 0%）| hosts/mcp/bin.mjs:1-60 | MCP 独立进程入口（warning 抑制、bootHost、serveStdio、exit 清理）从未被测试 import，覆盖率表无此文件；属工具口径盲区，不能用 0% 描述 | 增加 spawn 级冒烟测试（启动→发 initialize 帧→退出），断言 stdout 仅协议帧、stderr 无 ExperimentalWarning`
8. `[严重] 行/分支 | lib/tool-definitions.mjs:372-402 | memory_write 的 raced 并发去重分支未测（另一宿主先写入时回填 problemKey/status/evidence），并发+数据一致性 | 两个并发 call 写同文本，断言只留一行且状态/证据被合并`

### 3.2 重要（8 条，排期处理）

9. `[重要] 行/分支 | lib/store.mjs:2363-2395 | reindexSemantic force 重建未测：DELETE semantic_vectors + pending 清空 + backfill + 失败回退，数据一致性风险 | 造已迁移/未迁移 schema，断言 force 后签名过滤删除、失败返回 error 且不清状态`
10. `[重要] 行/分支 | lib/store.mjs:3158-3172 | restore 恢复 facts 时重建 edges（valid_to=NULL 或 INSERT）与 chunk 分支未测 | 构造带 edge 的软删 fact，断言 restore 后 edge 复活/新建且不重复`
11. `[重要] 行/分支 | lib/read-routes.mjs:996-1038 | dream/replace 与 rollback 路由未测：非 POST 405、query/body 双通道 noteId、跨 scope 审计无覆盖 | POST/GET × query/body × scope=all，断言 405/400/200 与审计记录`
12. `[重要] 行/分支 | lib/tool-definitions.mjs:769-795 | fact/chunk 按 scope 过滤读取与 not-active/out-of-scope 分支未测，权限边界 | 跨 scope + 软删 + valid_to 非空组合，断言 missing 原因分类`
13. `[重要] 分支 | hosts/shared/doctor.mjs:64-112 | 分支仅 35.96%：run() 异常分支、inspectTask Windows 计划任务多状态（非 Win/跳过/未找到/旧 launcher/新版匹配）未测 | 桩 execFileSync 返回各状态，断言 warn/ok/fail 与 detail 文案`
14. `[重要] 分支 | lib/schema.mjs:98-104 | 行 93.91% 分支仅 50.00%（差 43.91pp，源码最大）；115 行小文件，补测性价比最高 | 对 98-104 各条件造非法/边界输入，断言 reject 与错误字段`
15. `[重要] 行/分支 | lib/project-index.mjs:135-173,358-386 | 索引构建/对齐异常分支未测（分支 64.47%），影响 project 检索完整性 | 造残缺/重复/超大文件，断言不抛错且结果可解释`
16. `[重要] 分支/函数 | hosts/shared/context-tool.mjs:103-111 | 分支 55.56%、函数仅 50.00%，一半函数从未执行 | 列出未调用函数逐个补正向+异常断言`

### 3.3 建议（2 条，可排期）

17. `[建议] 分支 | lib/project-adapters/generic.mjs:108-152 | 分支 50.67%，多语言探测回退未测 | 造空项目/混合语言/缺 manifest，断言探测与回退`
18. `[建议] 函数 | hosts/shared/rules.mjs:69 | 行 99.12% 但函数仅 60.00%，4/10 函数未执行，100% 行覆盖是假象 | 补调用未覆盖函数的最小用例并断言返回值`

---

## 4. 逐模块评审（P0 五模块）

### `index.js`（47.84 / 32.69 / 32.00）

- **做了什么**：插件主入口，承载 HTTP body 解析、prompt section 拼装、后台定时合并租约。
- **发现什么**：三处大缺口全是安全/数据路径——`readJsonBody()` 的 strict 错误矩阵（335-394）、prompt 注入预算裁剪与争议过滤（531-570）、后台租约并发与异常吞掉（582-594）。
- **建议什么**：按 3.1 第 1–3 条补测；验收：三个函数每条分支至少 1 次断言，行覆盖 ≥70%、分支 ≥55%。

### `hosts/cli.mjs`（46.19 / 27.72 / 48.48）

- **做了什么**：CLI 用户主入口，含 rules/context/ingest 与 project 命令族。
- **发现什么**：绝对未覆盖行最多（459 行）；`633-727` 的 project 命令族含 `link --apply`（真实迁移 scope 数据）只测了预览；`218-272` 的 rules 写盘分支未测。
- **建议什么**：按 3.1 第 4–5 条做参数化 CLI 矩阵测试（spawnSync + 临时目录/临时库）；验收：行覆盖 ≥70%，两个细分段各自有写盘/迁移结果断言。

### `lib/store.mjs`（95.15 / 70.02 / 95.75）

- **做了什么**：核心数据存储引擎，3529 行。
- **发现什么**：行高但 171 行未覆盖集中在 force reindex（2363-2395）与 restore 重建 edge/chunk（3158-3172），均为数据一致性路径；行分支差 25.13pp。
- **建议什么**：按 3.2 第 9–10 条补测；验收：两个区间全覆盖，分支 ≥78%。

### `lib/read-routes.mjs`（86.27 / 70.12 / 82.35）

- **做了什么**：HTTP 读写路由层，1296 行。
- **发现什么**：dream/replace 与 dream/rollback 路由（996-1038）未测，含非 POST 405、query/body 双通道、跨 scope 审计；1108-1211 另有未覆盖段。
- **建议什么**：按 3.2 第 11 条做路由矩阵；验收：996-1038 全覆盖，跨 scope 调用有审计断言。

### `hosts/mcp/server.mjs`（72.57 / 77.27 / 75.00，stdio 段 180-226 零覆盖）

- **做了什么**：MCP 宿主实际运行的 stdio 传输层，处理 readline 帧、JSON-RPC 分发与关闭。
- **发现什么**：180-226 共 47 行连续零覆盖——invalid JSON 错误回复、dispatch 失败带 id 回复、chain 串行化、SIGINT/SIGTERM/stdin end 关闭、stop() 等待链全未测。按公式仅排第 10（38.39 分），但这是生产主链路，主理人复核后人工越级进 P0。
- **建议什么**：按 3.1 第 6 条补测；验收：180-226 逐行覆盖，每种错误帧有 JSON-RPC 错误码断言。注意该模块存在测试顺序/端口相关的非确定性（见 6.3），补测时顺带固定。

---

## 5. 补测优先级排序与改进路线图

### 5.1 排序依据（公开权重，便于反驳）

```
缺口分   = 0.5×(100−行%) + 0.3×(100−分支%) + 0.2×(100−函数%)
规模因子 = √(LF/100)          # 用平方根抑制超大文件独占
影响因子 = 1.5 核心数据/权限/并发/生产主链路；1.0 其他运行时核心；0.5 运维脚本
优先级分 = 缺口分 × 规模因子 × 影响因子
```

影响因子是唯一主观项。公式得分前 5：`index.js` 220.35、`hosts/cli.mjs` 172.00、`lib/store.mjs` 109.33、`lib/read-routes.mjs` 104.54、`lib/tool-definitions.mjs` 85.09；`hosts/mcp/server.mjs` 38.39（第 10）。

**唯一人工越级项**：`hosts/mcp/server.mjs:180-226` 是 MCP 宿主实际主链路且 47 行连续零覆盖，提到 P0 末位；`lib/tool-definitions.mjs` 按公式第 5 但降至 P1 首位。此越级是领域判断，不是公式结果，可挑战。

### 5.2 P0 / P1 / P2 / 运维脚本组

**P0（本迭代必须处理，5 条）**——见第 4 节逐模块评审与"结论先看"表，含当前覆盖率、理由、补测用例、验收标准。

**P1（重要，核心运行时次要模块）**：`lib/tool-definitions.mjs`(91.00/77.38/84.78，公式第 5，raced 并发与 scope 过滤)、`hosts/shared/doctor.mjs`(74.14/35.96/85.71)、`lib/project-index.mjs`(88.51/64.47/87.21)、`lib/schema.mjs`(93.91/50.00/100.00，115 行小文件、性价比最高)、`hosts/shared/context-tool.mjs`(88.96/55.56/50.00)、`lib/project-adapters/generic.mjs`(87.78/50.67/100.00)、`lib/profile.mjs`(95.35/66.03/86.49)。

**P2（核心运行时边缘工具）**：`lib/search.mjs`(95.57/74.10/96.83)、`hosts/http/server.mjs`(91.01/68.82/94.74)、`lib/semantic-embed.mjs`、`lib/embed-provider.mjs`、`lib/project-adapters/{api,js}.mjs`、`lib/version-check.mjs`、`lib/daily-sync.mjs`、`hosts/shared/{rules,headless,boot,http-guard}.mjs`、`lib/rerank-provider.mjs`(100/74.19/100，环境变量矩阵未测)、`lib/capture-rules.mjs`、`lib/update-signature.mjs`、`lib/project-schema.mjs`、`lib/embed.mjs`、`lib/design-contract.mjs`。

**运维/发布脚本组（单独成组，不与核心运行时混排）**——组内依据是"出错代价高、触发频率低"：

| 组内优先 | 脚本 | 行/分支/函数 | 组内理由 | 补测重点 |
|---:|---|---|---|---|
| S1 | scripts/verify-release.mjs | 60.73/47.17/57.14 | 发布校验 fail-closed，出错代价最高 | 篡改 manifest/launcher，断言非零退出码 |
| S2 | scripts/sign-release.mjs | 85.59/46.67/88.89 | 签名链路，分支 46.67% | 缺签名/错签名路径 |
| S3 | scripts/install.mjs | 55.73/**19.23**/33.33 | 安装主脚本，分支覆盖全组最低 | 临时 HOME 跑 --dry/--apply/--require-release，断言落盘与回滚 |
| S4 | scripts/install-launcher.mjs | 54.13/60.78/43.75 | 启动器安装 | --apply/--start 与卸载往返 |
| S5 | scripts/uninstall-launcher.mjs | 57.89/64.71/50.00 | 卸载清理 | 部分安装态下卸载不残留 |
| S6 | scripts/daily-sync.mjs | 61.20/44.06/86.36 | 日常同步，374 行未覆盖但多为低频运维 | 同步成功/冲突/失败重试 |
| S7 | scripts/check-test-results.mjs | 74.29/33.33/100.00 | 门禁脚本，分支 33.33% | 重复 # tests、plan 不一致 |
| S8 | scripts/check-docs.mjs | 95.67/69.44/100.00 | 已较高，组内最低优先 | — |

> 注意：另有 12 个 `scripts/*.mjs` 从未加载、无覆盖率数据（详见 6.1），不与上表 8 个混为一谈。

### 5.3 补测落地推荐顺序（综合复核）

1. `index.js:335-394` HTTP body 安全边界（P0-1）
2. `hosts/mcp/server.mjs:180-226` stdio 主链路（P0-5，人工提级）
3. `hosts/cli.mjs:633-727` scope 迁移 + `218-272` rules 写盘（P0-2）
4. `lib/store.mjs:2363-2395 / 3158-3172` 数据一致性（P0-3）
5. `lib/read-routes.mjs:996-1038` 跨 scope 审计（P0-4）
6. `index.js:531-570` prompt 注入（P0-1 第二用例）
7. 运维脚本组 S1 → S3（发布校验与安装）

### 5.4 三步路线图

| 阶段 | 动作 | 验收标准 |
|---|---|---|
| 立刻（P0） | 补 `index.js` 安全边界与 prompt 注入、`hosts/cli.mjs` 两个细分段、store 的 force/restore、read-routes 的路由审计、mcp-server 的 stdio 段 | 指定区间全覆盖；index/cli 行覆盖 ≥70%、分支 ≥55%；store 分支 ≥78%；stdio 180-226 逐行覆盖 |
| 本迭代（P1） | 补 tool-definitions/doctor/schema/context-tool/generic 的分支缺口；运维脚本组 S1–S3 | schema 分支 ≥85%；raced 并发有断言；发布校验脚本 fail-closed 有断言 |
| 下迭代（P2 及盲区） | 补 P2 边缘工具与运维脚本组其余项；评估前端脚本、bin.mjs 与未加载脚本的测试手段 | 安装脚本 dry-run/apply 双模式有断言；前端脚本确定是否纳入测试体系 |

---

## 6. 附录

### 6.1 工具口径盲区（未测量，不是 0% 覆盖，不计入源码分母）

| 文件组 | 行数 | 原因 |
|---|---:|---|
| `hosts/http/web/` 7 个 JS：app.js 182、base.js 48、dashboard.js 545、hub.js 106、mobile.js 167、project.js 256、star-map.js 1164 | **2468** | 浏览器端脚本由前端 `<script>` 加载，永不进 Node 测试进程，Node 内置覆盖率只统计被 import/require 的模块 |
| `hosts/mcp/bin.mjs` | 60 | 独立进程入口，测试只 import `server.mjs`/`boot.mjs`，未 import bin.mjs |
| `scripts/` 下另 12 个脚本 | 未统计 | `build-launcher`、`check-client-hooks`、`check-client-load`、`check-launcher`、`check-semantic-assets`、`check-syntax`、`check-update-log`、`demo`、`qa`、`reference-to-memory`、`tap-evidence`、`update-log`——其中多个属 `npm run check` 门禁，连覆盖率数据都没有，是比低覆盖更大的盲区 |

前三组合计至少 2528 行（前端 JS 2468 + bin.mjs 60）完全不被覆盖率工具看见；`hosts/http/web/` 的 CSS/HTML 共 1459 行（目录全资源 3927 行）同样不在评估范围。给这些文件标 0% 或把它们算进分母都是错误结论。

### 6.2 抽查测试有效性（从 100% 行覆盖的核心模块挑 3 个）

| 文件 | 抽查发现（带路径:行号） | 高覆盖是否等于高质量 |
|---|---|---|
| `lib/design-contract.mjs`（100/100/100） | `test/gates-4.6.4.test.mjs:86-89` 用两个 `assert.equal` 分别断言 false 与 true，不是空测试；但被测函数只有 4 行、是纯文本匹配 helper | **否，但 100% 无含金量**：验证的是"文案约定"而非行为，不能当质量信号 |
| `lib/embed.mjs`（100/96.67/100） | `test/embed.test.mjs:5-49` 共 7 个测试，全部有 `assert.ok/deepEqual/equal`（确定性、归一化、空输入零向量、相似度排序、blob 往返），是有效断言 | **部分**：`lib/embed.mjs:45` 单字符 CJK run 分支未被喂到（用例全是多字 CJK），典型"只覆盖主路径" |
| `lib/rerank-provider.mjs`（100/74.19/100） | `test/rerank.test.mjs:179-323` 失败矩阵扎实：throw、timeout abort、500、坏 JSON、缺 results、全零分都有 `assert.rejects/deepEqual` | **是（分支层面严重）**：行 100% 掩盖 25.81pp 分支差；`lib/rerank-provider.mjs:15-23` 的 cohere/jina/siliconflow 预设、API key 回退、timeout 钳制几乎没被驱动，只走 disabled 与显式 config 两条路 |

**顺带提醒**：`test/daily-sync-success.test.mjs` 自身行覆盖仅 34.07%（41-115 大段未执行），`test/scope-alias.test.mjs` 79.41%，`test/install-smoke.test.mjs` 69.39%。测试文件覆盖率虽被排除在源码评分外，但这些低值说明部分测试代码本身就没跑起来，值得单独核实是不是条件跳过/提前 return。

### 6.3 待核实清单

| 事项 | 为什么不确定 | 需要什么信息才能确认 |
|---|---|---|
| 去重口径是否被接受 | `index.js` 446 条重复记录是 Node 22.22.2 多进程聚合行为；本报告按去重口径分析 | 主理人已裁决采信（LCOV 重跑去重值 88.63%、不去重值 52.83% 与日志完全吻合）；若团队坚持"多记录并集"口径需重新计算 |
| `hosts/mcp/server.mjs` 覆盖率波动 | 重跑时从日志的 72.57% 掉到 65.93%，多出 135-141、144-151 两段未覆盖；两次均 0 fail | 该模块存在测试顺序/端口相关的非确定性；因涉及 P0-5，补 stdio 测试时顺带固定 |
| LCOV 与文本表 ±0.15pp 差异 | 如 store 70.16 vs 70.02、update-signature 86.89 vs 88.33，属多记录取值差异 | 不影响排名，无需处理 |
| 第 17–18 条及脚本组建议动作 | 只看了 uncovered 行号与周边源码，未逐个打开对应测试文件核实现有断言 | 落地前需补做有效性抽查 |

### 6.4 本次未做的事

- 未做安全审计与架构/性能评价（不在职责范围）。
- 未看任何 bench 日志的时延/吞吐结果。
- 未验证 fuzz 输入是否充分或发现缺陷（100% 行覆盖只说明代码执行到了）。
- 未连真实外部服务（rerank / embedding / Windows 计划任务实机），全部是桩或跳过。
- 未测量前端脚本、`bin.mjs` 与 12 个未加载脚本（无覆盖率数据，见 6.1）。
- 未修改被测项目任何文件。

### 6.5 复现命令

```bash
cd D:/xiangmu/全息记忆
# 采集覆盖率（本次实际执行）
node --test --experimental-test-coverage --test-concurrency=1 --test-timeout=120000 \
  --test-reporter=spec "test/*.test.mjs" > .coverage-run-4.6.6.log 2>&1
# 覆盖率表位于日志第 666-838 行（start/end of coverage report）
# 口径核对：在临时目录用 LCOV reporter 重跑，对比唯一文件去重前后的 all files 汇总
```
