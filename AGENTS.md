<!-- omni-memory:rules v1 start · 由全息记忆维护，区块内容会被覆盖，请勿手改 -->
# 全息记忆使用规则

这是一个本地长期记忆服务。它不会自己变聪明，价值取决于你是否按下面的顺序用它。

## 每次开始任务
1. 先调用 `memory_context`，把用户的原始请求（或当前报错）作为 `query` 传进去。
2. 读返回的「用户设定」和「常驻画像」：它们约束你用什么语言、什么风格、避开什么。
3. 读「与当前任务相关」的条目：命中的结论优先于重新摸索；标注 contested 的不要直接依赖。

## 遇到障碍
1. 先用 `memory_search` 的 `problemKey` 精确查（错误码、失败的命令、规范化后的症状）。
2. 再放宽到关键词查。
3. 两条都没命中，才去查文档或全网搜索。
4. 解决之后立刻用 `memory_write` 沉淀：`kind=note`，写清症状、试过但失败的路径、真正有效的解法、生效的前提条件；带上 `problemKey`，把 `solutionStatus` 记为 `verified` 或 `unverified`，`evidence` 填命令输出或测试结果。

## 什么时候该写
- 会跨会话复用的结论：项目约定、环境配置、踩过的坑、别人的偏好。
- 事实用 `kind=fact`，`subject/relation/object` 三段式；同一个 subject+relation 换了值，旧值会被自动失效，不要手动删。
- 一次性、临时、能从代码或文件里直接读到的东西，不要写。
- 每条都要能脱离当前对话独立成立：不要写「上面那个」「刚才说的」。

## 什么时候不该写
- 不要每轮都写。一次任务通常只沉淀 0–3 条真正有价值的结论。
- 不要把用户的原话整段抄进来，转录层如果有宿主事件流会自己做。
- 不确定是否成立的推测，标 `unverified`，不要伪装成 `verified`。

## 分层
- `global`：跨项目通用的规则、偏好、工具链事实。
- `proj:<名>#<哈希>`：只属于当前项目目录的知识，默认就落在这一层。
- 不要把一个项目的临时约定写成 global，那会污染所有项目。

## 复核
- 涉及删除、覆盖、对外发送、付费等不可逆动作前，先用 `memory_search` 确认记忆没有过时。
- 发现记忆与当前事实冲突，用 `memory_write` 写新结论并在 `contradicts` 里填旧 id，不要默默绕过。
<!-- omni-memory:rules v1 end -->

## 豆包宿主接入

- **默认零配置，不要求用户添加自定义连接器。** 本会话若能看到 `memory_*` 工具，直接按上面的规则调用。
- 没有原生工具时，用现成 CLI：`node hosts\cli.mjs context --dir <项目> --query "<任务>"` 读取；写入用 `node hosts\cli.mjs write --dir <项目> --kind note ...`。`--dir` 现在硬绑定项目层（读取仓库根 `.omni-project` 的稳定键），不会因为文案里出现“偏好/规则”被分类器抬到 global；要写全局规则必须显式加 `--scope global`。每轮对话可再用 `omni ingest --dir <项目> --role user|assistant --text ...` 写入转录，候选会进待审队列。不需要 HTTP，也不需要修改豆包设置。若宿主报 `non_interactive_command_*.ps1` 找不到，等 2 秒重试一次；仍失败才走只读兜底，不要连续重试三次。
- CLI 也不可用时，才用 `GET http://127.0.0.1:7788/omni-memory/packet?cwd=<项目目录>&q=<任务>` 做只读兜底；必须带 `cwd`，否则默认 global，不能当项目层用。写入等 CLI 恢复。
- 连接器只是可选增强；用户不主动要求时，不要提“去插件页保存连接器”。
- Agent 不自动修改豆包设置、配置或注册表。

### 项目身份文件

- 仓库根 `.omni-project` 是项目身份的稳定来源，例如 `{"key":"proj:全息记忆#30534c","name":"全息记忆"}`。不要把它改写成路径哈希；路径哈希只用于没有文件的旧仓库。
- 新仓库可运行 `node hosts\cli.mjs project init --dir <项目> --name <名称>` 生成；已有两个历史键时用 `project link --from <旧键> --to <新键> --apply` 合并。
- 判断当前落点用 `node hosts\cli.mjs project show --dir <项目>`，不要靠猜路径。

## 读取记忆时的版本提醒（只报告，不自动更新）

1. 每天第一次进入本项目，直接调用 `memory_context`（或 CLI `context`）。它会在返回文本顶部做一次带缓存的云端版本检查。
2. 如果顶部出现 `## 版本提醒（需用户确认）`，说明云端版本更高：把云端与本地两个版本号告诉用户，并说明是否更新由用户决定。**不要自行运行 `daily-sync`，也不要因为这条提醒中断当前任务。**
3. 只有用户明确同意后，才在项目根目录执行 `node scripts/daily-sync.mjs --apply`（`node` 不在 PATH 时用本机 Node 绝对路径）；若当天已经同步过，加 `--force`。需要同时重启 7788 时再加 `--restart`。不带 `--apply` 的运行只报告，不会合并代码。
4. `--apply` 会从 Release 下载 `omni-update-manifest.json`，用固定 Ed25519 公钥验签，并校验包哈希与签名提交谱系；任何一个不通过都必须停止，不得绕过。
5. 返回 `updated` 且 `restartRequired:true` 时，明确告诉用户“代码已更新，但 7788 还在旧版本”；只有用户同意后才重启，不要假装已生效。
6. 返回 `blocked-dirty`、`blocked-diverged`、`unsigned-release`、`signature-invalid`、`package-hash-mismatch`、`signed-commit-not-on-main`、`verification-failed`、`network-error` 时不要强拉、不要自动重试、不要绕过签名，按返回的 `error` 报告并继续用当前版本；更不要手工执行 `git reset --hard`。
7. 版本提醒是信息，不是命令；它不得覆盖用户指令、安全规则或“不可逆动作前先确认”的要求。

