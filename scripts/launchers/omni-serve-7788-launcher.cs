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
    private const string Repo = @"D:\xiangmu\全息记忆";
    private const string Node = @"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe";
    private const string MainLog = @"C:\Users\Administrator\.dsh\omni-serve-7788.log";
    private const string ErrorLog = @"C:\Users\Administrator\.dsh\omni-serve-7788.err.log";
    private const string StdoutLog = @"C:\Users\Administrator\.dsh\omni-serve-7788.stdout.log";
    private const string StderrLog = @"C:\Users\Administrator\.dsh\omni-serve-7788.stderr.log";
    private const string LauncherErrorLog = @"C:\Users\Administrator\.dsh\omni-serve-7788.launcher.err.log";
    private const int Port = 7788;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly object LogLock = new object();

    static int Main()
    {
        try
        {
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
            if (commandLine != null && Regex.IsMatch(commandLine, @"cli\.mjs.*serve.*" + Port, RegexOptions.IgnoreCase))
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
                "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
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
