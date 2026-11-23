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
- 没有原生工具时，用现成 CLI：`node hosts\cli.mjs context --dir <项目> --query "<任务>"` 读取；写入用 `node hosts\cli.mjs write --dir <项目> --kind note ...`。CLI 会落到当前项目层，不需要 HTTP，也不需要修改豆包设置。若宿主报 `non_interactive_command_*.ps1` 找不到，等 2 秒重试一次；仍失败才走只读兜底，不要连续重试三次。
- CLI 也不可用时，才用 `GET http://127.0.0.1:7788/omni-memory/packet?cwd=<项目目录>&q=<任务>` 做只读兜底；必须带 `cwd`，否则默认 global，不能当项目层用。写入等 CLI 恢复。
- 连接器只是可选增强；用户不主动要求时，不要提“去插件页保存连接器”。
- Agent 不自动修改豆包设置、配置或注册表。

## 读取记忆时的版本提醒（优先于记笔记）

1. 每天第一次进入本项目，直接调用 `memory_context`（或 CLI `context`）。它会在返回文本顶部做一次带缓存的云端版本检查。
2. 如果顶部出现 `## 版本提醒（优先处理）`，说明云端版本更高：先在项目根目录执行 `node scripts/daily-sync.mjs`（`node` 不在 PATH 时用本机 Node 绝对路径），更新并确认 `service.healthy=true`，再重新读取记忆继续任务。
3. 没有版本提醒就直接继续，不要为了“确认版本”额外反复调用检查；`daily-sync` 自身按本地日期只执行一次。
4. `daily-sync` 返回 `updated` 但 `service.healthy=false` 或 `exists:false` 时，明确告诉用户“代码已更新，但 7788 服务未重启成功”，不要假装已生效。
5. 返回 `blocked-dirty`、`blocked-diverged`、`verification-failed`、`network-error` 时不要强拉，按返回的 `reason` 报告并继续用当前版本。

