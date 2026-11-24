# 发布验签安装（M2）

## 两条路径

| 路径 | 命令 | 校验什么 | 适合谁 |
|---|---|---|---|
| 发布验签安装 | `npm run setup` | Ed25519 Release 清单 + tag/version/commit + 签名 commit 上的启动器 SHA-256 + 干净工作树 | 陌生用户、生产机 |
| 本地开发安装 | `npm run setup:dev` | 同提交 `package.json` 的启动器 SHA-256 | 已可信的开发者 |

`npm run setup` 不再等价于“离线哈希安装”。它先走 `scripts/verify-release.mjs`，通过后才调用 `scripts/install-launcher.mjs`。

## `npm run setup` 的实际顺序

1. `runDoctor` 只读预检：仓库、数据目录、Node、SQLite、端口占用。
2. 读本地 `package.json` 版本，要求形如 `v4.1.1` 的官方 Release 存在。
3. 从 `api.github.com` 读取 Release 资产 `omni-update-manifest-v2.json`。
4. 用内置固定 Ed25519 公钥验签，要求 `tag`、`version`、`commit` 与本地一致。
5. 通过 GitHub Contents API 读取签名 commit 上的 `package.json` 与 `scripts/launchers/omni-serve-7788.exe`，比对清单中的 SHA-256。
6. 要求当前 `HEAD` 等于签名 commit。
7. 要求 `git status --porcelain --untracked-files=no` 为空。
8. 安装内容寻址启动器，写侧车配置，重启/创建计划任务。
9. 再跑一次 `doctor`，HTTP 健康检查失败则命令失败。

任何一步失败都在写文件之前退出；已有服务不被覆盖。

## 它防什么

- 下载到的 Release 清单被篡改。
- Release 资产被替换成另一个 commit 的构建。
- 本地检出不是签名 commit，或代码有未提交修改。
- 启动器与签名清单不一致。
- 误把开发分支当成官方发布安装。

## 它不防什么

- 攻击者已经控制你的 GitHub 账号、Release 或签名私钥。
- 用户从非官方渠道下载了被替换的整个仓库，并自己执行 `npm run setup:dev`。
- 操作系统已被入侵、`git` 或 `node` 被替换。
- 供应链之外的模型、代理、镜像站点。

这不是 Authenticode 签名的独立 exe 安装器，也不承诺“双击即装”。它是一个**可审计的发布验签安装路径**：用户能看见每一步校验，能自己重跑 `npm run verify:release`。要做代码签名证书级别的安装器，需要额外采购证书与维护签名流水线。

## 镜像与离线

- 镜像站应原样保留 Release 资产与 tag，不要重新打包启动器。
- 用户下载镜像后先跑：
  `npm run verify:release -- --tag v4.1.1 --launcher <下载的 exe>`
- 无法访问 `api.github.com` 时，安装会失败并给出网络错误；这是 fail-closed，不降级为哈希安装。

## 源码路径

不想安装计划任务时，直接：

```bash
npm ci
npm run serve
```

源码路径没有“官方构建”承诺；它运行的就是你检出的代码。发布验签只覆盖 Release 清单与启动器，不覆盖你本地修改过的源码。
