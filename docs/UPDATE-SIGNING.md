# 更新链签名

3.11.6 起，`scripts/daily-sync.mjs --apply` 不再直接合并 `origin/main`。它先 `git fetch origin main` 取到签名提交对象，再下载目标 GitHub Release 的签名清单，用内置的 Ed25519 公钥验签，校验包哈希、启动器哈希和提交谱系，只快进到清单里签名的那个提交。

3.11.8 起清单分为两代：

- `omni-update-manifest-v2`：新客户端优先读取，除 `package.json` 外还固定 `launcherPath` / `launcherSha256`；
- `omni-update-manifest-v1`：旧客户端兼容路径，不含启动器字段。

## 为什么要签名

只校验“远端版本更高 + 工作树干净”不够。攻击者只要能改写 `main`，就能让更新脚本拉取任意代码。签名把“谁有权发布”固定在本机已有的公钥上：仓库被改写、Release 资产被替换，验签都会失败。

公钥硬编码在 `lib/update-signature.mjs`，不从被更新的仓库读取。私钥只保存在发布机器上，不进入 checkout。

## 固定身份

- key id：`omni-ed25519-2026-01`
- 公钥指纹（SHA-256，SPKI DER）：
  `76:f3:5c:2d:c5:d6:f7:7e:a8:4d:9b:03:26:c0:7f:fc:d5:94:70:50:8c:bf:c4:41:75:a5:59:c1:67:a9:10:f1`
- 私钥默认路径：`~/.dsh/omni-update-signing-key.pem`
- 公钥文件：`~/.dsh/omni-update-signing-public.pem`
- v2 Release 资产名：`omni-update-manifest-v2.json`
- v1 兼容资产名：`omni-update-manifest.json`
- v2 schema：`omni-update-manifest-v2`
- v1 schema：`omni-update-manifest-v1`

私钥文件权限必须只允许当前用户读写。Windows 上用 ACL 限制；类 Unix 上用 `chmod 600`。`scripts/sign-release.mjs` 在签名前强制检查：POSIX 模式不得有 group/other 位，Windows ACL 不允许 `Users`、`Everyone`、`Interactive` 等宽泛主体，否则拒绝签名。私钥丢失后无法用旧版本内置的公钥签出新清单，只能手工分发新版本并更换公钥。

## 清单字段

清单是固定字段集合，任何未知字段都会被拒绝，避免未来新增字段改变旧签名的含义。

v2：

- `schema`：固定 `omni-update-manifest-v2`
- `keyId`：固定 `omni-ed25519-2026-01`
- `version` / `packageVersion`：两者必须相等
- `packageName`：固定 `@local/omni-memory`
- `commit`：40 位小写 Git SHA，必须等于要快进到的提交
- `packageJsonSha256`：该提交里 `package.json` 原始字节的 SHA-256
- `launcherPath`：固定 `scripts/launchers/omni-serve-7788.exe`
- `launcherSha256`：该提交里启动器二进制原始字节的 SHA-256
- `tag`：必须等于 `v<version>`
- `issuedAt`：ISO 时间；验签时拒绝超过 180 天的旧清单和超过 24 小时的未来时间
- `signature`：对上面字段规范化 JSON 的 Ed25519 签名（base64）

v1 字段与 v2 相同，但没有 `launcherPath` / `launcherSha256`，`schema` 为 `omni-update-manifest-v1`。

规范化 JSON 的字段顺序由 `canonicalUpdateManifest()` 固定，不依赖对象的插入顺序；`schema` 本身也在签名体内。

## 发布流程

1. 确认 `package.json` 版本、`package.json.omni.launcher.sha256`、测试数、CHANGELOG 当前版本一致，`npm test` 与 `npm run check` 通过。
2. 提交并推送 `main`，记录最终提交 SHA。启动器二进制必须已在该提交里。
3. 生成 v2 清单：

   ```bash
   node scripts/sign-release.mjs --version 3.11.8 --commit <sha> --tag v3.11.8
   ```

   默认读取 `~/.dsh/omni-update-signing-key.pem`，输出 `omni-update-manifest-v2.json`。启动器哈希从 `<sha>:scripts/launchers/omni-serve-7788.exe` 读取，不信任工作树。
4. 可选生成 v1 兼容清单：

   ```bash
   node scripts/sign-release.mjs --version 3.11.8 --commit <sha> --tag v3.11.8 --schema v1 --out omni-update-manifest.json
   ```

5. 创建 `v3.11.8` tag 和 GitHub Release，把 v2 清单作为主资产上传；需要兼容旧客户端时同时上传 v1 清单。建议同时上传 `omni-serve-7788.exe` 资产，方便用户用 `--launcher` 本地比对。清单不放进 git 仓库：它包含 commit，如果又提交进仓库，会形成“清单包含 commit、commit 又包含清单”的循环哈希。
6. 发布后先跑 `npm run verify:release -- --tag v3.11.8`，确认清单签名、`package.json` 哈希与启动器哈希一致；再对下载的 exe 跑 `--launcher <path>`。它只读，不移动 HEAD、不安装、不重启。
7. 在旧版本 checkout 上先跑 `node scripts/daily-sync.mjs --check`，确认返回 `update-available`；再跑 `--apply` 验证真实更新。`--check` 只比较版本，不读取也不验证签名；签名校验只在 `--apply` 发生。成功后才考虑 `--restart`。

## `--apply` 的拒绝条件

以下任一情况都不会移动 HEAD，不会重启服务：

- `unsigned-release`：Release 没有 v2 或 v1 清单
- `signature-invalid`：签名、key id、schema、字段格式或 `issuedAt` 时间窗任一不合法
- `package-hash-mismatch`：清单里的 `package.json` SHA-256 与提交里的不一致
- `launcher-path-mismatch`：v2 清单的启动器路径不是固定路径
- `launcher-missing`：v2 清单的启动器在签名提交里不存在或为 0 字节
- `launcher-hash-mismatch`：启动器字节哈希与清单不一致
- `signed-commit-missing` / `signed-commit-not-on-main`：签名提交不存在，或不在 `origin/main` 历史内
- `blocked-dirty`：tracked 文件有修改
- `blocked-diverged`：本地与远端分叉，无法 fast-forward
- `verification-failed`：快进后运行时 JS `node --check` 失败
- `tests-failed`：显式 `--run-tests` 时测试失败
- `signed-commit-mismatch`：快进后的 HEAD 不等于清单里的 commit
- `launcher-install-failed`：安装/切换启动器失败

失败会 `git reset --hard` 回到更新前提交，但 `safeResetToBefore` 在 reset 前会再次检查 tracked 改动；发现验证过程改动了文件就拒绝覆盖。`--restart` 只在更新成功后执行。

## 启动器安装

v2 验签通过后，`daily-sync` 调用 `scripts/install-launcher.mjs`。**三个入口必须分清**：

- `npm run setup`：先由 `scripts/verify-release.mjs` 完成 Release 清单验签、tag/version/commit 绑定、干净工作树检查，再调用安装器；安装器返回 `launcherIntegrity: "release-manifest-v2"`、`releaseSignatureVerified: true`。
- `npm run setup:dev`：只校验“同提交 `package.json` 声明的 SHA-256”这一层内容自洽，**不验 Ed25519 发布签名**，返回 `launcherIntegrity: "sha256-in-commit"`、`releaseSignatureVerified: false`。只适合已可信的开发检出。
- `daily-sync --apply`：在调用安装器前完成 v2 验签，属于已可信安装上的更新路径。

安装器本身不读网络、不验签；它只负责按调用方给出的信任结论安装。发布签名校验由 `verify-release.mjs` 与 `daily-sync` 各自完成。


1. 从签名提交读取 `scripts/launchers/omni-serve-7788.exe` 字节；
2. 校验 `package.json.omni.launcher.sha256`；
3. 写入内容寻址副本 `~/.dsh/omni-serve-7788-<sha8>.exe` 和侧车配置 `~/.dsh/omni-serve-7788.json`；
4. 用 PowerShell `Set-ScheduledTask` 切换 `OmniMemory7788` 的 action；默认不停止运行中的进程。这里不用 `schtasks /Change /TR`，因为部分 Windows 构建会为 Interactive 任务弹出 run-as 密码提示，自动化更新无法应答。

旧副本不删除，回滚时可把任务 action 指回旧路径。完整配置与卸载见 [`SILENT-LAUNCHER.md`](SILENT-LAUNCHER.md)。

## 密钥轮换

当前实现只信任一个固定公钥，没有在线撤销列表。轮换步骤：

1. 生成新的 Ed25519 密钥对，更新 `UPDATE_PUBLIC_KEY_PEM`、`UPDATE_PUBLIC_KEY_SHA256`、`UPDATE_KEY_ID`。
2. 发布一个包含新公钥的新版本，并通过可信渠道（本机手工安装或已验证的旧版本）分发一次。
3. 之后所有 Release 用新私钥签名。

旧版本不会自动信任新密钥，这是固定公钥的固有代价；换来的是仓库被完全改写时也无法伪造更新。若私钥泄露，应立即停止发布，手工分发新版本并更换密钥，不能只靠删除 Release 补救。

## 已知边界

- 清单签的是 `package.json` 哈希、启动器哈希、版本、提交和 tag，不是整棵 tree 的哈希。提交谱系校验保证快进到的是 `origin/main` 上的真实提交；如果要防“同一提交内其他文件被替换”，需要额外签 tree hash，当前未做。
- 3.11.5 及更早版本没有签名校验。升级到 3.11.6 的第一次仍需信任当时的发布渠道；从 3.11.6 起，后续 `--apply` 才强制验签。
- v2 是 3.11.8 的主路径；旧客户端不认识 v2 时继续读 v1 资产。
