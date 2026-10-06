$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$line = [Console]::ReadLine()
if ($null -eq $line) { exit 125 }
$request = $line | ConvertFrom-Json
$status = @{ code = -1; reason = 'supervisor-failed' }
$savedLib = $env:LIB
try {
# The C# compiler does not use inherited Visual C++ library search paths.
if ($null -ne $savedLib) { Remove-Item Env:LIB }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ShadowProcessGuardian {
    public static string Reason = "exited";
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public Limits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long user, kernel, periodUser, periodKernel;
        public uint faults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting data, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes security,
        uint creation, uint flags, IntPtr template);

    static void Check(bool okay) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            text.Append(c);
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Run(string program, string[] args, string cwd, bool verbatim, long deadline) {
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        bool assigned = false;
        ManualResetEvent cancelled = new ManualResetEvent(false);
        Thread reader = new Thread(delegate() { Console.ReadLine(); cancelled.Set(); });
        reader.IsBackground = true;
        reader.Start();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            SecurityAttributes security = new SecurityAttributes();
            security.length = Marshal.SizeOf(security);
            security.inherit = 1;
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1));
            StartupInfo startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.flags = 0x100;
            startup.stdin = input;
            startup.stdout = GetStdHandle(-11);
            startup.stderr = GetStdHandle(-12);
            Check(SetHandleInformation(startup.stdout, 1, 1));
            Check(SetHandleInformation(startup.stderr, 1, 1));
            StringBuilder command = new StringBuilder(Quote(program));
            foreach (string arg in args) command.Append(' ').Append(verbatim ? arg : Quote(arg));
            if (cancelled.WaitOne(0)) { Reason = "cancelled"; return 125; }
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadline) { Reason = "deadline-expired"; return 124; }
            // The command cannot execute before kernel ownership has been established.
            Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004,
                IntPtr.Zero, cwd, ref startup, out child));
            Check(AssignProcessToJobObject(job, child.process));
            assigned = true;
            if (!cancelled.WaitOne(0) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < deadline) {
                Check(ResumeThread(child.thread) != 0xffffffff);
            }
            int result;
            while (true) {
                uint wait = WaitForSingleObject(child.process, 20);
                if (wait == 0) {
                    uint exit;
                    Check(GetExitCodeProcess(child.process, out exit));
                    result = unchecked((int)exit);
                    break;
                }
                Check(wait == 258);
                if (cancelled.WaitOne(0)) { Reason = "cancelled"; result = 125; break; }
                if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadline) { Reason = "deadline-expired"; result = 124; break; }
            }
            Check(TerminateJobObject(job, unchecked((uint)result)));
            System.Diagnostics.Stopwatch elapsed = System.Diagnostics.Stopwatch.StartNew();
            while (true) {
                Accounting accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.activeProcesses == 0) break;
                if (elapsed.ElapsedMilliseconds >= 5000) throw new Exception("Job Object process cleanup timed out");
                Thread.Sleep(10);
            }
            return result;
        } finally {
            if (child.process != IntPtr.Zero && !assigned) TerminateProcess(child.process, 126);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
            if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
        }
    }
}
'@

$env:LIB = $savedLib
$code = [ShadowProcessGuardian]::Run(
    $request.command, [string[]]$request.args, $request.cwd,
    $request.windowsVerbatimArguments, [long]$request.deadlineAt)
$status = @{ code = $code; reason = [ShadowProcessGuardian]::Reason }
} catch {
    $status.error = $_.Exception.ToString()
} finally {
    $env:LIB = $savedLib
    [System.IO.File]::WriteAllText($request.statusPath, ($status | ConvertTo-Json -Compress),
        [System.Text.UTF8Encoding]::new($false))
}
exit 0
