# 发版清单（人工两道，不靠记性）

这份清单只收“已经重复犯过三次以上”的坑。每条都要求原始输出，不接受“我记得做过”。

## 1 云主机落证：先跑，后写

发版收尾时，汇总里出现“云主机 reset 到某个 SHA”的句子之前，必须满足两件事：

1. 在 VM 实跑并把输出原样追加到 `docs/evidence/<版本>-vm.txt`：`git rev-parse HEAD`、`git log -1 --format='%H %s'`、`git status --porcelain`。
2. 汇总引用的 SHA 与上面 `HEAD=` 那一行逐字相同。

落证之后如果还要加 docs 提交，句子只写时点，不写“最终 HEAD”：

> VM 停在 `<有落证的 sha>`（跑测与 tag 都指向它）；此后只追加若干条 docs 提交，`git diff <有落证的 sha>..<当前 HEAD> -- lib/ test/ scripts/ package.json package-lock.json` 为空。

禁止把当前 HEAD 直接写成“已 reset 到”，也禁止写“最终 HEAD `<sha>`”——那行字在下一次 docs 提交后就会过期，这正是 4.6.19 与 4.6.20 两次被复核抓到的同一个错型。

历史教训：4.6.17 无 rev-parse → 4.6.18 补 `1808097` → 4.6.19 又冒出无落证的 `2617a5aa`。同一个坑连着三轮，就是流程问题，不是记性问题。

## 2 测试提交与最终 HEAD 分离时，先对齐再引用

- `.tap` 与 `docs/evidence/<版本>.json` 只对**跑测的那个提交**有效。evidence 里的 `commitSha` 由 `scripts/tap-evidence.mjs` 当场从 `git rev-parse HEAD` 写入，缺这个字段就不算落证。
- 发版后追加的 docs 提交不改代码树时，可以写“代码树与 `<跑测 sha>` 相同”，但不要说“在最终 HEAD 上测过”。
- 交付前跑一次 `git diff <跑测 sha>..<当前 HEAD> -- lib/ test/ scripts/ package.json package-lock.json`，输出必须为空；不为空就重测，不许拿旧 TAP 充数。

## 3 汇总里的每个数都要有仓库内的出处

按类型指定，不要笼统说“能查到”：

- **测试数、通过/失败/跳过、duration**：`docs/evidence/<版本>.json`。原始分列行以 `.test-results.tap` / `<版本>-vm.tap` 为准；`summaryLine` 是汇总行，不是 TAP 字面行。
- **包数与字节数**：归档 `npm pack --dry-run --json` 的原始输出为 `docs/evidence/<版本>-pack.json`，汇总引用其中 `entryCount` / `size`。
- **Release id、资产 id、tag object、commit SHA**：归档 GitHub API 与 `npm run verify:release` 的原始输出为 `docs/evidence/<版本>-release-api.txt`。
- **记忆条目**：写 `note#<id>` 并给出 `problem-key`。

归档一律“先写 `$env:TEMP` 再 copy”，JSON 无 BOM。

## 4 每次发版必跑（4 条 npm 命令 + 1 条前置脚本）

```
npm test                       # 全量；TAP 落到 .test-results.tap
node scripts/tap-evidence.mjs  # 前置脚本，写 docs/evidence/<版本>.json（含 commitSha）
npm run check                  # 必须在最终 HEAD exit 0
npm run verify:release -- --tag <版本>
npm run setup
```

`npm run check` 必须在**最终 HEAD**上 exit 0，而不是在某个中间提交上。实践教训（4.6.20）：push 会改写提交 SHA，若 `docs/UPDATES.md` 记的是本地 SHA，远端新克隆一跑就红。正确顺序是 push 之后 `git fetch && git reset --hard origin/main`，再 `npm run update-log` 并提交这一条，最后在最终 HEAD 复跑 `npm run check`。update-log 提交本身不进 `UPDATES.md`，所以不必无限重跑。

四条 npm 命令都过、且最终 HEAD 的 check exit 0，才允许写“已发布”。
