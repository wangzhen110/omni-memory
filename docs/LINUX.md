# Linux 部署

## 前置

- Node.js >= 22.13（推荐 22.22 或 24）。
- glibc 环境；SQLite 由 Node 内置 `node:sqlite` 提供，不需要系统 `libsqlite3`。
- 数据目录必须可写；默认 `OMNI_HOME` 是用户目录下的 `.dsh/memory`，生产建议显式指定。

## 直接运行

```bash
git clone https://github.com/wangzhen110/omni-memory.git
cd omni-memory
npm ci --omit=dev
export OMNI_HOME=/var/lib/omni-memory
node hosts/cli.mjs doctor
node hosts/cli.mjs serve
```

`serve` 默认只绑定 `127.0.0.1:7788`。`/health`、`/metrics`、`/mcp` 和静态页都只接受回环连接；这是安全边界，不是可配置的“远程访问开关”。

## systemd（示例）

```ini
[Unit]
Description=Omni Memory
After=network.target

[Service]
Type=simple
User=omni
Environment=OMNI_HOME=/var/lib/omni-memory
Environment=OMNI_HTTP_PORT=7788
ExecStart=/usr/bin/node /opt/omni-memory/hosts/cli.mjs serve
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/omni-memory

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now omni-memory
curl --fail http://127.0.0.1:7788/health
curl --fail http://127.0.0.1:7788/metrics
```

## 远程访问

不要用 `--bind 0.0.0.0` 暴露端口。推荐 SSH 隧道：

```bash
ssh -L 7788:127.0.0.1:7788 user@server
```

然后在本地打开 `http://127.0.0.1:7788/hub`。

## CI 覆盖

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `windows-latest` 上跑 Node 22.13 / 24：`npm run check`、`npm test`、`npm run bench:golden`。Linux 真机结果以 GitHub Actions 日志为准；本机当前是 Windows，没有 WSL，不能替代 Linux 验收。
