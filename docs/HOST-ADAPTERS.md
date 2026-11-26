# 宿主适配层：MCP 之外的接入方式

MCP 定义的是“工具/资源/提示如何暴露”，不是“会话开始时自动注入记忆”。因此要把全息记忆接到不同 AI 工具，必须按宿主能力分层，而不是要求每个客户端都支持同一种注入方式。

## 四种宿主能力

- **A. DSH 原生插件**  
  有系统提示注入点，画像和自动召回直接进入每轮上下文，能力最完整。
- **B. 支持本地 MCP 的开发者工具**  
  例如 Claude Desktop / Claude Code、Cursor、Cline、Continue、Zed、Windsurf 等。工具能看见，但自动行为仍要靠项目规则、自定义指令或 SessionStart / UserPromptSubmit hook。
- **C. 支持 OpenAPI / function calling，但不认 MCP**  
  通过 `GET /omni-memory/openapi.json` 导入接口，用 `POST /omni-memory/tool` 调用受限工具面。
- **D. 只能聊天的闭源入口**  
  没有任意本地 MCP、没有工具调用、没有系统提示注入点。只能做预检索 sidecar：先取 `/packet`，再由用户、浏览器扩展或剪贴板工具把文本放到对话开头。MCP 服务端本身无法替这类宿主注入。

## 本项目提供的通道

### 1. MCP（A/B 类宿主）

```bash
node hosts/mcp/bin.mjs
```

支持 stdio 与 HTTP `POST /mcp`。stdio 与 HTTP 的 `initialize.instructions`、`omni-bootstrap` prompt、`memory_rules` 工具、`omni://rules` 资源**共享同一份 `RULES_TEXT`**，不再维护短摘要副本。

### 1.1 豆包工作（零配置 CLI 优先；连接器可选）

豆包工作客户端默认走项目自带的 CLI，不需要用户手动添加连接器：

```powershell
node hosts\cli.mjs context --dir <repo> --query "<任务>"
node hosts\cli.mjs write --dir <repo> --kind note --text "..."
```

`hosts/cli.mjs` 用与 MCP 相同的 `toolContext` 解析项目层，写入不会落到 global。项目内的 `AGENTS.md` 和用户 Skill `omni-memory` 都指向这条路径。

如果用户主动要求原生工具调用，再接官方「自定义连接器」（2026-11-21 实测支持 STDIO）：

```text
服务器名称：全息记忆
传输类型：STDIO
命令：<node.exe 绝对路径>
参数：<repo>\hosts\mcp\bin.mjs
环境变量：OMNI_HOME=<用户目录>\.dsh；OMNI_PROJECT_DIR=<repo>
```

实测：`initialize` 返回 `omni-memory 4.6.2`，`tools/list` 30 个工具。连接器只是可选增强，由豆包客户端管理；Agent 不应自动改豆包设置、配置或注册表。

#### 宿主瞬断（2026-11-21 实测）

- 症状：豆包客户端登录或重启后，PowerShell/CU 报 `non_interactive_command_*.ps1` 找不到；有时 `Test-Path` 能成功一次，下一条命令又失败。
- 根因：`agent_infra` 下的临时脚本目录被客户端清理，工具写入的脚本在执行前被删；不是 CLI、MCP 或参数错误。
- 处置：重启豆包客户端可恢复；CLI 首次失败等 2 秒重试一次，仍失败再走 `GET /omni-memory/packet?cwd=<项目>&q=<任务>` 只读兜底。不要连续重试三次，也不要改客户端配置/注册表绕过。
- 常态化：原生 MCP 连接器由客户端托管 Node 进程，不依赖 PowerShell 临时脚本；但它仍需用户在客户端保存一次，是可选增强。

### 1.2 DSH Desktop 的端口与验收（4.6.2）

DSH Desktop 的 `dsh-desktop-host` 启动 Web 应用时固定使用 `--host 127.0.0.1 --port 0`，因此 Web GUI / 插件路由端口由操作系统每次启动随机分配，重启后会变化。

- `http://127.0.0.1:9230/omni-memory/status` 返回 404 是正常的：`9230` 是 DSH 的 inspector ingest（`__DSH_INSPECTOR__`），不是插件路由。
- `59273` / `59325` 是历史进程的旧 GUI 端口，进程退出后不再监听；不要把它们写死为验收地址。
- 找当前端口：用 DSH 客户端侧栏打开「全息记忆」（内部相对请求，不依赖端口），或扫描 loopback 端口里 `/omni-memory/status` 返回 200 的那个；状态里的 `routes.status=registered`、`routes.count=26` 表示插件路由已挂载。
- 需要固定地址时用独立服务 `node hosts/cli.mjs serve --port 7788`，访问 `http://127.0.0.1:7788/`；它和 DSH 共用同一个 `omni.db`，但不依赖 DSH 的随机端口。
- 冷启动排查读 `%TEMP%\omni-route-debug.log`：出现 `not ready at apply; polling` 后应跟随 `inject fired` 或 `registered after Nms`；若 60 秒内都没有 `registered`，再看 `/status` 的 `routes.error`。

### 2. CLI context（hook / sidecar）

```bash
node hosts/cli.mjs context --query "当前任务"
node hosts/cli.mjs context --stdin        # Claude Code hook 等从 stdin 读 prompt
```

输出就是可直接拼接的画像 + 相关记忆文本。适合 SessionStart / UserPromptSubmit hook。

### 2.5 会话自动捕获（hook / 任意宿主）

无 MCP 注入点时，至少可以把对话沉淀下来；候选先 pending，不会污染正式记忆：

```bash
# 任意宿主：一轮对话
node hosts/cli.mjs ingest --role user --text "以后测试必须先跑 npm run check"

# Claude Code SessionStart / Stop hook：stdin 直接收 JSON
node hosts/cli.mjs ingest --stdin

# 审阅与接受
node hosts/cli.mjs candidates --scope proj:my-project
node hosts/cli.mjs candidate --id 12 --action accept
node hosts/cli.mjs candidate --id 13 --action reject --reason "临时信息"
```

对应的 loopback HTTP：`POST /omni-memory/ingest`、`GET /omni-memory/candidates`、`POST /omni-memory/candidate`。写操作要 `x-omni-csrf: 1`；`scope=all` 会被拒绝，避免把一轮私有对话写进全局层。

### 3. HTTP packet（无 MCP 宿主）

```bash
# JSON：包含 text、memories、字符数和截断标记
curl "http://127.0.0.1:7788/omni-memory/packet?q=部署端口"

# 纯文本：直接复制到对话开头
curl "http://127.0.0.1:7788/omni-memory/packet?q=部署端口&format=text"

# 按项目层取，避免跨项目串味；cwd 可从工作目录推导项目键
curl "http://127.0.0.1:7788/omni-memory/packet?cwd=D:\\xiangmu\\全息记忆&q=星图"

# 显式跨项目审计
curl "http://127.0.0.1:7788/omni-memory/packet?scope=all&q=星图"
```

`budget` 默认 1800 字符，范围 400..4000；`limit` 默认 5，最大 10。只读，不需要 CSRF 头，但仍只接受本机回环请求。

### 4. OpenAPI / tool bridge（C 类宿主）

```bash
curl http://127.0.0.1:7788/omni-memory/openapi.json
```

OpenAPI 导出 15 条 path（含 packet、search、list、node、status、tool、ingest、candidates、candidate、consolidate 与 5 条 project/*）。工具桥只暴露核心读写工具：`memory_write`、`memory_search`、`memory_solution_report`、`memory_feedback`、`memory_get`、`memory_amend`、`memory_profile`、`memory_timeline`；省略 `arguments.scope` 时继承服务启动的项目层，显式 `scope` 优先。导出、导入、compact、reindex、dream、persona 等维护面仍留在 MCP/CLI；`consolidate` 走独立 POST 路由，不放进 `/tool`。

```bash
curl -X POST http://127.0.0.1:7788/omni-memory/tool \
  -H "content-type: application/json" \
  -H "x-omni-csrf: 1" \
  -d '{"name":"memory_search","arguments":{"query":"部署端口","scope":"all"}}'
```

## 安全边界

- 所有 HTTP 路由只监听 loopback；非本机请求返回 403。所有路由（含只读 `/omni-memory/*`）都校验 Host，伪造 Host 返回带 `error` 的 403；`/export` 只接受 GET。
- `/tool` 是写操作，必须带 `x-omni-csrf: 1`，并校验 Origin；跨站表单无法伪造该头。省略 `arguments.scope` 时按服务启动的项目层执行，不会默认落 global。
- 跨项目读取/改写需要显式 `scope=all`；默认只走当前项目 + global。
- 不要把 `--bind 0.0.0.0` 暴露到公网；如果必须远程，前面加 TLS、认证和网络 ACL，且不要把未鉴权的 `/mcp` 或 `/tool` 直接开放。
- 不建议用桌面 UI 自动化硬注入豆包等闭源聊天端；豆包工作优先用零配置 CLI（`hosts/cli.mjs`），原生自定义连接器只作可选增强。其他没有 MCP 的闭源聊天端才用 `/packet` + 人工/扩展粘贴。

## 一句话选择

有 DSH：用原生插件。  
有 MCP：接 stdio/HTTP MCP，再补规则或 hook。  
豆包工作：零配置 CLI 优先，原生连接器可选。  
只有 OpenAPI：用 `openapi.json` + `/tool`。  
只能聊天：用 `/packet` / `omni context` 做预检索 sidecar。  
