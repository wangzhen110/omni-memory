# 整改取舍与延后清单

> 本文件记录外部评审项的最终取舍，不是问题清单的复制。
> 每一项必须先回答：事实是否成立、用户收益、 blast radius、替代方案、验证方式、落在哪个版本。
> 结论只有三种：`本轮做`、`延后`、`不采纳`。
> 来源：`docs/全面体检报告-2026-11-26.md`、`docs/整改复核报告-2026-11-26.md` 与当前 v4.6.x 源码/实测复核。

## 决策闸门

1. 先复核当前代码、当前测试、当前生产；评审结论不能直接当事实。
2. 安全与数据正确性优先；文档美观、行数、命名靠后。
3. 优先选小修复、共享守卫、启动校验、兼容层；不为了“干净”做大爆炸重构。
4. 补丁版只放低风险修复；schema、结构改造进次版本。
5. 延后项必须写触发条件和复查版本；不采纳项必须写替代方案。

## 4.6.1 本轮处理

> 状态：已完成（2026-11-26，`npm test` 483/483，`npm run check` 通过）。以下条目已进仓库；发布与生产升级由 #77 收口。

- 只读 HTTP 路由统一 Host 校验；`/export` 限定 GET；403 带 `error`。
- 安全校验从 `index.js` 与 `hosts/http/server.mjs` 收拢到共享模块。
- HTTP `/tool` 注入服务启动时的项目/会话上下文；显式 `scope` 仍优先。
- `project_search` 的 `limit` 加下限、有限数校验，禁止负数触发全表。
- 跨 scope 审计失败写 stderr 告警，不阻断写入。
- `OMNI_TEST_*` 测试钩子要求 `OMNI_TEST_MODE=1`，生产环境忽略并告警。
- `HOST-ADAPTERS.md` 工具数、路由数、OpenAPI path 数、规则文本口径同步。
- 增加 `npm run verify`（测试 + 文档/语法检查），作为发布前真值门。

## 4.6.2 本轮处理

> 状态：已完成（2026-11-26，`npm test` 486/486，TAP 0 fail，`npm run check` 通过）。复核报告的 6 项事实问题均处理；其“483/483 全绿失真”的总体结论在发布机上不成立，按“本机未复现”记录，未降低产品预算。

- 插件侧读路由对缺失 Host 也 fail-closed，与 standalone 服务端一致；测试请求显式注入 Host。
- stdio/HTTP `initialize.instructions` 统一为完整 `RULES_TEXT`，删除摘要副本。
- `OMNI_TEST_MODE=1` 增加 `NODE_TEST_CONTEXT` 第二道门，防止部署误设替换验签链。
- `npm test` 输出 TAP，`npm run verify` 用 `scripts/check-test-results.mjs` 校验真实 pass/fail/cancelled；超时提到 120s。
- Linux 项目路径用例改用 OS 临时目录；`schtasks` 不可用时明确 skip；1000 文件 warm sync 改为相对预算并输出诊断。
- README 规则口径、REFERENCE REST `limit` 与 persona `clear` 归属、测试环境变量名修正；`check-docs` 扩展 HOST-ADAPTERS/REFERENCE/OpenAPI/规则/persona/limit/变量名。

## 4.6.3 本轮处理

> 状态：已完成（2026-11-26）。只收口测试门禁与平台条件，不改 schema、不改检索权重。

- **3.1 漏跑检测**：`check-docs` 增加 `tap.tests >= declaredTests` 下界；测试文件未被 runner 发现时直接失败，不再只看 `fail=0`。
- **3.3 重复摘要**：`check-test-results` 要求摘要标签唯一、只有一个 `1..N` plan 且与 `# tests` 一致。
- **3.2 定性**：`NODE_TEST_CONTEXT` 收紧为 `child` / `child-vN`；文档改称“防误设”，明确不是抗篡改安全边界。
- **3.4 macOS**：`property-scope-alias` 改用语义变量 `platform` 判断大小写别名差异。
- **缺文档诊断**：`check-docs` 对缺失必需文档输出明确错误，不再抛 `ENOENT`。
- **数字勘误**：4.6.2 完成报告的测试口径改为 `486 tests / 482 pass / 2 fail`。

## 延后项

### R-01 `note_candidates` 去重未进事务、无唯一约束

- 状态：延后，目标 4.7.0 / schema 21。
- 事实：`insertNoteCandidate()` 在 `insertChunk()` 事务之外；表只有普通索引。
- 后果：跨进程并发可能产生重复 pending 候选，review 时产生状态噪音，不是硬数据损坏。
- 为什么不在 4.6.1 做：只包事务仍挡不住跨进程；正确方案是 `(scope, hash)` 部分唯一索引 + 迁移去重，属 schema 变更。
- 触发条件：生产库出现同 scope 同 hash 的重复 pending 候选，或并发 PoC 复现。
- 验证：两个进程并发 ingest 同一候选句各 50 次，重复行恒为 0。

### R-02 `warmSemantic` 无调用点

- 状态：延后，先做基准再定。
- 事实：`lib/semantic-embed.mjs` 导出 `warmSemantic()`，仓库内无调用点。
- 为什么不在 4.6.1 做：CLI 每次预热会增加启动成本和约 37 MiB 常驻内存；“CLI 冷加载 453ms”是 4.2.1 旧数据，v4.6.0 未复测。
- 更好的方式：只给常驻 HTTP 服务做异步预热；CLI 保持按需，或转发到 7788。
- 触发条件：常驻服务首查延迟实测明显高于预热后，且内存预算允许。

### R-03 remote 向量队列只写不搜会丢向量

- 状态：延后，先量化召回损失。
- 事实：仅 `backend.kind !== 'hashed'` 时进入 4096 上限队列；默认 hashed 后端同步写入，不受影响。
- 为什么不在 4.6.1 做：改队列上限或写入侧 flush 会影响网络与写延迟，需要先知道丢多少、召回降多少。
- 触发条件：remote 模式只写 5k/10k 条再检索，召回下降超过可接受范围。
- 验证：记录 `vectorDropped`、补检索召回对比。

### R-04 性能用例并发假失败

- 状态：延后，归测试基建，不改产品预算。
- 事实：报告全量 10k p95 557ms，隔离 55ms；本机全量 483/483、项目索引专项 1.17s。
- 为什么不在 4.6.1 做：按一次慢盘/并发数据改阈值会失去回归价值。
- 更好的方式：CI 把性能用例单独串行跑；warm sync 用相对 cold 比例 + 宽松绝对上限。
- 触发条件：连续 5 次干净环境复现超预算。

### R-05 `store.mjs` 上帝模块与 `bind*Runtime` 隐式依赖袋

- 状态：延后，目标 4.7.0；本轮只做安全守卫共享化。
- 事实：`store.mjs` 约 3529 行，`bindRouteRuntime` / `bindToolRuntime` 注入大量函数。
- 为什么不做大爆炸拆分：SQLite 生命周期、迁移、向量、备份、租约耦合深，一次拆风险大于收益。
- 更好的方式：先加必填依赖清单与启动断言，再按热点逐块提取。
- 触发条件：新增功能再次显著扩大 `store.mjs`，或出现因漏注入导致的运行时报错。

### R-06 `client.js` 无 DOM 行为级测试

- 状态：延后。
- 理由：引入 DOM 测试环境会增加 dev 依赖和维护面；当前未发现 UI 逻辑导致的记忆核心故障。
- 更好的方式：先抽纯函数测试；出现重复 UI 回归再上 DOM 测试。

### R-07 vendor WASM/模型无签名

- 状态：延后。
- 理由：当前按字节数/哈希校验，Release manifest 已签 package/launcher；给 37 MiB 资产上签名会显著增加发布链复杂度。
- 触发条件：供应链威胁模型要求覆盖全部随包二进制。

### R-08 project-index 同步遍历阻塞事件循环

- 状态：延后。
- 理由：363 文件 211ms、1,001 文件专项整体 1.17s；典型项目不受影响。
- 触发条件：单仓超过 2,000 文件，或索引期间 HTTP p95 明显劣化。
- 更好的方式：只把扫描/读取换成异步分批，不重写解析器。

## 不采纳

### N-01 强行统一所有 limit 默认值

- 不采纳理由：MCP `memory_search`、HTTP `/search`、project search 服务对象不同，统一默认会破坏调用方。
- 替代：只修负数/非数越界；REFERENCE 写清每个入口的默认与上限。

### N-02 给 MCP 补 `persona clear`

- 不采纳理由：清空画像是破坏性管理能力，放在 HTTP 管理面更安全。
- 替代：文档标注“HTTP 管理面专属”。

### N-03 限制 `/project/sync` 的任意 root

- 不采纳理由：“任意项目一条命令建索引”是产品目标；限制 root 会砍掉核心能力。
- 替代：文档明确本机信任边界、CSRF、不要把 7788 暴露公网。

## 已知但不单独立项

- 非 strict 超长 body 静默变空对象：需要遍历 `/consolidate`、`/candidate`、`/project/sync` 等调用点，和 413 语义一起改；暂不塞进 4.6.1 安全补丁。
- OpenAPI `info.version=1.0.0`、`servers` 硬编码 7788：属描述性契约，等有外部 C 类宿主接入再改。
- `check-launcher` 在非 Windows 跳过、git fetch 硬编码 IP、历史 `.log` 噪音：环境/可用性问题，不单独发版。
- `verify-release` 响应体回显：本轮顺手截断；其余错误载荷统一等 API 错误码专项。

## 报告已过时或不成立

- “实跑 473/476”：4.6.1 后当前 `npm test` 为 483/483；报告环境总耗时 58.65s，存在并发争用和系统策略干扰。
- “DESIGN 仍是 4.5.1”：4.6.0 时已同步 4.6.0，4.6.1 已同步 4.6.1。
- “HOST-ADAPTERS 仍是 3.10.3 / 25 工具 / 10 path”：4.6.1 已同步 4.6.1 / 30 工具 / 26 路由 / 15 path，并修正“五通道同一文本”表述。
- “project-index warm sync 3.3s”：本机专项整体 1.17s，生产增量 95ms；未稳定复现。

## 复查记录

- 2026-11-26：4.6.1 完成。新增 7 个用例，全量 483/483；只读 Host、`/export` 方法、`/tool` 落层、负数 limit、审计告警、测试钩子门均已落地。R-01～R-08 继续延后，N-01～N-03 继续不采纳；下次复查在 4.7.0 立项前。
