# 7788 静默启动器

`OmniMemory7788` 计划任务不再通过 `powershell.exe`、`wscript.exe` 或 PowerShell 脚本启动服务。任务动作直接是：

```
C:\Users\Administrator\.dsh\omni-serve-7788.exe
```

这个可执行文件是 Windows GUI 子系统程序（`/target:winexe`），自身不创建控制台；它用 `ProcessStartInfo.CreateNoWindow = true` 直接启动 `node.exe hosts\cli.mjs serve --port 7788`，并负责：

- 只清理命令行匹配 `cli.mjs.*serve.*7788` 的旧监听；
- 端口被非 omni 进程占用时拒绝启动，不杀未知进程；
- 日志超过 10 MB 时轮转；
- stdout/stderr 以 UTF-8 写入，stdout 和 stderr 分离；
- node 退出码透传，计划任务保留重启上限 3。

## 源码

源码已纳入仓库：`scripts/launchers/omni-serve-7788-launcher.cs`。它和部署的二进制内容对应；源码中的路径是本机默认值，换机器时需要改常量后重新编译。

## 构建

```powershell
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /codepage:65001 `
  /r:'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Management.dll' `
  /out:'C:\Users\Administrator\.dsh\omni-serve-7788.exe' `
  'D:\xiangmu\全息记忆\scripts\launchers\omni-serve-7788-launcher.cs'
```

部署二进制 SHA-256：

```
07E0816D8B49C77761C7AC4B58312F2A374F7CBEDD22A960FD8569511A43EBA3
```

## 为什么不再用 PowerShell

`powershell -WindowStyle Hidden` 仍然会先创建控制台再隐藏，Windows Terminal 作为默认终端时尤其明显；`wscript` 只是把创建动作换到另一个宿主。GUI 子系统启动器从进程入口就没有控制台，才是彻底修复。

## 旧入口

- `omni-serve-7788.ps1` 已改名为 `.ps1.bak-3.11.6-powershell`，不再被任务引用；
- `omni-serve-7788.vbs` 仅作为旧快捷方式的兼容入口，内部只调用上面的 `.exe`。
