# 全息记忆 4.6.20 完成报告（2026-11-28）

## 1 定位

4.6.19 的外部复核结论是“可定稿，不需要 4.6.20”。本轮不是为了响应复核而发，而是把两件连续三轮靠人记的纪律换成可执行文件：install 的回退分支此前只有实现、没有回归锁；fact 的四条报错文案只写在文档里，改一个词就悄悄漂移；云主机落证与汇总措辞连着三版出错。补丁只动测试、脚本守卫与文档，无行为变更。

## 2 install 回退分支上锁（P2-Q1）

- 事实：`数据根目录` 在 4.6.19 改成了 `home ?? plan.home ?? '未解析'`，但没有任何用例。复核指出这类“三级回退”最容易在后续重构中退化成 `undefined`，而 `undefined` 只在真实安装时出现在用户屏幕上，测试不看就永远不知道。
- 修法：`scripts/install.mjs` 在文件尾加 `export { human }` 与直接执行守卫 —— `process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url` 成立才调 `main()`。测试可以 `import`，`npm run setup` 行为不变。
- 覆盖三条分支：有 `result.home`；只有 `result.plan.home`；两者都没有 → 必须打印“未解析（doctor 使用默认 ~/.dsh）”。三条都断言整段输出不含 `undefined`。
- 同批发现同型 bug：`计划任务` 在 `plan.task` 缺失时打印 `计划任务: undefined`。改为 `result.plan?.noTask ? '不创建/不修改' : (result.task ?? result.plan?.task ?? '未解析')`。这是本轮唯一改到运行态的字符串，仍属文案层。

## 3 fact 四条报错文案逐字断言

- 事实：`lib/tool-definitions.mjs` 220–233 行四条文案，REFERENCE 5.3 逐字抄了一遍，但测试只断言“抛错”，不断言文字。4.6.19 的 A-01 修完 subject 校验时，带括号的变体就是这样与文档对上的 —— 靠人眼对，不靠测试对。
- 修法：`assert.rejects(fn, { message })` 精确匹配四条：
  `subject is required for kind=fact`、
  `subject is required for kind=fact (it must contain a letter or digit)`、
  `relation is required for kind=fact`、
  `object is required for kind=fact (pass object or a non-empty text)`。
- 补第五条的用意：文案锁太死会连合法路径一起拦掉，所以再断言一条完整 fact 能写入并返回行 id。

## 4 发版流程工程化

新增 `docs/RELEASE-CHECKLIST.md`，只收已经重复犯错的三类：

1. **云主机落证先跑后写**：汇总出现“已 reset 到 `<sha>`”前，VM 必须实跑 `git rev-parse HEAD` / `git log -1 --format='%H %s'` / `git status --porcelain`，原文追加进 `docs/evidence/<版本>-vm.txt`，汇总 SHA 与 `HEAD=` 行逐字一致。若之后还有 docs 提交，只能写“VM 停 `<有落证的 sha>`；最终 HEAD `<新 sha>` 只多 N 条 docs 提交”，并点名哪几条。
2. **跑测提交与最终 HEAD 分离**：`.tap` 与 evidence 只对跑测提交有效；最终 HEAD 若另加 docs 提交，必须 `git diff <跑测 sha>..<最终 HEAD> -- lib/ test/ scripts/ package.json package-lock.json` 为空，措辞不许写“在最终 HEAD 上测过”。
3. **汇总与仓库同源**：数字必须能在 `docs/evidence/` 或 `npm run check` 输出里找到出处；改口径时仓库与汇总同批改。

## 5 证据（逐字取自 docs/evidence/4.6.20.json）

```
584 tests / 584 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 114517.4138
# 10k rows: seed=482ms p95=60.1ms max=63.8ms hitTotal=200 total=1765ms
# 100k rows: seed=5218ms p95=60.4ms max=61.7ms hitTotal=200 total=6652ms
# 1000-file cold 244ms · warm 193ms · budget 2000ms
```

新增 5 条，均在本机全量里跑（非单跑）：`test/install-fact-contract-4.6.20.test.mjs`。ADR 与会话索引两档与 4.6.19 同量级（p95 60.1 / 60.4ms），本轮未触碰检索与存储路径。

## 6 判定

- 做：P2-Q1 回退分支回归锁、fact 四条文案断言、VM 落证与汇总措辞清单化。
- 未做（有意）：把 mtime 倒挂做成自动判据。复核只要求“回退分支有测试”，mtime 检查对 docs-only 提交会误报，收益不抵维护成本。
- 排 4.7.0：分页 keyset + 只读事务、turn 检索质量（0.318 → 0.40）、门禁三处复制收拢、TAP→evidence 生成侧绑定，均不变。

## 7 包内容

- 代码：`scripts/install.mjs`（导出 `human` + 直接执行守卫 + `数据根目录`/`计划任务` 回退）、`package.json`、`package-lock.json`、`README.md`。
- 测试：`test/install-fact-contract-4.6.20.test.mjs`（新增 5 条）。
- 文档：`docs/CHANGELOG.md`、`docs/DESIGN.md`、`docs/RELEASE-CHECKLIST.md`（新增）、本报告、`docs/evidence/4.6.20.json`、`docs/UPDATES.md`。

## 8 发布链

见下方“发布记录”小节，由发版后补写（tag、Release、资产 id、`verify:release`、`setup` doctor、云主机落证）。
