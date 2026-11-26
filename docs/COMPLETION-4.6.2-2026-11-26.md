# 4.6.2 整改完成报告：复核收口与测试真值

日期：2026-11-26 · 版本：4.6.2 · 前置报告：`docs/整改复核报告-2026-11-26.md`

## 结论

4.6.2 处理复核报告中经代码与实测确认的 6 类问题：无 Host 放行、规则文本分叉、测试模式单门、文档漂移、`check-docs` 盲区、测试可移植性。不改 schema（仍为 20），不改检索权重，不降低 p95 预算。

复核报告对“伪造 Host 已修好”的确认成立；其“483/483 全绿失真”的总体判断在发布机上不成立。发布机 4.6.1 完整 TAP 为 483/483、0 fail；报告环境的 486 tests / 482 pass / 2 fail 来自沙箱拦截 `schtasks`、硬编码 Windows 路径与慢盘争用。4.6.2 已把这些环境依赖改成可移植断言，并新增 TAP 真值门，后续再不能用源码 `test(` 计数冒充运行结果。

## 逐项处理

### 1. 插件侧无 Host fail-closed

`lib/read-routes.mjs` 原判断为“有 Host 且不可信才拒绝”，无 Host 时插件路由直接放行；standalone 服务端会拒绝。现在先做 loopback 校验，再无条件执行 `hostHeaderAllowed(req)`，缺失或伪造 Host 都返回 403。

测试侧所有直接构造的请求显式注入 `Host`；新增两项回归：

- 插件路由无 Host 读 `/export` 返回 403。
- 原始 HTTP 无 Host 请求被协议层 400 或守卫层 403 拒绝，均不返回记忆正文。

浏览器 DNS rebinding 必带 Host，因此原缺口不是现实攻击面；本项按防御纵深处理。

### 2. 规则文本统一

`hosts/mcp/bin.mjs` 原为 5 行摘要，`hosts/http/server.mjs` 原为另一段单行摘要。4.6.2 两处 `initialize.instructions` 都改为完整 `RULES_TEXT`，与 `prompts/get`、`resources/read`、`memory_rules` 同文。

新增断言：stdio 握手返回的 `instructions` 必须严格等于 `RULES_TEXT`；HTTP `/mcp` 握手同样校验。

### 3. 测试模式二道门

`OMNI_TEST_MODE=1` 原来单变量即可启用本地 git 源、自签公钥、自定义 keyId/指纹。现在 `testModeEnabled()` 要求同时存在 `NODE_TEST_CONTEXT`，该变量只由 `node --test` 及其子进程设置。

部署侧误设 `OMNI_TEST_MODE=1` 时只打印告警并忽略测试钩子，不能替换验签链。新增纯函数测试覆盖三种组合。

### 4. 测试可移植性

- 项目路径用例不再硬编码 `C:\...`。新增 `projectCwd()` 在系统临时目录下生成工作区，避免 Linux 上合成 Windows 路径落入仓库并误取 `.omni-project` 身份。
- `daily-sync-success` 在 `schtasks.exe /Query` 不可用时明确 skip，正常 Windows 仍跑真实计划任务端到端。
- 1000 文件 warm sync 原为固定 2000ms。现在保留 2s 下限，同时允许不超过 2 倍 cold 的慢盘预算，并输出 cold/warm/budget 诊断。没有降低产品 p95 预算。
- `npm test` 全局超时从 60s 提到 120s，避免慢盘把文件级用例误判为超时。

### 5. 测试真值门

`npm test` 同时输出 spec 与 TAP 到 `.test-results.tap`；新增 `scripts/check-test-results.mjs`，要求：

- TAP 摘要完整，`# tests` 非零。
- `# fail` 与 `# cancelled` 必须为 0。
- `pass + skipped + todo == tests`，防止摘要截断或漏跑。

`npm run verify` 改为 `npm test && node scripts/check-test-results.mjs && npm run check`。`check-docs` 有 TAP 时用真实 `# tests`，无 TAP 时才退回声明计数，并明确输出 `(TAP)` 或 `(declared)`。

### 6. 文档补漏与检查门扩展

- README 规则段从“五条通道、同一份文本、永不漂移”改为“五条入口共享同一份 `RULES_TEXT`”。
- REFERENCE 的 REST `/search` 补 `limit` 默认 30、上限 60、越界静默钳制。
- REFERENCE 与 memory_persona 明确 `clear` 仅 HTTP 管理面，MCP 工具只支持 `get|set|refresh`。
- DESIGN/CHANGELOG 修正 `OMNI_TEST_KEY_FILE` 为实际变量 `OMNI_TEST_UPDATE_PUBLIC_KEY_FILE`。
- `check-docs` 新增：HOST-ADAPTERS/REFERENCE 规则口径、REST limit、persona 归属、OpenAPI 实际 path 数、stdio/HTTP instructions、旧变量名、TAP fail 计数。

## 验证证据

### Windows 发布机

- `npm test`：`# tests 486`、`# pass 486`、`# fail 0`、`# cancelled 0`、`# skipped 0`，约 28.8s。
- TAP 真值门：`486 passed, 0 skipped, 0 failed`。
- `npm run check`：文档一致、71 文件语法通过、客户端 3 个 slot、语义资产 11 文件 37.5 MiB、launcher hash 一致、update log 覆盖 122 个提交。
- 1000 文件索引诊断：cold 952ms、warm 759ms、budget 2000ms。

### Linux 云主机

首轮 486 tests / 482 pass / 1 fail / 3 skip。唯一失败是属性测试仍假设“Linux 上 legacy key 与 canonical key 必然不同”；实际 Linux canonical 保留大小写，两者本应相等。修正断言后提交 `f6f2154`。

复跑结果：

- `# tests 486`、`# pass 483`、`# fail 0`、`# cancelled 0`、`# skipped 3`，约 87.6s。
- 3 个 skip 均为平台限定：launcher 安装 2 项、Windows/macOS 大小写别名迁移 1 项。
- 1000 文件索引诊断：cold 110ms、warm 49ms、budget 2000ms。
- 文档、语法、客户端钩子、语义资产与 OpenAPI 检查通过；`docs/UPDATES.md` 在发版提交后补齐。

### 复核报告环境差异

报告环境 warm sync 4183ms 未在发布机或 Linux 云主机复现。4.6.2 没有为迁就慢盘降低产品 p95；只把测试从“固定 2s 必过”改为“2s 或 2×cold，并输出诊断”。

## 明确未做

- 不降低 ADR-020 的 p95 预算。
- 不给 MCP 增加 `persona clear`；清空仍只走 HTTP 管理面。
- 不引入新的 token 鉴权体系。
- 不改 schema，4.6.2 仍为 20。

## 发布

- 代码提交：`e4d9c752`（4.6.2 主体）、`f6f2154`（Linux 测试断言修正）。
- 发布方式沿用 4.6.1：annotated tag `v4.6.2`、签名 manifest、GitHub Release、`verify:release` 校验、生产 7788 升级、云主机快进。
- 发布完成后以 tag 指向的最终提交为准。

## 风险与后续

- 无 Host 的原始 HTTP 在 Node HTTP 解析层先返回 400，插件层返回 403；两者都是 fail-closed，测试同时接受两种拒绝路径。
- GitHub 网页/443 推送通道在本机被重置，4.6.2 使用 GitHub Git Data API 创建同一 tree/commit，并把本地与远端 ref 对齐到同一 commit 对象；不影响签名链。
- 慢盘上的 warm sync 仍有环境敏感性，后续若再次出现，优先用诊断数据定位，不直接放宽产品预算。
