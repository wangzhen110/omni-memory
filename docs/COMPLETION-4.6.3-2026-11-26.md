# 4.6.3 测试门禁收口报告

日期：2026-11-26 · 版本：4.6.3 · schema：20 · 前置复核：`docs/复核报告-4.6.2-2026-11-26.md`

## 结论

4.6.2 的代码整改与发布链成立；复核指出的 `3.1` 漏跑检测、`3.3` 重复摘要绕过、`3.2` “二道门”定性和 `3.4` macOS 平台条件均按最小修复处理，不打补丁式重构，不改 schema。

4.6.2 的 `486/486` 有真实 TAP 记录，但当前工作树在 docs 被移入回收站后无法完整复验。本次先把缺失 docs 从回收站取回，再做全量验收。

## 修复

### 1. TAP 低于声明数必须失败

`scripts/check-docs.mjs` 以 TAP 作为 pass/fail 真值，但新增：

- `tap.tests >= declaredTests`，其中 `declaredTests` 是 `test/*.test.mjs` 中 `^test(` 的声明数。
- 测试文件因 glob、语法或加载失败没有被 runner 发现时，`# tests` 变小会直接 `FAIL TAP covers every declared test`。
- README、DESIGN 的计数仍以 TAP 为准；计数变小会同时触发 badge、用例行与 NFR 不一致，不能只靠 `fail=0` 过关。

### 2. TAP 摘要唯一与 plan 闭合

`scripts/check-test-results.mjs` 新增：

- 每个 `# tests`、`# pass`、`# fail`、`# cancelled` 标签全文件只能出现一次；重复摘要直接拒绝。
- 全文件只能有一个 `1..N` plan，且 `N === # tests`。
- 复现用例：前段 `# tests 4 / # pass 4 / # fail 0`，后段 `# tests 4 / # pass 3 / # fail 1`，旧版 exit 0，新版 exit 1。
- 另一个反例 `1..5` 配 `# tests 4`，新版 exit 1。

### 3. 测试钩子改为“防误设”

`testModeEnabled()` 仍要求 `OMNI_TEST_MODE=1`，但 `NODE_TEST_CONTEXT` 收紧为 Node 测试运行器实际写入的 `child` / `child-vN`：

- `OMNI_TEST_MODE=1` + `NODE_TEST_CONTEXT=x` 不再启用测试钩子。
- `child` 与 `child-v8` 正常启用。
- 文档明确该门只防部署脚本误设；能写进程环境的主体仍可伪造，不承担抗篡改职责。

### 4. 平台条件与缺文档诊断

- `property-scope-alias` 的大小写别名断言改用被测语义变量 `platform`，仅在 `platform !== 'linux'` 时要求 legacy 与 canonical 不同，修正 macOS 上按 Linux 语义误跑。
- `check-docs` 缺失 DESIGN/REFERENCE 等必需文件时输出 `missing required doc: <path>` 并退出，不再抛未捕获 `ENOENT`。
- 4.6.2 完成报告的 482 数字口径改为 `486 tests / 482 pass / 2 fail`。

## 验证

- `npm run verify`：486 tests / 486 pass / 0 fail / 0 cancelled / 0 skipped，约 30.2s。
- TAP 真值门：486 passed, 0 skipped, 0 failed。
- 文档门：version 4.6.3、15 OpenAPI paths、26 routes、30 MCP tools、32 ADRs 全部一致；新增 `TAP covers every declared test`。
- 负向实测：TAP 485/485 触发 5 条文档不一致，其中包含 `TAP ran 485, but 486 test declarations exist`；重复摘要与 plan 不一致均 exit 1。
- 1000 文件索引：cold 925ms、warm 883ms、budget 2000ms。

## 未改

- 不恢复 4.6.2 tag、不改已发布 Release 资产；4.6.3 另行打 tag。
- 不引入新的鉴权体系，不改检索权重，不降 ADR-020 的 p95 预算。
- 不把测试钩子包装成安全边界。
