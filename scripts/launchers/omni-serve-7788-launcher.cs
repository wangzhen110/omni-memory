// Omni Memory 7788 silent launcher.
// Compiled as a Windows GUI subsystem executable (/target:winexe). It starts
// node.exe directly with CreateNoWindow=true. There is no PowerShell/wscript
// layer and therefore no console window to create, hide or flash.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class OmniServeLauncher
{
    private static string Repo;
    private static string Node;
    private static string MainLog;
    private static string ErrorLog;
    private static string StdoutLog;
    private static string StderrLog;
    private static string LauncherErrorLog;
    private static int Port;
    private static string ConfigPath;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly object LogLock = new object();

    static int Main()
    {
        try
        {
            LoadConfig();
            Rotate(MainLog);
            Rotate(ErrorLog);
            Rotate(StdoutLog);
            Rotate(StderrLog);
            Rotate(LauncherErrorLog);

            if (!File.Exists(Node))
            {
                Log("node not found: " + Node);
                return 1;
            }
            if (!Directory.Exists(Repo))
            {
                Log("repo not found: " + Repo);
                return 1;
            }

            CleanStaleListener();
            if (HasListener())
            {
                Log("port " + Port + " is still held by a non-omni process; refusing to start");
                return 1;
            }

            return RunNode();
        }
        catch (Exception error)
        {
            Log(error.ToString());
            return 1;
        }
    }

    static int RunNode()
    {
        var info = new ProcessStartInfo
        {
            FileName = Node,
            Arguments = "hosts\\cli.mjs serve --port " + Port,
            WorkingDirectory = Repo,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8,
            StandardErrorEncoding = Utf8,
        };

        using (var child = new Process())
        {
            child.StartInfo = info;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Append(StdoutLog, e.Data + "\r\n");
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) Append(StderrLog, e.Data + "\r\n");
            };

            if (!child.Start())
            {
                Log("Process.Start returned false");
                return 1;
            }
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            Log("started node pid " + child.Id + "; waiting for exit");
            child.WaitForExit();
            Thread.Sleep(100);
            Log("node exited with code " + child.ExitCode);
            return child.ExitCode;
        }
    }

    static void CleanStaleListener()
    {
        var pids = ListenerPids();
        if (pids.Count == 0) return;

        var blocked = false;
        foreach (var pid in pids)
        {
            var commandLine = CommandLineOf(pid);
            if (IsOmniNode(pid, commandLine))
            {
                Log("stopping stale listener pid " + pid);
                try
                {
                    using (var stale = Process.GetProcessById(pid))
                    {
                        stale.Kill();
                    }
                }
                catch (Exception error)
                {
                    Log("Stop-Process equivalent failed for pid " + pid + ": " + error.Message);
                }

                if (!WaitForPortFree(10000))
                {
                    Log("listener " + pid + " survived Kill; forcing process tree");
                    RunTaskkill(pid);
                    WaitForPortFree(2000);
                }
            }
            else
            {
                blocked = true;
                Log("port " + Port + " held by pid " + pid + " (" + (commandLine ?? "no command line") + ")");
            }
        }

        if (blocked)
        {
            Log("port " + Port + " is held by a non-omni process; refusing to start");
            Environment.Exit(1);
        }
    }

    static List<int> ListenerPids()
    {
        var result = new List<int>();
        try
        {
            foreach (var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (endpoint.Port != Port) continue;
                try
                {
                    var pid = ListenerPidFor(endpoint.Address.ToString(), endpoint.Port);
                    if (pid > 0 && !result.Contains(pid)) result.Add(pid);
                }
                catch
                {
                    // Fall through: a missing owner still leaves the port occupied,
                    // and the caller's HasListener() check will refuse to start.
                }
            }
        }
        catch (Exception error)
        {
            Log("listener enumeration failed: " + error.Message);
        }
        return result;
    }

    static int ListenerPidFor(string address, int port)
    {
        // netstat is the reliable owner lookup on Windows for both IPv4 and IPv6.
        var output = RunCapture(@"C:\Windows\System32\netstat.exe", "-ano -p TCP");
        if (String.IsNullOrEmpty(output)) return 0;
        foreach (var rawLine in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase)) continue;
            var parts = Regex.Split(line, @"\s+");
            if (parts.Length < 5) continue;
            var local = parts[1];
            var state = parts[3];
            if (!String.Equals(state, "LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
            var colon = local.LastIndexOf(':');
            if (colon < 0) continue;
            int localPort;
            if (!Int32.TryParse(local.Substring(colon + 1), out localPort) || localPort != port) continue;
            var owner = parts[4];
            int pid;
            if (Int32.TryParse(owner, out pid)) return pid;
        }
        return 0;
    }

    static string CommandLineOf(int pid)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT CommandLine, ExecutablePath FROM Win32_Process WHERE ProcessId = " + pid))
            using (var rows = searcher.Get())
            {
                foreach (ManagementObject row in rows)
                {
                    var value = row["CommandLine"];
                    if (value != null) return value.ToString();
                }
            }
        }
        catch (Exception error)
        {
            Log("command line lookup failed for pid " + pid + ": " + error.Message);
        }
        return null;
    }

    static string ExecutablePathOf(int pid)
    {
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ExecutablePath FROM Win32_Process WHERE ProcessId = " + pid))
            using (var rows = searcher.Get())
            {
                foreach (ManagementObject row in rows)
                {
                    var value = row["ExecutablePath"];
                    if (value != null) return value.ToString();
                }
            }
        }
        catch (Exception error)
        {
            Log("executable path lookup failed for pid " + pid + ": " + error.Message);
        }
        return null;
    }

    static bool IsOmniNode(int pid, string commandLine)
    {
        if (String.IsNullOrEmpty(commandLine)) return false;
        var executable = ExecutablePathOf(pid);
        if (String.IsNullOrEmpty(executable)) return false;
        // Node upgrades change the absolute path while an older listener may
        // still be serving the port. Recognize any node executable as long as
        // the entrypoint and port match exactly; refusing to stop the old
        // listener leaves setup unable to switch to the new sidecar config.
        var executableName = Path.GetFileName(executable);
        var isNode = String.Equals(executableName, "node.exe", StringComparison.OrdinalIgnoreCase)
            || String.Equals(executableName, "node", StringComparison.OrdinalIgnoreCase);
        if (!isNode)
        {
            try
            {
                if (!String.Equals(Path.GetFullPath(executable), Path.GetFullPath(Node), StringComparison.OrdinalIgnoreCase)) return false;
            }
            catch
            {
                return false;
            }
        }
        // Require the exact repo entrypoint and exact port flag. A broad
        // "cli.mjs.*serve.*7788" regex can kill an unrelated Node listener.
        var entry = Regex.Match(commandLine, @"(?:^|\s)""?([^""\s]+[\\/])?hosts[\\/]cli\.mjs(""|\s|$)", RegexOptions.IgnoreCase);
        if (!entry.Success) return false;
        var serve = Regex.IsMatch(commandLine, @"\s+serve(\s|$)", RegexOptions.IgnoreCase);
        if (!serve) return false;
        var port = Regex.Match(commandLine, @"\s--port\s+" + Port + @"(\s|$)", RegexOptions.IgnoreCase);
        return port.Success;
    }

    static bool HasListener()
    {
        try
        {
            foreach (var endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (endpoint.Port == Port) return true;
            }
        }
        catch (Exception error)
        {
            Log("port check failed: " + error.Message);
            return true;
        }
        return false;
    }

    static bool WaitForPortFree(int milliseconds)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            if (!HasListener()) return true;
            Thread.Sleep(250);
        }
        return !HasListener();
    }

    static void RunTaskkill(int pid)
    {
        try
        {
            var info = new ProcessStartInfo
            {
                FileName = @"C:\Windows\System32\taskkill.exe",
                Arguments = "/F /T /PID " + pid,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (var taskkill = Process.Start(info))
            {
                if (taskkill != null) taskkill.WaitForExit(5000);
            }
        }
        catch (Exception error)
        {
            Log("taskkill failed for pid " + pid + ": " + error.Message);
        }
    }

    static string RunCapture(string fileName, string arguments)
    {
        try
        {
            var info = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.ASCII,
            };
            using (var process = Process.Start(info))
            {
                if (process == null) return null;
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(5000);
                return output;
            }
        }
        catch (Exception error)
        {
            Log("command failed: " + fileName + " " + error.Message);
            return null;
        }
    }

    static void Rotate(string path)
    {
        try
        {
            if (!File.Exists(path)) return;
            if (new FileInfo(path).Length < 10 * 1024 * 1024) return;
            for (var index = 3; index >= 1; index--)
            {
                var older = path + "." + index;
                var newer = path + "." + (index + 1);
                if (!File.Exists(older)) continue;
                if (File.Exists(newer)) File.Delete(newer);
                File.Move(older, newer);
            }
            var first = path + ".1";
            if (File.Exists(first)) File.Delete(first);
            File.Move(path, first);
        }
        catch
        {
            // Rotation must never prevent the service from starting.
        }
    }

    static void LoadConfig()
    {
        var baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        ConfigPath = Path.Combine(baseDir, "omni-serve-7788.json");
        var json = File.Exists(ConfigPath) ? File.ReadAllText(ConfigPath, Utf8) : String.Empty;

        Repo = ResolvePath(Env("OMNI_REPO", JsonValue(json, "repo")), Environment.CurrentDirectory);
        Node = ResolvePath(Env("OMNI_NODE", JsonValue(json, "node")), Path.Combine(baseDir, "node.exe"));
        MainLog = ResolvePath(Env("OMNI_MAIN_LOG", JsonValue(json, "mainLog")), Path.Combine(baseDir, "omni-serve-7788.log"));
        ErrorLog = ResolvePath(Env("OMNI_ERROR_LOG", JsonValue(json, "errorLog")), Path.Combine(baseDir, "omni-serve-7788.err.log"));
        StdoutLog = ResolvePath(Env("OMNI_STDOUT_LOG", JsonValue(json, "stdoutLog")), Path.Combine(baseDir, "omni-serve-7788.stdout.log"));
        StderrLog = ResolvePath(Env("OMNI_STDERR_LOG", JsonValue(json, "stderrLog")), Path.Combine(baseDir, "omni-serve-7788.stderr.log"));
        LauncherErrorLog = ResolvePath(Env("OMNI_LAUNCHER_ERROR_LOG", JsonValue(json, "launcherErrorLog")), Path.Combine(baseDir, "omni-serve-7788.launcher.err.log"));

        var portText = Env("OMNI_HTTP_PORT", JsonValue(json, "port"));
        int parsedPort;
        Port = Int32.TryParse(portText, out parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 7788;
    }

    static string Env(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return String.IsNullOrEmpty(value) ? fallback : value;
    }

    static string JsonValue(string json, string key)
    {
        if (String.IsNullOrEmpty(json)) return null;
        var match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(\"((?:\\\\.|[^\"])*)\"|(-?\\d+))");
        if (!match.Success) return null;
        if (match.Groups[2].Success) return Regex.Replace(match.Groups[2].Value, @"\\(.)", "$1");
        return match.Groups[3].Value;
    }

    static string ResolvePath(string value, string fallback)
    {
        var selected = String.IsNullOrEmpty(value) ? fallback : value;
        return Path.GetFullPath(selected);
    }

    static void Log(string message)
    {
        try
        {
            Append(MainLog, "[" + DateTimeOffset.Now.ToString("o") + "] " + message + "\r\n");
        }
        catch
        {
            // Logging must never prevent the service from starting.
        }
    }

    static void Append(string path, string text)
    {
        lock (LogLock)
        {
            File.AppendAllText(path, text, Utf8);
        }
    }
}
