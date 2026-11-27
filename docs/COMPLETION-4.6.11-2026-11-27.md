# 4.6.11 完成报告 — 覆盖率盲区补测（2026-11-27）

## 1. 版本定位

4.6.11 是**只补测试与证据**的补丁版：不改 schema（仍为 20），不动检索权重与
300ms 预算，不改任何产品代码路径。目标是把 4.6.10 技术债盘点里“覆盖率盲区”
四条落成可复跑的用例与一份双跑对照证据。

## 2. 新增用例

- `test/read-dream-routes-4.6.11.test.mjs`：走真实独立 HTTP 适配器，覆盖
  `/omni-memory/dream/replace`、`/dream/rollback`、`/dream/proposals`
  的正常往返（replace → rollback → 二次 rollback = `not superseded`）、
  `note not found`、`noteId required`、两个 GET 405、`scope=all`。
- `test/doctor-branches-4.6.11.test.mjs`：直接调用 `runDoctor`，覆盖缺
  `package.json`、数据目录未建、库不存在、非法端口 99999、垃圾字节库、
  空库缺表、可达但版本不符的健康服务，以及 `strict` 下 0 错误仍不通过。
- `test/dream-timer-dispose-4.6.11.test.mjs`：`OMNI_DREAM_INTERVAL_MS`
  未设时不建定时器；设为 50 时创建 1 个句柄，effect disposer 调用
  `clearInterval` 且清的就是该句柄。
- 全量：**550 → 556**，全部通过。

## 3. 逐字证据（来自 `docs/evidence/4.6.11.json` 与 `.test-results.tap`）

```
556 tests / 556 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 117291.5032
# 10k rows: seed=650ms p95=59.1ms max=65.2ms hitTotal=200 total=1839ms
# 100k rows: seed=7271ms p95=67.2ms max=78.4ms hitTotal=200 total=8846ms
# 1000-file cold 303ms · warm 265ms · budget 2000ms
```

## 4. 覆盖率双跑结论（证据：`docs/evidence/4.6.11-coverage.txt`）

1. `hosts/http/server.mjs` 两次全量都是 **320/345**，命中行集合完全一致；
   4.6.8 复核记录的 205→217 在本轮无法复现，判定为“提交间差异”，
   不再按运行抖动处理。
2. `hosts/cli.mjs` 仍抖动（637 与 641，行 667-670 时有时无），如实记录为
   采样不稳定点，不当作回归。
3. 相对 4.6.9 基线：`doctor.mjs` 258→**302**/348，`lib/read-routes.mjs`
   1118→**1150**/1296（dream 路由整段转绿），`server.mjs` 314→**320**/345。
4. `lib/store.mjs` 净 **-6** 行（2925-2934 备份导入冲突分支本次未命中，
   2480-2481 新命中）。单跑 `test/backup*.test.mjs` 复核：2925 与 2928-2934
   仍为 0 命中，说明那 8 行在 4.6.9 由偶发状态覆盖。按事实记录，不计入成果，
   也不为凑覆盖改产品代码。

## 5. 取舍

- **不引入 DOM 环境**：`client.js` 的行为级测试需要 jsdom 一类依赖，补丁版
  不接受新 devDependency，R-06 继续延后。
- **不为覆盖率改代码**：`store.mjs` 的 -6 行不通过改实现或放宽断言去补。
- **不把双跑做成门禁**：两次全量约 4 分钟，且 cli 仍有抖动，做成门禁只会
  引入假失败；本轮把结论写进证据文档，等 CI 引入后再评估。
- **R-01 与 schema 21 仍放 4.7.0**：事务/唯一约束迁移需要真实并发验证，
  不属于补丁版范围。

## 6. 复现

```
npm test
node --experimental-test-coverage --test --test-concurrency=1 \
  --test-reporter=lcov --test-reporter-destination=.coverage-a.lcov "test/*.test.mjs"
```
