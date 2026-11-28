# 全息记忆 4.6.22 完成报告（2026-11-28）

## 1 定位

输入是 4.6.21 的外部复核：P0 0 / P1 1 / P2 5。唯一 P1 不在代码或发布链上，而在完成报告本身——它把发行提交 `c9cda483` 写成「最终远端 main」，随后两笔纯 docs 提交让这句话当场过期；更尴尬的是同一版发版清单刚把这种写法删掉。P2 五条都落在证据粒度：commit 标签靠事后手改、生产 health 无独立落证、TAP 与提交只有时间旁证、报告与汇总互相指向不存在的文本、汇总口径未限定版本。

本版按裁决直接修，出 4.6.22；4.6.21 的 tag、Release 与包内容一律不动。

## 2 P1-1：完成报告不再写死最终 HEAD

4.6.21 报告里两处被判不合格：`最终远端 main c9cda483`、`最终 HEAD c9cda483 上 check exit 0（185 hashes）`。现在改成时点表述，写清三件事：发行提交是哪个、当时 check 在那个提交上 exit 0 且 hashes 是多少、此后 main 只追加了哪些 docs 提交且跨版代码 diff 为空。

`docs/RELEASE-CHECKLIST.md` 新增第 5 节，把这条从「清单里有」升级为「清单与完成报告都适用」：完成报告只能写时点 + `git diff` 为空，写「最终 HEAD」直接算不合格。这是 4.6.19、4.6.20、4.6.21 连续三次同型复发，必须落到规则文本里，不能靠下一次记性。

## 3 P2-L2 / P2-L4：commit 标签改成生成时写入，并加 TAP 字节指纹

4.6.21 的 `docs/evidence/4.6.21.json` 里，`commitSha` 先由脚本写入本地 `91d9b76b`，推送后被手工改成远端 `c7da8cfb`，`commitShaSource` 也从 `flag` 手改成 `flag (remote sha after push)`——这个字面量脚本本身产不出来，重跑就被覆盖回 `flag`。问题不在数值真假，而在这条证据链「不可复现」。

处置：

- `scripts/tap-evidence.mjs` 新增 `--commit-source`，来源字符串随生成一次写入，不再事后编辑；不给该参数时行为与 4.6.21 一致（`--commit` → `flag`，默认 → `git rev-parse HEAD`，取不到 → `unresolved`）。
- 新增 `tapSha256` 与 `tapBytes`：哈希的是 TAP 原始字节，任何人拿归档 TAP 重算即可比对。这把「TAP 属于哪个提交」从 mtime 旁证升级成内容指纹——注意它证明的是文件同一性，不是密码学意义上的提交绑定，这一点在报告里写清，不再含糊。
- 补 4 条用例锁住三值语义与字节哈希，防止下一轮改脚本把 `--commit-source` 悄悄退回。

## 4 P2-L3：install 落证

4.6.21 声称 `npm run setup` 后 health 4.6.21 / 30 tools / 2152 notes / 35 facts，但 `docs/evidence/` 下没有对应文件。本版把 `npm run setup` 输出与安装后的 `/health` 当场落 `docs/evidence/4.6.22-install-release.txt`，不回溯补造 4.6.21 的文件。

## 5 P2-A3 / P2-A4：文档互相指向不存在的文本

- 4.6.21 完成报告里 P2-L6 写「本轮汇总按实计口径写『4 条实质 docs 改动 + 4 条 update-log』」，但那份汇总全文没有这句话。已改成与实际归档文本一致的表述。
- 汇总里的「只有一处文案层防御与两处脚本/文档改动」沿用 4.6.20 的累积口径，读者会误把它当成本版改动量。本版汇总补版本限定。

## 6 证据（取自 docs/evidence/4.6.22.json）

```
589 tests / 589 pass / 0 fail / 0 cancelled / 0 skipped
# duration_ms 117695.9152
# 10k rows: seed=494ms p95=48.5ms max=56.6ms hitTotal=200 total=1574ms
# 100k rows: seed=5277ms p95=73.3ms max=77.8ms hitTotal=200 total=6895ms
# 1000-file cold 246ms · warm 206ms · budget 2000ms
```

首行是汇总行，TAP 字面为 `# tests 589` 等分列行；`summaryLineNote` 已注明。`tapSha256` 记录这轮 TAP 的字节指纹。

## 7 未纳入

- 不改 4.6.21 的 tag 与 Release，不重签包。
- 不追溯补造 4.6.21 的 install 证据；缺就是缺，记在 BACKLOG。
- 4.7.0 积压不动：分页 keyset + 只读事务、turn 检索 0.318→0.40、门禁三处收拢、TAP→evidence 更强的密码学绑定（本轮只做字节指纹）。

## 8 发布链

按清单第 4 节顺序执行。原始回执在 `docs/evidence/4.6.22-release-api.txt`，安装证据在 `docs/evidence/4.6.22-install-release.txt`，云主机复跑在 `docs/evidence/4.6.22-vm.txt`。

- 内容提交 `8a381d9d` → 远端 `725e6f0633dd0dd363f1020f09f0ff12f8321d1b`；证据提交 `54ea88f2` → `942e74284faf9f0a6aa786c794cce860a1a49a00`；update-log `86082cb7` → `09fcd382149024535d6cd5cb6181290ec4c061a2`。SHA 变化来自推送通道改写，发行提交以远端为准。
- tag `v4.6.22` → tag object `d9e5e24d76d2f6d9b0cc52055fc3fc3df1a4560e`，指向 `09fcd382`；Release `461362004`（`https://github.com/wangzhen110/omni-memory/releases/tag/v4.6.22`）；资产 v2 `803560895`（632 B）、v1 `803560968`（485 B）。
- `npm run check` 在 `09fcd382` 上 exit 0（`update log covers 188 recorded commit hashes`）；`verify:release -- --tag v4.6.22` 输出 `OK: signature, package hash, and launcher hash are consistent`，`package.json` sha256 `a909c86b00df0ca4050c911d64b2f0b683ca18b298aff8ab7f52dfaa9ccfe6b9`，launcher `d7ba3e76…6dce4` 15360 B。
- 生产：`npm run setup` 通过（0 错误 0 警告），`/health` 返回 `{"ok":true,"version":"4.6.22","tools":30}`；安装时点数据库 43.0 MiB、schema 20、2154 notes / 36 facts。
- 云主机在 `09fcd382` 干净检出上复跑：589 tests / 586 pass / 3 skip，`# duration_ms 90212.755772`，TAP sha256 `338a35e65dd2e6567e4e8dfe40c1a42bfc6535249e6ba443de824e2d449ac201`（129,998 B）。三条 SKIP 与上一版同型（launcher Windows-only ×2、路径键 Windows/macOS ×1）。
- 干净包数（`git archive 09fcd382` 后 `npm pack --dry-run --json`）：251 files / 20,509,966 B / unpacked 44,242,166 B，原始 JSON 在 `docs/evidence/4.6.22-pack.json`。
- 证据回传：临时 deploy key `171386645` → 云主机推 `evidence/4.6.22` → 本机按 Contents API 取回并校验 TAP sha256 → 删分支 ref（204）、删 key（204）；云主机随后切回 main 并 `reset --hard origin/main`。

本报告不写「最终 HEAD」。按清单第 5 节正向要求补充时点事实：发行提交之后 main 只追加了 docs 提交——证据入库 `afef2ead`、update-log `a3683a2b`，以及本次文字修正；`git diff 09fcd382..a3683a2b -- lib/ test/ scripts/ package.json package-lock.json` 为空，`npm run check` 在 `a3683a2b` 上 exit 0（`update log covers 189 recorded commit hashes`）。若后续还有 docs 提交，按同一口径只写时点与 diff 为空，不再写「最终」。
