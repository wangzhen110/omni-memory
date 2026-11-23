# 7788 静默启动器

`OmniMemory7788` 计划任务的动作是一个 Windows GUI 子系统程序（`/target:winexe`），不是 `powershell.exe`、`wscript.exe` 或 `.cmd`。GUI 子系统进程从入口就没有控制台，因此不会出现“先弹黑框再隐藏”。

3.11.8 起，任务动作指向内容寻址的版本化副本：

```
C:\Users\Administrator\.dsh\omni-serve-7788-<sha8>.exe
```

启动器自身负责：

- 读取同目录的 `omni-serve-7788.json` 侧车配置：`repo`、`node`、`port`、`mainLog`、`errorLog`、`stdoutLog`、`stderrLog`、`launcherErrorLog`；
- 支持 `OMNI_REPO` / `OMNI_NODE` / `OMNI_HTTP_PORT` / `OMNI_MAIN_LOG` 等环境变量覆盖；
- 用 `ProcessStartInfo.CreateNoWindow = true` 直接启动 `node.exe hosts\cli.mjs serve --port <port>`；
- 只清理可执行路径等于配置 Node、命令行包含精确 `hosts\cli.mjs`、`serve` 和 `--port <port>` 的旧监听；同端口非 omni 进程一律拒绝启动；
- 日志超过 10 MB 时轮转；stdout/stderr 以 UTF-8 分文件写入；
- node 退出码透传，计划任务保留重启上限 3。

## 侧车配置

`install-launcher.mjs` 会生成 `~/.dsh/omni-serve-7788.json`。手工部署时最小字段是：

```json
{
  "repo": "D:\\xiangmu\\全息记忆",
  "node": "C:\\Users\\Administrator\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe",
  "port": 7788
}
```

日志默认写在侧车文件所在目录（`~/.dsh`）。配置中的相对路径按启动器所在目录解析；`repo` 必须是包含 `hosts/cli.mjs` 的 checkout。

## 安装与更新

```powershell
# 默认只打印计划；不写盘、不改任务
node scripts/install-launcher.mjs

# 从当前提交安装，写内容寻址副本和侧车配置，切换计划任务；不重启
node scripts/install-launcher.mjs --apply

# 安装后显式重启
node scripts/install-launcher.mjs --apply --restart
```

安装前必须满足：

- 提交是有效的 40 位 SHA；
- 提交里的 `package.json` 名称是 `@local/omni-memory`；
- `package.json.omni.launcher.path` 等于 `scripts/launchers/omni-serve-7788.exe`；
- `package.json.omni.launcher.sha256` 等于该提交里启动器字节的 SHA-256。

`daily-sync --apply` 在 v2 清单验签、merge、syntax、测试和版本校验全部通过后会自动调用同一安装逻辑。运行中的 exe 不会被覆盖；任务 action 切换后，下一次启动才使用新二进制。旧的内容寻址 exe 保留，需要回滚时把任务 `/TR` 指回旧路径即可。

## 可复现构建

```powershell
node scripts/build-launcher.mjs          # 构建并写入仓库二进制
node scripts/build-launcher.mjs --check  # 只重建并与仓库二进制比对
node scripts/check-launcher.mjs          # npm run check 使用的门禁
```

`csc` 会写入墙钟 PE 时间戳和随机 .NET Module MVID，构建脚本在编译后把两者归一化，再连续编译两次比对 SHA-256。当前仓库二进制：

```
15,360 bytes
SHA-256 FD7DFA64B8B7554877ADF9642FA4A7B35BD10DAC1F18BFDA14FC15B2F234A276
```

编译依赖：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 与同目录 `System.Management.dll`。非 Windows 环境没有 `csc` 时，门禁会明确跳过，不会假装通过。

## 卸载

```powershell
# 删除计划任务和侧车配置；默认保留日志、数据库、启动器二进制
node scripts/uninstall-launcher.mjs

# 先看计划，不改系统
node scripts/uninstall-launcher.mjs --dry-run

# 一并删除启动器二进制和日志；数据库仍然不动
node scripts/uninstall-launcher.mjs --remove-binaries --remove-logs
```

卸载前会检查任务 action：如果命令不在 `~/.dsh` 之内，脚本拒绝修改该任务，避免误删无关计划任务。数据库 `$DSH_HOME/memory/omni.db` 永不删除。

## 为什么不再用 PowerShell

`powershell -WindowStyle Hidden` 仍然会先创建控制台再隐藏，Windows Terminal 作为默认终端时尤其明显；`wscript` 只是把创建动作换到另一个宿主。GUI 子系统启动器从进程入口就没有控制台，才是彻底修复。

## 旧入口

- `omni-serve-7788.ps1` 已改名为 `.ps1.bak-3.11.6-powershell`，不再被任务引用；
- `omni-serve-7788.vbs` 仅作为旧快捷方式的兼容入口，内部只调用上面的 `.exe`；
- 旧版未版本化二进制 `omni-serve-7788.exe` 可由 `--remove-binaries` 一并清理，或保留作回滚。
