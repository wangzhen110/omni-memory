# 发版清单（人工两道，不靠记性）

这份清单只收“已经重复犯过三次以上”的坑。每条都要求原始输出，不接受“我记得做过”。

## 1 云主机落证：先跑，后写

发版收尾时，汇总里出现“云主机已 reset 到 `<sha>`”的句子之前，必须满足两件事：

1. 在 VM 实跑三行并把输出原样追加到 `docs/evidence/<版本>-vm.txt`：
   `git rev-parse HEAD`、`git log -1 --format='%H %s'`、`git status --porcelain`。
2. 汇总引用的 SHA 与上面 `HEAD=` 那一行逐字相同。

若之后还有 docs 提交，句子必须写成“VM 停 `<有落证的 sha>`；最终 HEAD `<新 sha>` 只多 `<N>` 条 docs 提交”，并在括号里点名是哪几条。禁止把最终 HEAD 直接写成“已 reset”。

历史教训：4.6.17 无 rev-parse → 4.6.18 补 `1808097` → 4.6.19 又冒出无落证的 `2617a5a`。同一个坑连着三轮，就是流程问题，不是记性问题。

## 2 测试提交与最终 HEAD 分离时，先对齐再引用

- `.tap`、`docs/evidence/<版本>.json` 只对**跑测的那个提交**有效。
- 发版后追加的 docs 提交不改代码树时，可以在汇总里注明“代码树与 `<跑测 sha>` 相同”，但不要说“在最终 HEAD 上测过”。
- 交付前跑一次 `git diff <跑测 sha>..<最终 HEAD> -- lib/ test/ scripts/ package.json package-lock.json`，输出必须为空；不为空就重测，不许拿旧 TAP 充数。

## 3 汇总与仓库文档同源

- 汇总里的每个数字（测试数、包数、字节数、Release id、资产 id、tag object）必须能在 `docs/evidence/` 或 `npm run check` 输出里找到出处。
- 改口径时，仓库文档与汇总同批改，不允许“仓库改了、汇总没改”或反过来。4.6.19 的“四类源 / 五处取数”就是这条的漏网。

## 4 每次发版必跑

```
npm test                # 全量，TAP 落到 .test-results.tap
node scripts/tap-evidence.mjs
npm run check           # exit 0
npm run verify:release -- --tag <版本>
npm run setup
```

四条都过才允许写“已发布”。
