# 验证发布物

> 适用：任何人下载了全息记忆的 Release、启动器或源码归档，想确认它确实来自官方发布，而不是镜像、fork 或中间人替换的版本。

## 一条命令

```bash
# 验证当前 package.json 对应的 Release
npm run verify:release

# 验证指定 Release
npm run verify:release -- --tag v4.1.1

# 验证最新 Release
npm run verify:release -- --latest

# 验证你从任意渠道下载的启动器 exe
npm run verify:release -- --tag v4.1.1 --launcher ./omni-serve-7788.exe
```

成功时退出码为 `0`，输出签名 key、commit、`package.json` SHA-256、启动器 SHA-256；失败时退出码为 `1`，输出 JSON `{"ok":false,"error":"..."}`。加 `--json` 可获得机器可读结果。

## 它验证什么

1. 从官方 GitHub Release 下载 `omni-update-manifest-v2.json`（旧版本回退 v1）。
2. 用仓库内置的固定 Ed25519 公钥验签；清单字段被修改、未知字段、错误 keyId 都会拒绝。
3. 校验清单里的 `tag` / `version` / `commit` 与 Release 一致。
4. 通过 GitHub Contents API 读取签名 commit 上的 `package.json` 和启动器，分别比对清单里的 SHA-256。
5. 若传 `--launcher`，再把你本地的启动器字节与签名哈希比对。

历史 Release 不受 180 天更新时效限制；`daily-sync --apply` 仍执行完整的时效窗口检查。

## 它不验证什么

- **不验证运行中的服务**：只验证发布物，不读取 `omni.db`，不重启 7788。
- **不直接安装**：`verify:release` 是只读工具；`npm run setup` 才复用同一验证逻辑并安装，且额外要求 HEAD 等于签名 commit、工作树干净。
- **不验证构建环境**：签名证明“官方用私钥签了这个 commit 和这些哈希”，可复现构建证明“这个 commit 能重建出同样的启动器”；两者要一起看。
- **不绕过 GitHub 账号被攻破**：私钥离线保存时，攻击者即使改了 Release 资产也签不出新清单；但如果私钥也泄露，签名本身失效。

## 网络与限流

默认走 `api.github.com` 和 `github.com`，需要访问 GitHub。匿名 GitHub API 每小时 60 次；需要更高额度时设置 `GITHUB_TOKEN`（只读即可）：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
npm run verify:release -- --tag v4.1.1
```

不依赖 `raw.githubusercontent.com`，因为部分网络会重置该域名；文件内容通过 GitHub Contents API 获取。

## 给镜像/分发的建议

- 镜像站应原样转发 Release 的 `omni-update-manifest-v2.json`，不要自己重新签名。
- 第三方打包应保留原始 `tag` 与 `commit`，并在 README 说明修改内容；用户可用 `--tag` 验证上游 Release。
- 如果你分发启动器 exe，附上 `--launcher` 的验证命令和期望 SHA-256，而不是只说“官方版”。

## 相关文档

- [更新签名格式](UPDATE-SIGNING.md)
- [威胁模型](THREAT-MODEL.md)
- [完全开源发布计划](OPEN-SOURCE-LAUNCH-PLAN.md)
