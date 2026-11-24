# 5 分钟上手

## 0. 你需要什么

- Node.js **22.13+**（`node --version`）
- Git
- Windows、macOS 或 Linux。Windows 的 `npm run setup` 会创建登录计划任务；其他系统用 `npm run serve` 前台运行。

不需要模型、API Key、云数据库。语义检索默认使用本地哈希向量，完全离线。

## 1. 先看它做什么（不安装）

```bash
git clone https://github.com/wangzhen110/omni-memory.git
cd omni-memory
npm ci
npm run demo
```

`demo` 在临时目录启动一个隔离数据库，写入一条经验 note 和一条 fact，再召回并打印结果。不会碰你的真实记忆，也不会启动服务。

## 2. 源码运行

```bash
npm run serve
```

打开：

- 总览：http://127.0.0.1:7788/hub
- 手机布局：http://127.0.0.1:7788/m
- 健康检查：http://127.0.0.1:7788/health

首次启动会自动建库，默认数据目录：

- Windows：`%USERPROFILE%\.dsh\memory\omni.db`
- macOS/Linux：`~/.dsh/memory/omni.db`

换目录：

```bash
OMNI_HOME=/path/to/omni-home npm run serve
```

Windows PowerShell：

```powershell
$env:OMNI_HOME = "D:\omni-home"; npm run serve
```

## 3. 官方安装（Windows，发布验签）

```bash
git checkout v4.0.1
npm ci
npm run setup
```

`setup` 会先验证 `v4.0.1` 的 Ed25519 发布清单，要求当前 HEAD 就是签名 commit、工作树没有未提交的跟踪文件，然后才安装启动器并创建计划任务。任何一步不符都会失败，不会覆盖正在运行的服务。

只想看计划、不落盘：

```bash
npm run setup:dry:release
```

本地开发检出（未发布或已改代码）只能用：

```bash
npm run setup:dev
```

`setup:dev` 只校验同提交的启动器 SHA-256，不验发布签名，不适合陌生用户。

详细信任边界见 [`docs/INSTALL-RELEASE.md`](docs/INSTALL-RELEASE.md)。

## 4. 验证发布物

```bash
npm run verify:release -- --tag v4.0.1
```

校验 Release 清单签名、tag/version/commit，以及签名 commit 上的 `package.json` 和启动器哈希。镜像下载的 exe 可以单独比对：

```bash
npm run verify:release -- --tag v4.0.1 --launcher ./omni-serve-7788.exe
```

## 5. 接入 AI 宿主

```bash
npm run mcp        # MCP stdio
npm run omni -- --help
```

MCP 客户端把 `command` 指向 `node`，参数指向本仓库的 `hosts/mcp/bin.mjs`。HTTP 与 OpenAPI 见 [`docs/REFERENCE.md`](docs/REFERENCE.md)。

## 6. 诊断与卸载

```bash
npm run doctor
```

卸载计划任务：

```bash
npm run uninstall:launcher
```

数据库不会自动删除。确认不需要后手动删 `omni.db` 及其 `-wal`/`-shm` 文件。

## 常见问题

**端口被占用**：`OMNI_HTTP_PORT=7799 npm run serve`。

**`npm run setup` 报 release not found**：你不在发布 tag 上，或该版本还没发布。用 `git checkout v4.0.1`；开发用 `npm run setup:dev`。

**Windows 计划任务查询失败**：安装器会区分“任务不存在”和“查询未知”。未知时拒绝改动，先修 `schtasks` 权限，或加 `--no-task` 只写配置。

**语义检索没效果**：先跑 `npm run demo`；真实库用 `npm run doctor` 看向量索引与队列状态。默认哈希向量不依赖任何模型。
