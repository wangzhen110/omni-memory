# 全息记忆 · 多宿主接入（MCP / HTTP / CLI）

让全息记忆跑在 DSH 之外：Claude Code、Cursor、Cline、Codex CLI、Zed 等任何支持 MCP 的客户端，共用同一个本地 SQLite 记忆库。

零依赖、纯 stdio、单文件入口。

---

## 它是什么，不是什么

`index.js` 里的记忆内核本身不认识宿主，只通过 `apply(ctx)` 用到 4 个必选宿主接口。`hosts/shared/headless.mjs` 把这几个接口实现成一个最小上下文，于是同一份内核不用改一行，就能以 MCP 服务的形式启动。

**能用的**
- 全部 28 个内核工具（23 个 `memory_*` + 5 个 `project_*`），参数与返回和 DSH 内完全一致（同一份定义，不是复制品）
- `memory_context`：一次调用返回用户设定 + 常驻画像 + 与本任务相关的记忆
- `memory_rules`：返回工作规则，给不读 resources 的客户端兜底（以上合计 30 个 MCP 工具）
- 项目代码索引：`project_sync` / `project_search` / `project_context` / `project_status` / `project_impact` 查询模块、符号、API 契约与反向影响面
- 项目分层：按 `OMNI_PROJECT_DIR`（默认进程工作目录）推导 `proj:<名>#<哈希>`，与 DSH 在同一目录下用的是同一层
- 数据共享：默认指向 `$DSH_HOME/memory/omni.db`，DSH 里存的东西，MCP 客户端直接能搜到；反过来也一样

**用不了的（老实说）**
- **没有自动注入**。MCP 服务没有权限写客户端的系统提示。替代方案是五条规则通道（见下）+ 让模型先调一次 `memory_context`。
- **没有自动转录**。DSH 靠 `session/event` 把原文落库；MCP 协议没有这个事件流，所以 MCP 侧只有显式 `memory_write` 的内容，原文检索（chunk）不会自动增长。
- **没有模型复核、没有 dream 定时校验**。需要 `llm` 与定时器，MCP 侧不提供。
- 星图在独立面板里（`omni serve`），不在 DSH 内嵌界面里。

---

## 怎么把规则真正送到模型

MCP 没有注入点，所以规则准备五条通道，全部指向同一份 `RULES_TEXT`，改一处即全改：

1. `initialize` 返回的 `instructions`：多数客户端会拼进上下文。
2. `prompts/list` → `prompts/get` `omni-bootstrap`：可以把当前任务一起带进去，返回「规则 + 任务」。
3. `resources/list` → `resources/read` `omni://rules`：模型可主动打开。
4. 工具 `memory_rules`：客户端既不显示 instructions 也不支持 resources 时的兜底。
5. `omni rules --write`：把托管区块写进项目自己的规则文件。

```powershell
node hosts/cli.mjs rules                    # 预览
node hosts/cli.mjs rules --write            # 写进已存在的 CLAUDE.md / AGENTS.md / .cursorrules
node hosts/cli.mjs rules --file CLAUDE.md --write --create   # 指定文件，不存在就建
```

托管区块长这样，幂等：重复执行不会产生 diff，因此可以安全地挂在钩子上：

```text
<!-- omni-memory:rules v1 start · 由全息记忆维护，区块内容会被覆盖，请勿手改 -->
# 全息记忆使用规则
...
<!-- omni-memory:rules v1 end -->
```

Claude Code 的 `SessionStart` 钩子示例（`.claude/settings.json`）：

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "node D:\\xiangmu\\全息记忆\\hosts\\cli.mjs rules --write" }]
    }]
  }
}
```

UserPromptSubmit 钩子想把「画像 + 相关记忆」直接拼进上下文，用这条：

```powershell
node hosts/cli.mjs context --query "用户的原始输入"
```

它输出纯文本，stdout 可以直接被钩子当作 additional context 使用。

---

## 启动

```powershell
node hosts/mcp/bin.mjs      # stdio MCP
node hosts/cli.mjs serve    # 面板 + REST + HTTP MCP
```

进 stdio 模式的进程**stdout 只有协议帧**，日志全部走 stderr。

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `OMNI_HOME` | 数据根目录，库在 `<OMNI_HOME>/memory/omni.db` | `$DSH_HOME`，再退回 `~/.dsh` |
| `OMNI_PROJECT_DIR` | 本项目层绑定的目录 | 进程当前工作目录 |
| `OMNI_SESSION_ID` | 作用域标识；同一 id 复用同一层 | `host-<工作目录哈希>` |
| `OMNI_HTTP_PORT` / `OMNI_HTTP_BIND` | 面板与 HTTP MCP 的监听 | `7788` / `127.0.0.1` |

`OMNI_PROJECT_DIR` 建议显式设成你真正在做事的那个项目目录，不要指望客户端启动时的工作目录正好是你想要的。

---

## 客户端接入（stdio）

### Claude Code

```powershell
claude mcp add omni-memory --env OMNI_PROJECT_DIR=D:\xiangmu\全息记忆 -- node D:\xiangmu\全息记忆\hosts\mcp\bin.mjs
```

或项目根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "omni-memory": {
      "command": "node",
      "args": ["D:\\xiangmu\\全息记忆\\hosts\\mcp\\bin.mjs"],
      "env": { "OMNI_PROJECT_DIR": "D:\\xiangmu\\全息记忆" }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`（全局）或项目内 `.cursor/mcp.json`，结构同上。

### Cline / Roo Code

MCP Servers 面板 Add Server：Command `node`，Args 填 `bin.mjs` 绝对路径。落盘位置：

```text
C:\Users\<你>\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json
```

### Codex CLI

`~/.codex/config.toml`：

```toml
[mcp_servers.omni-memory]
command = "node"
args = ["D:\\xiangmu\\全息记忆\\hosts\\mcp\\bin.mjs"]
env = { OMNI_PROJECT_DIR = "D:\\xiangmu\\全息记忆" }
```

### Zed

`settings.json`：

```json
{
  "context_servers": {
    "omni-memory": {
      "command": { "path": "node", "args": ["D:\\xiangmu\\全息记忆\\hosts\\mcp\\bin.mjs"], "env": { "OMNI_PROJECT_DIR": "D:\\xiangmu\\全息记忆" } }
    }
  }
}
```

---

## HTTP 方式

```powershell
node hosts/cli.mjs serve --port 7788
```

- `POST /mcp`：Streamable HTTP 的 JSON 响应模式，方法表与 stdio 完全相同
- `GET /`：记忆概览仪表盘；`/panel.html` 是记忆列表 / 搜索 / 星图 / 规则旧面板
- `GET /health`、`GET /rules`
- `/omni-memory/*`：插件原有的 26 条 REST 路由，原样挂载，没有第二套实现

客户端里填 MCP 地址 `http://127.0.0.1:7788/mcp` 即可。默认只监听回环地址。

---

## 自检

```powershell
node --test test/mcp.test.mjs test/http.test.mjs test/rules.test.mjs
```

- `mcp.test.mjs` 真拉进程走 stdio：握手、工具列表、写入、召回、错误路径、prompts、resources
- `http.test.mjs` 起真服务：26 条路由挂载、HTTP MCP、面板、REST 与 MCP 共库
- `rules.test.mjs` 钉住规则区块的幂等与替换

---

## 已知边界

- Node 版本：`node:sqlite` 在 Node 22 上是实验特性（会有一条 ExperimentalWarning，已被入口屏蔽）；`package.json` 声明 `>=22.13`，22.23 实测可跑。
- HTTP MCP 只有 JSON 响应模式，没有 SSE 流；没有鉴权，靠回环地址与 `mutationAllowed` 的同源校验挡浏览器 CSRF。
- 分包发布（内核包 / DSH 插件包 / MCP 包）还没做，目前是一个仓库三个入口。
