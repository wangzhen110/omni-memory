# 全息记忆 4.6.19 完成报告（2026-11-28）

## 1 定位

本轮输入是 4.6.18 的外部复核（`CONSOLIDATED-REVIEW.md`，P0 0 / P1 4 / P2 13；P1 去重后四条）。四条都不是新功能，而是 4.6.18 修得不够彻底留下的口子：一条回归用例恒真、三类 facts/utterances 仍先 `LIMIT` 再过滤、一条云主机落证只写在汇总里、一条 fact `subject` 契约写得比代码严。按裁决直接修，文档类 P2 随版改完，分页性能类 P2 明确排 4.7.0。

## 2 根因与修法

### 2.1 E-18-02：回归恒真

- 事实：4.6.18 的 E-02 用例植入 `a00..a59`，原文字长 3。4.6.18 同时加了 SQL 预筛 `length(trim(text)) >= 4`，这批行在 SQL 层就被排除，分页循环根本没被走到。主理人把循环改成单页（`offset === 0`）后测试仍全绿，验证成立。
- 修法：植入 `★★★★`（raw 4、内容字符 0，能过 SQL 预筛、过不了画像门槛），并把条数参数化为 `59/60/61/200`：59 条时首屏就凑够；60 条起首屏 60 行里合格行数为 0，必须翻页才能拿到真规则。另加首屏 60 行断言。
- 变异验证：把 notes 循环改回单页 → 59 通过、60/61/200 三条转红；改回来即恢复。
- 顺带：SQL 预筛整体删除，`profile.mjs` 只用 JS 过滤作为唯一口径，少一层“文档与代码各说一套”的隐患。

### 2.2 E-18-01：facts 与 utterances 仍是 LIMIT 后过滤

- 事实：4.6.18 只改了 notes。`profileFactLines` 仍 `LIMIT 40`、persona facts 仍 `LIMIT 80`、utterances 仍 `LIMIT 100`，先取后滤。复核探针 C1：40 条内容字符为 3 的 high-confidence fact 写进去后，真 fact `部署端口 是 7788` 消失（`realFactRendered=false`）。
- 修法：三类全部页式。facts 页 40、合格上限 40；persona facts 页 40、上限 80；utterances 页 100、上限 100。每行判定与 notes 同源：subject/object 各 ≥1 内容字符、三元组合计 ≥4。
- 排序补 `id DESC`：原 `confidence DESC, valid_from DESC` 在同值时顺序不稳定，翻页会重复或漏读。
- 回归：插入 40 条 `s/r/o` 全是 3 字符 junk fact（confidence 1）后，真 fact 仍在画像；变异验证把 facts 循环改单页，该用例转红。

### 2.3 P1-3：云主机 reset 无落证

- 事实：`4.6.18-vm.txt` 只记到 update-log 提交 `a34128ae`，汇总写的是最终 `1808097`，中间缺“已 fast-forward 且干净”的记录。
- 修法：在云主机实跑 `git rev-parse HEAD`、`git log -1 --format=%s`、`git status --porcelain`，结果追加到该证据文件末尾；COMPLETION-4.6.18 §9 由“仍待补”改为“已覆盖”。

### 2.4 A-01：fact subject 契约失实

- 事实：DESIGN/REFERENCE 写“三条都校内容字符”，代码只有 `if (!subject)` 校非空；`subject:'★★'` 能写入，并渲染成 `- ★★ · 是：容器`。
- 修法：写侧加 `contentCharCount(subject) < 1` 拒绝，错误文案 `subject is required for kind=fact (it must contain a letter or digit)`；画像侧对 legacy 符号 subject 行不渲染。
- 危害按实测收窄：这条能入库、也能进画像，占一个槽位；不是“永不进画像”。文档按实测写，不沿用复核的夸张表述。

### 2.5 P2-07：`\p{N}` 口径

`contentCharCount` 从 `[\p{L}\p{N}]` 收到 `\p{L}` + `\p{Nd}`。`No`（圈码 `①②③`、上标 `²`）与 `Nl`（罗马数字 `Ⅰ`）都是装饰，不计信息。回归覆盖 `①①①①` / `²²²²` / `ⅠⅠⅠⅠ` 三种。

### 2.6 P2-10 / P2-13：install 文案与诊断日志

- `scripts/install.mjs` 的 `数据根目录` 改成 `result.home ?? result.plan?.home ?? '未解析（doctor 使用默认 ~/.dsh）'`，不再打印 `undefined`。
- `lib/profile.mjs` 在 `OMNI_PROFILE_DEBUG=1` 时向 stderr 打 `[profile-scan] {pagesRead,rowsScanned,stopReason}` 与 `eligible=n`；默认完全静默，不影响 CLI/HTTP 输出。

## 3 文档类 P2

- **契约统一（#1/#9）**：DESIGN §6.24 标题补到 4.6.19，正文写清四类源的页大小与上限、“读页次数线性、扫描量随行号增长”；REFERENCE 5.3 的 subject 校验、`\p{Nd}` 口径与代码对齐。
- **BENCHMARKS（#2）**：分类型表拆成“3.12.0 历史口径”与“4.6.18 复跑”两张，各标版本，不再让读者以为一张表横跨两个版本。
- **LoCoMo 归档（#8）**：`bench/public-retrieval.mjs` 自己在输出末尾写 `capturedAt`（ISO 时间）；本轮重跑并直接以脚本 stdout 归档，不再手工补 `codeVersion`/`machine`/`note`。
- **A-04 note#1315（#3）**：`4.6.17-context.txt` 追加只读 retention probe（`id=1315`、`text='x'`、`deleted_at=null`、`text='x'` 计数 1），并记录 `omni search "x" --limit 5` 的结果（12 候选、top-5 全是规则、note#1315 不在其中）。据此把三处“仍可搜”收窄为“仍在库中（按 id）、单字查询不进 top-5”。
- **VM TAP（#11）**：4.6.19 起云主机 TAP 原文与 sha256 一并进 `docs/evidence/`。

## 4 证据（逐字取自 docs/evidence/4.6.19.json）

```
579 tests / 579 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 111886.2947
# 10k rows: seed=489ms p95=40.7ms max=40.9ms hitTotal=200 total=1411ms
# 100k rows: seed=5244ms p95=63.9ms max=65.8ms hitTotal=200 total=6723ms
# 1000-file cold 178ms · warm 144ms · budget 2000ms
```

门槛文件单跑 14/14（4 条 4.6.17 原有 + 10 条本轮，含 E-02 参数化 4 条、facts 饥饿、符号 subject、圈码/罗马数字、NUL 截断）。两次变异验证见 §2.1/§2.2。

LoCoMo 检索-only 复跑（归档在 `docs/evidence/locomo-retrieval-4.6.19-session.json` 与 `-turn.json`，`capturedAt` 由 `bench/public-retrieval.mjs` 自产）：

```
session: recall@10 0.7240 / any 0.7699 / nDCG 0.5687 / 40.5s
turn:    recall@10 0.3179 / any 0.3562 / nDCG 0.2101 / 247.3s
dataSha256 79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4
```

与 4.6.18（session 0.7239 / turn 0.3185）同量级，差异在噪声内；本轮没有触碰检索路径。turn 距 0.40 目标仍差约 8 个点，4.7.0 优先处理。

## 5 判定

- 做：E-18-02、E-18-01、QA-01、A-01 四条 P1；P2 #1/#2/#3/#7/#8/#9/#10/#11/#13。
- 排 4.7.0：#5/#6（`OFFSET` 累计扫描 O(N²)、页间快照无一致性读）与 keyset 分页、只读事务同根，不半改；门禁三处复制、TAP→evidence 生成侧绑定继续排。
- 不成立：#4（NUL 截断）。SQLite 保留 NUL 字节，但读取与 `length()` 都在 NUL 处截断，模型看到的仍是 `ab`，不存在“被预筛隐藏的合法 4 字母”。

## 6 契约（4.6.19 更新）

1. **内容字符 = `\p{L}` 或 `\p{Nd}`**；`Nl`/`No`（圈码、罗马数字）、符号、标点、零宽、组合符都不计。
2. **四类画像源全部“先过滤后截断”**：notes 60/60、facts 40/40、persona facts 80/40、utterances 100/100；排序必须带 `id DESC` 兜底。
3. **fact 三元组**：subject/relation/object 三者都要至少 1 个内容字符；legacy 不合格行不渲染、不删除。
4. **诊断**：`OMNI_PROFILE_DEBUG=1` 才输出扫描统计，默认静默。

## 7 包内容

- 本轮修改代码：`lib/profile.mjs`、`lib/store.mjs`、`lib/tool-definitions.mjs`、`scripts/install.mjs`、`bench/public-retrieval.mjs`、`test/min-content-gate-4.6.17.test.mjs`、`package.json`、`package-lock.json`、`README.md`。
- 文档：`docs/{CHANGELOG,DESIGN,REFERENCE,BENCHMARKS,REMEDIATION-BACKLOG}.md`、`docs/COMPLETION-4.6.18-2026-11-27.md`、本报告、`docs/evidence/4.6.17-context.txt`、`docs/evidence/4.6.18-vm.txt`。
- 干净包数（Linux `git archive` + `npm pack --dry-run --json`）：tag 提交 `b2e1970d` = **233 files / 20,414,091 B**（比 4.6.18 的 229 多 4 项：本报告、`4.6.19.json`、两份 4.6.19 LoCoMo）。最终 HEAD 再追加 `4.6.19-vm.txt`、`4.6.19-vm.tap`（127,990B）与 `4.6.19-install-release.txt`，预期 **236**；工作树数字不作为发布口径。

## 8 发布链

- 内容提交：`f95bd088a7e51ef72e6267a6a0a2be737d761b2f`（本地 `e5c40b9f`）。
- update-log 提交（tag 指向）：`b2e1970d6ab7bab278818818f2d587b0ba9fa285`（本地 `ecc1d01b`）。
- tag object：`afb249bf912d323012846e0524f0625b60a0383e`；Release `461281164`（https://github.com/wangzhen110/omni-memory/releases/tag/v4.6.19）。
- 资产：`omni-update-manifest-v2.json` id `803110689`（632B）、`omni-update-manifest.json` id `803110756`（485B）。
- `npm run verify:release -- --tag v4.6.19`：OK；package.json SHA-256 `be2ab62c…3117`、launcher `d7ba3e76…6dce4`。
- `npm run setup`：doctor 通过（4.6.19、schema 20、2146 notes / 35 facts、HTTP 30 tools）；`/health` 返回 `version 4.6.19`。
- 云主机在 `f95bd088` 复跑 579（576 通过 / 3 平台跳过），TAP 原文与 sha256 见 `docs/evidence/4.6.19-vm.{txt,tap}`。
- 证据提交与最终 update-log：见远端 main HEAD（`docs/evidence/4.6.19-*` 与本节一并提交）。

## 9 未纳入

- #5/#6：`OFFSET` 分页的 O(N²) 上界与页间快照并发，与 keyset 分页、只读事务一起排 4.7.0。
- #12：4.6.18 及以前的 install 证据里的手工 `xBullet` 字段不回改（历史文件保留原样），本轮起以 context stdout 为唯一证据。
