# Docker / 容器化

全息记忆的 HTTP 适配层是 **loopback-only** 设计：`/mcp`、`/omni-memory/*`、`/health`、`/metrics` 和静态页都会拒绝非回环来源。直接 `docker run -p 7788:7788` 不会让局域网客户端通过鉴权，因此本仓库的容器入口只提供 **stdio MCP**，不伪装成远程 HTTP 服务。

## 构建

```bash
docker build -t omni-memory:local .
```

## 作为 MCP stdio 服务运行

```bash
docker run --rm -i \
  -v omni-memory-data:/data \
  -e OMNI_HOME=/data \
  omni-memory:local
```

把上面这条命令配置为 MCP 客户端里的 `command`/`args`，stdin/stdout 就是 MCP 通道。

## 数据与权限

- 数据卷挂载到 `/data`，容器内以 `node` 用户运行。
- 语义模型随镜像打包；首次打开旧库时会后台回填，属于预期行为。
- 不要把 `OMNI_HTTP_BIND` 设成 `0.0.0.0` 当作远程访问方案；需要远程使用时，在宿主机用 SSH 隧道访问回环端口，或自行增加带鉴权的反向代理（当前仓库不提供）。

## 当前边界

- 已在 CI 中构建镜像并验证 MCP `initialize` 能返回 `omni-memory`。
- 未在本机验证 Docker：当前 Windows 环境没有 Docker/WSL；镜像构建由 `.github/workflows/ci.yml` 的 `container` job 负责。
