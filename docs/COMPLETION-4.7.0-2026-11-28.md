# 全息记忆 4.7.0 完成报告（2026-11-28）

## 1 定位

起点是一句实话：4.6.22 定稿时，检索层的 session 粒度 0.7240 已经站得住，turn 粒度只有 0.3179，答题层根本没有数字。于是本轮只做两件事——把 turn 拉过 0.40 并把三条硬阈值真正接进 `npm run check`；把 LoCoMo 答题层补上，先跑固定种子的 500 题子集落数。按既定规则（功能型迭代）定为 4.7.0，4.6.22 的 tag、Release 与包内容不动。

## 2 turn 粒度：0.3179 → 0.5114

全程同一题集（LoCoMo 全量 1,982 有 evidence 的 QA）、同一命令（`node bench/public-retrieval.mjs --granularity turn --ctx 2 --expand --k 10`），逐项淘汰：

- 裸 turn 基线 0.3312。查询侧「邻句 ±1 并新行」0.3215，变差；「session 家族整段并新行 + cap3」0.0336，灾难性变差——新增行把正确命中挤出前 10。
- 新加行这条路整体判死，改写入口：bench 增 `--ctx N`，把前后 N 轮拼进同一条 turn 笔记（`source` 仍是 `locomo:<sample>:<dia_id>`）。`--ctx 1` 0.3811、`--ctx 2` 0.3815，取 2。
- 查询侧只做重排、不做增删：`sourceFamily` 取 source 最后一段分隔符之前的前缀，`expandContext` 只对已召回行按 `strength×(0.4+0.6×自身词面覆盖)` 向家族最高分抬升。强度扫 0.15–1.5，0.3 最优；种子 8→48 单调变好，48（整池）最优。
- 关键一击不是调参而是纠错：`queryTerms` 原来保留 what / did / the 这类英文功能词，几乎每篇笔记都命中，词面项被稀释。剔除约 60 个功能词后，**只动这一处**的全量 turn 就从 0.33 级跳到 0.4081；叠加 `--ctx 2` 与家族重排到 **0.5114**（any 0.5469、nDCG 0.2929）。
- 对比口径：开本地语义模型裸 turn 0.3534，但「语义 + 上下文」0.3665，短对话语料上语义是噪声，所有归档口径都不开语义。

session 粒度同轮复跑 0.7279 / any 0.7735 / nDCG 0.5612，比 4.6.19 的 0.7240 略升——功能词剔除对 session 也是净收益。

## 3 闸门：三条硬阈值进 `npm run check`

- `scripts/retrieval-gate-lib.mjs` 定义阈值：session recall ≥ 0.70、session nDCG ≥ 0.55、turn recall ≥ 0.40；turn 不设 nDCG 门，因为两种粒度的 nDCG 分母不同，turn 上设门只会逼着改口径。
- `scripts/check-retrieval-gate.mjs` 用固定 seed 42 的 500 题分层子集跑两个粒度，任一不达标 exit 1；数据集缺失（新克隆还没 `bench/fetch-public.mjs`）或 `OMNI_RETRIEVAL_GATE_OFF=1` 时打印 SKIP 并放行。
- 已挂到 `package.json` 的 `check` 末尾，另开 `check:retrieval` 单独跑。实测门禁 84.6s，session 0.7434 / nDCG 0.5699、turn 0.5218。
- 闸门自身修过两个 bug：bench 输出是 pretty JSON 多行（改为整段 parse）；数据集是 gitignore 的（补 SKIP 分支）。

## 4 答题层：先有可复现的确定性基线

- `bench/locomo-lib.mjs`：语料写入（session 按 3,500 字分块 / turn 按 dia_id 逐条可带上下文）、题目抽取、分层固定 seed 抽样、抽句、tokenF1、规则判分。
- `bench/locomo-qa.mjs`：生成与判分都可插拔（extractive|llm × rule|llm），LLM 走 OpenAI 兼容端点，缺 key 直接报错不静默回退；token 账单独记；category 5 对抗题不进 accuracy，单列。
- 500 题（seed 42）三轮迭代：整句抽取 0.0801 → 加逐字包含判分 0.0879 → 加题型启发（when→日期、how many→数字）→ **accuracy 0.1189 / contained 0.0775 / tokenF1 0.1126 / evidenceRecall 0.4945**，对抗排除 113 题，耗时约 72s。
- 这个数字必须带着限定说：抽句式生成 + 规则判分，不是 LLM 问答，**不可与 mem0 的 92.5 直接比较**。它在仓库里的作用只有一个——把「答题层有数」从口头承诺变成可复跑的基线，后续接 LLM 才有对照组。

## 5 代码改动

- `lib/search.mjs`：新增 `STOP_TERMS` 与 `sourceFamily`；`expandContext` 精简为 boost-only（删掉 add / mix / cap / agg 全部死代码），只重排同一批行，不增不减；`runSearch` 末尾按 `expand ?? OMNI_SEARCH_EXPAND === '1'` 走重排再 rerank。
- `lib/tool-definitions.mjs`：`memory_search` 增 `expand` 参数（`additionalProperties: false` 下必须同步声明）。
- `bench/public-retrieval.mjs` 重写为用 locomo-lib，保留旧 flag 并新增 `--ctx`、`--dump`。

## 6 测试

589 → **604**。新增 `test/retrieval-context.test.mjs`（4 条：家族键、功能词剔除、重排不增减、无家族键不动）、`test/locomo-qa.test.mjs`（5 条）、`test/retrieval-gate.test.mjs`（5 条），并按 4.6.22 复核延后项的触发条件（测试数要变）补了 TAP 证据脚本的 `unresolved` 分支断言。

云主机复跑当场抓到 4.7.0 自己的一个真 bug：`test/locomo-qa.test.mjs` 在模块顶层直接 `readDataset()`，数据集是 gitignore 的，新克隆一跑就 ENOENT、整个测试文件崩掉。已改为 `existsSync` 守卫 + `test(..., { skip })`，本地缺数据集时 3 pass / 2 skip，云主机 599 pass / 5 skip / 0 fail。这条是云主机复跑的价值证明，不是形式步骤。

## 7 证据（取自 docs/evidence/4.7.0.json）

```
604 tests / 604 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 112207.439
# 10k rows: seed=483ms p95=51.8ms max=55.2ms hitTotal=200 total=1671ms
# 100k rows: seed=5217ms p95=64.6ms max=66.4ms hitTotal=200 total=6638ms
# 1000-file cold 216ms · warm 168ms · budget 2000ms
```

首行是汇总行，TAP 字面为 `# tests 604` 等分列行。`tapSha256` 记录这轮 TAP 的字节指纹。检索与答题的原始 JSON 在 `docs/evidence/locomo-retrieval-4.7.0-{session,turn}.json` 与 `docs/evidence/locomo-qa-4.7.0.json`。

## 8 发布链

- 内容提交（本地 `9bce5b05` → 远端 `d7035062`）被后续一条测试修复提交接上：修复提交本地 `a6f3596c` → 远端 **`f6fb21a9ef359db97d05e15795d6d0847737b9a1`**，tag `v4.7.0` 与 Release 都指向它。SHA 变化来自推送通道改写，以远端为准。
- tag object `31da643e34fb800bb8e79c37c868ea11f280d952`；Release `461427034`（`https://github.com/wangzhen110/omni-memory/releases/tag/v4.7.0`）；资产 v2 `803921319`（629 B）、v1 `803921382`（482 B）。
- `npm run verify:release -- --tag v4.7.0` 输出 `OK: signature, package hash, and launcher hash are consistent`，`package.json` sha256 `fb6c3b38489a5859893cd3f2a855770828f18adc614b0ad23708170f3d50d96d`，launcher `d7ba3e76…6dce4` 15360 B。
- 干净包数（`git archive f6fb21a9` 后 `npm pack --dry-run --json`）：262 files / 20,548,405 B / unpacked 44,449,853 B，原始 JSON 在 `docs/evidence/4.7.0-pack.json`。
- 云主机在 `f6fb21a9` 干净检出复跑：604 tests / 599 pass / 5 skip / 0 fail，`# duration_ms 92263.293283`，TAP sha256 `8652fca539f4b1bd52ffb969b850747173652dbc0094cc5afb02cc846b5dc274`（133,172 B）。5 条 SKIP 是 3 条 Windows-only（launcher ×2、路径键 ×1）+ 2 条数据集未取（LoCoMo 抽样）。
- 证据回传：临时 deploy key `171393266` → 云主机推 `evidence/4.7.0` → 本机按 Contents API 取回并校验 TAP sha256 一致 → 删分支 ref（204）、删 key（204），云主机切回 main 并 `reset --hard`。

## 9 取舍与未做

- 查询侧加行方案全部弃用，理由是实测 0.3215 / 0.0336：它破坏 top-k 名额，不是参数没调好。
- turn 不设 nDCG 门：两种粒度分母不同，硬设只会诱导改口径。要提升 turn 的 nDCG 是下一轮的事，不是本轮的验收项。
- 答题层 LLM 路径本轮无可用 key，只落确定性基线；是否花约 350 万 token / 500 题实跑 LLM 生成 + LLM 判分，留给用户拍板。文档里已写明不可与 mem0 92.5 比较。
- 4.6.22 积压的分页 keyset + 只读事务、门禁三处收拢、TAP→evidence 的密码学绑定（本轮只有字节指纹）仍未动，留在 BACKLOG。
