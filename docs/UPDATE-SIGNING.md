# 更新链签名

3.11.6 起，`scripts/daily-sync.mjs --apply` 不再直接合并 `origin/main`。它先从要升级到的 GitHub Release 下载 `omni-update-manifest.json`，用内置的 Ed25519 公钥验签，再校验包哈希和提交谱系，只快进到清单里签名的那个提交。

## 为什么要签名

只校验“远端版本更高 + 工作树干净”不够。攻击者只要能改写 `main`，就能让更新脚本拉取任意代码。签名把“谁有权发布”固定在本机已有的公钥上：仓库被改写、Release 资产被替换，验签都会失败。

公钥硬编码在 `lib/update-signature.mjs`，不从被更新的仓库读取。私钥只保存在发布机器上，不进入 checkout。

## 固定身份

- key id：`omni-ed25519-2026-01`
- 公钥指纹（SHA-256，SPKI DER）：
  `76:f3:5c:2d:c5:d6:f7:7e:a8:4d:9b:03:26:c0:7f:fc:d5:94:70:50:8c:bf:c4:41:75:a5:59:c1:67:a9:10:f1`
- 私钥默认路径：`~/.dsh/omni-update-signing-key.pem`
- 公钥文件：`~/.dsh/omni-update-signing-public.pem`
- Release 资产名：`omni-update-manifest.json`
- 清单 schema：`omni-update-manifest-v1`

私钥文件权限必须只允许当前用户读写。Windows 上用 ACL 限制；类 Unix 上用 `chmod 600`。私钥丢失后无法用旧版本内置的公钥签出新清单，只能手工分发新版本并更换公钥。

## 清单字段

清单是固定字段集合，任何未知字段都会被拒绝，避免未来新增字段改变旧签名的含义：

- `schema`：固定 `omni-update-manifest-v1`
- `keyId`：固定 `omni-ed25519-2026-01`
- `version` / `packageVersion`：两者必须相等
- `packageName`：固定 `@local/omni-memory`
- `commit`：40 位小写 Git SHA，必须等于要快进到的提交
- `packageJsonSha256`：该提交里 `package.json` 原始字节的 SHA-256
- `tag`：必须等于 `v<version>`
- `issuedAt`：ISO 时间
- `signature`：对上面字段规范化 JSON 的 Ed25519 签名（base64）

规范化 JSON 的字段顺序由 `canonicalUpdateManifest()` 固定，不依赖对象的插入顺序。

## 发布流程

1. 确认 `package.json` 版本、测试数、CHANGELOG 当前版本一致，`npm test` 与 `npm run check` 通过。
2. 提交并推送 `main`，记录最终提交 SHA。
3. 生成清单：

   ```bash
   node scripts/sign-release.mjs --version 3.11.6 --commit <sha> --tag v3.11.6
   ```

   默认读取 `~/.dsh/omni-update-signing-key.pem`，输出 `omni-update-manifest.json`。可用 `--key`、`--out`、`--issued-at` 覆盖，但发布流程不应把私钥路径写进仓库。
4. 创建 `v3.11.6` tag 和 GitHub Release，把 `omni-update-manifest.json` 作为 Release asset 上传。清单不放进 git 仓库：它包含 commit，如果又提交进仓库，会形成“清单包含 commit、commit 又包含清单”的循环哈希。
5. 在旧版本 checkout 上先跑 `node scripts/daily-sync.mjs --check`，确认返回 `signatureRequired: true`；再跑 `--apply` 验证真实更新。成功后才考虑 `--restart`。

## `--apply` 的拒绝条件

以下任一情况都不会移动 HEAD，不会重启服务：

- `unsigned-release`：Release 没有 `omni-update-manifest.json`
- `signature-invalid`：签名、key id、schema、字段格式任一不合法
- `package-hash-mismatch`：清单里的 `package.json` SHA-256 与提交里的不一致
- `signed-commit-missing` / `signed-commit-not-on-main`：签名提交不存在，或不在 `origin/main` 历史内
- `blocked-dirty`：tracked 文件有修改
- `blocked-diverged`：本地与远端分叉，无法 fast-forward
- `verification-failed`：快进后运行时 JS `node --check` 失败
- `tests-failed`：显式 `--run-tests` 时测试失败
- `signed-commit-mismatch`：快进后的 HEAD 不等于清单里的 commit

失败会 `git reset --hard` 回到更新前提交；`--restart` 只在更新成功后执行。

## 密钥轮换

当前实现只信任一个固定公钥，没有在线撤销列表。轮换步骤：

1. 生成新的 Ed25519 密钥对，更新 `UPDATE_PUBLIC_KEY_PEM`、`UPDATE_PUBLIC_KEY_SHA256`、`UPDATE_KEY_ID`。
2. 发布一个包含新公钥的新版本，并通过可信渠道（本机手工安装或已验证的旧版本）分发一次。
3. 之后所有 Release 用新私钥签名。

旧版本不会自动信任新密钥，这是固定公钥的固有代价；换来的是仓库被完全改写时也无法伪造更新。若私钥泄露，应立即停止发布，手工分发新版本并更换密钥，不能只靠删除 Release 补救。

## 已知边界

- 清单签的是 `package.json` 哈希、版本、提交和 tag，不是整棵 tree 的哈希。提交谱系校验保证快进到的是 `origin/main` 上的真实提交；如果要防“同一提交内文件被替换”，需要额外签 tree hash，当前未做。
- 3.11.5 及更早版本没有签名校验。升级到 3.11.6 的第一次仍需信任当时的发布渠道；从 3.11.6 起，后续 `--apply` 才强制验签。
