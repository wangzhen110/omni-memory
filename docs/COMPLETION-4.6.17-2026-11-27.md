# 全息记忆 4.6.17 完成报告（2026-11-27）

## 1 定位

本轮不是外部评审项，而是 4.6.16 自评时当场暴露的一个真实缺陷：生产常驻画像里混进一条单字符笔记 `x`（note#1315），按 `importance DESC, ts DESC` 拿到一个 1200 字符预算里的常驻槽位，把真规则挤了出去。修法分两层：写入侧拒绝退化文本，画像侧抬高信息量门槛（既有库里的垃圾也花不掉预算），并顺手把“检索质量可证性”的路线写进 docs，作为 4.7.0 的预置。

## 2 根因与修法

### 2.1 事实复核（先证伪再动手）

- 生产库 `C:\Users\Administrator\.dsh\memory\omni.db` 活行中 `length(trim(text)) < 12` 的笔记**只有 1 条**：id=1315、scope=`proj:全息记忆#30534c`、text=`x`、ts 对应 2026-11-25。
- `lib/profile.mjs` 的 `buildProfileText` 只按 `importance DESC, ts DESC LIMIT 60` 取行，再用 `profileEligibleNote` 过滤主题（知识库、测试报告、工具噪声），**没有任何信息量下限**。`x` 与主题过滤器不冲突，于是入选。
- 结论：不是排序 bug，是“候选资格”缺一道最小信息量检查；且旧版本已写入库，只改写入侧不能救现有库。

### 2.2 修法（两层 + 一条旁路）

1. **写入侧**：`memory_write` 的 note/episode 与 `memory_amend` 要求 ≥2 个“内容字符”（空白、标点、分隔符不计），不足抛 `text is too short (N content characters)`。facts 豁免，因为其正文可由 subject/relation/object 派生。
2. **候选旁路**：`writeCandidateNoteInTransaction`（`memory_candidate` accept 的真实落库路径）同门槛，避免转录候选绕过 `memory_write` 把 `x` 写进来。
3. **画像侧**：`profileEligibleNote` 与 `personaEvidenceEligible` 要求 ≥4 个内容字符。因此**已入库**的 note#1315 不再占常驻额度，不需要改库、不需要软删。
4. **不删数据**：被门槛挡住的记录仍可 `memory_search` 取回；是否清理由用户显式 `memory_forget` 决定。

### 2.3 生产复验（同一份库、同一命令）

修复前 `omni context` 的「当前项目」节出现 `- x`。修复后用仓库代码直读生产库：

```
## 当前项目
- 画像循环内也会饿死（4.6.16）：addSection 写指针前必须校验 ...
- 交付文档结构反模式（4.6.9 快照三轮返工得出）：...
```

`- x` 消失，槽位回到两条真实项目规则；全局四条的排序与内容未变。

## 3 证据（逐字取自 docs/evidence/4.6.17.json）

```
568 tests / 568 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 116161.1467
# 10k rows: seed=517ms p95=68.9ms max=69ms hitTotal=200 total=1890ms
# 100k rows: seed=5476ms p95=79.7ms max=81.5ms hitTotal=200 total=7280ms
# 1000-file cold 251ms · warm 204ms · budget 2000ms
```

新增回归 `test/min-content-gate-4.6.17.test.mjs`，3 条：

1. 退化文本 `x / 中 / ... / · / ?` 被 `memory_write` 拒绝；`ab`（2 内容字符）通过边界；episode 同门；fact 豁免。
2. `memory_amend` 不能把真笔记缩成 `x`。
3. 直接向库插入一条旧版遗留的 `x`（模拟 note#1315），`memory_profile` 只纳入真规则（`included.length === 1`），且 `- x` 不渲染；`memory_search` 仍能搜到该行（过滤≠删除）。

`property.test.mjs` 两处夹具从 `x` 改为有意义文本，恢复它们原本要验证的 `importance` / `scope=all` 校验意图（否则新门槛会让它们“因错误原因通过”）。

## 4 判定

- 做：写入侧 + 候选路径 + 画像侧三层同门槛；`x` 类垃圾在本机生产库已不再占预算。
- 不做：批量清理历史短笔记。当前全库只有 1 条，删除属于显式遗忘动作，不能由门禁代劳。
- 不改：schema 仍 20、预算仍 1200、`memory_write` 输入形状不变（只是多一种显式拒绝）。

## 5 契约（本轮新增/收窄）

1. **内容字符定义**：去掉空白、标点、分隔符后按码点计数；中英文等权（4 个汉字的规则与 4 个字母的词同样算 4）。
2. **写入门槛 = 2**：低于 2 个内容字符的 note/episode/amend 一律拒绝，错误语固定为 `text is too short`。
3. **画像门槛 = 4**：低于 4 个内容字符的记录不进入常驻画像与 persona 证据；不影响检索。
4. **facts 豁免**：`kind=fact` 不走文本门槛，由 subject 必填与 object/relation 校验负责。
5. **候选同门**：`memory_candidate` accept 与 `memory_write` 同门槛，错误语不同（`candidate text is too short ... reject it instead`）。
6. **过滤不删除**：门槛只影响“能否占预算/能否入库”，不改变已有记录的可检索性。

## 6 取舍与未纳入

- **不引入“内容质量打分”**（如 LLM 判断一句话是否有价值）：会打破零 API 依赖与确定性，且 1200 字符的预算问题用长度门槛已能解决 90%。
- **不做“短笔记自动合并”**：合并需要语义判断，风险高于收益；短而有效的规则（“一律用中文”）必须保留。
- **不把 4 个字符门槛做成可配置**：配置项会被调成 1，回到今天的问题；如需更严格，应改常量并同时改回归。
- **检索质量可证性**：只落路线（`docs/BENCHMARKS.md` §6），不实装。答题层需要固定模型 + judge + 约 350 万 token 的子集跑，属于 4.7.0 的独立迭代，不应塞进补丁版。

## 7 包内容

- 发布提交（`7b8c0ad`，含完成报告与 TAP 证据）：`npm pack --dry-run` **222 files / 21,318,743 B**。
- 最终 HEAD（再含 `4.6.17-vm.txt` 与 `4.6.17-install-release.txt`）：**224 files**（两文件均为纯 docs 增量）。
- 本轮新增/修改文件：`lib/store.mjs`、`lib/profile.mjs`、`lib/tool-definitions.mjs`、`index.js`、`test/min-content-gate-4.6.17.test.mjs`、`test/property.test.mjs`、`package.json`、`package-lock.json`、`README.md`、`docs/{CHANGELOG,DESIGN,REFERENCE,REMEDIATION-BACKLOG,BENCHMARKS}.md`、`docs/evidence/4.6.17.json`。
