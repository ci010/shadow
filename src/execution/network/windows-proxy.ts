import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'

const settingsSchema = z.object({
  enabled: z.boolean(), server: z.string(), bypass: z.string(), automatic: z.boolean(),
})
export type WindowsProxySettings = z.infer<typeof settingsSchema>
const routeSchema = z.object({ accessType: z.number().int(), server: z.string(), bypass: z.string() })

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ShadowWindowsProxy {
  [StructLayout(LayoutKind.Sequential)]
  public struct Settings {
    [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
    public IntPtr AutoConfigUrl, Proxy, Bypass;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Options {
    public uint Flags, AutoDetectFlags;
    [MarshalAs(UnmanagedType.LPWStr)] public string AutoConfigUrl;
    public IntPtr Reserved;
    public uint ReservedFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool AutoLogon;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Route {
    public uint AccessType;
    public IntPtr Proxy, Bypass;
  }
  [DllImport("winhttp.dll", SetLastError = true)]
  static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Settings settings);
  [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr WinHttpOpen(string agent, uint accessType, string proxy, string bypass, uint flags);
  [DllImport("winhttp.dll", SetLastError = true)]
  static extern bool WinHttpSetTimeouts(IntPtr session, int resolve, int connect, int send, int receive);
  [DllImport("winhttp.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool WinHttpGetProxyForUrl(IntPtr session, string url, ref Options options, out Route route);
  [DllImport("winhttp.dll")]
  static extern bool WinHttpCloseHandle(IntPtr session);
  [DllImport("kernel32.dll")]
  static extern IntPtr GlobalFree(IntPtr memory);
  static string Text(IntPtr value) { return Marshal.PtrToStringUni(value) ?? ""; }
  static void Free(IntPtr value) { if (value != IntPtr.Zero) GlobalFree(value); }
  static Settings Read() {
    Settings settings;
    if (!WinHttpGetIEProxyConfigForCurrentUser(out settings))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return settings;
  }
  static void Free(Settings settings) {
    Free(settings.AutoConfigUrl); Free(settings.Proxy); Free(settings.Bypass);
  }
  public static object ReadSettings() {
    Settings settings = Read();
    try {
      string proxy = Text(settings.Proxy);
      return new {
        enabled = proxy.Length != 0, server = proxy, bypass = Text(settings.Bypass),
        automatic = settings.AutoDetect || settings.AutoConfigUrl != IntPtr.Zero
      };
    } finally { Free(settings); }
  }
  public static object Resolve(string url, string explicitPac) {
    Settings settings = new Settings();
    IntPtr session = IntPtr.Zero;
    Route route = new Route();
    try {
      if (String.IsNullOrEmpty(explicitPac)) settings = Read();
      string pac = String.IsNullOrEmpty(explicitPac) ? Text(settings.AutoConfigUrl) : explicitPac;
      if (pac.Length == 0 && !settings.AutoDetect) {
        string proxy = Text(settings.Proxy);
        return new { accessType = proxy.Length == 0 ? 1u : 3u, server = proxy, bypass = Text(settings.Bypass) };
      }
      session = WinHttpOpen("Shadow proxy resolver", 1, null, null, 0);
      if (session == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!WinHttpSetTimeouts(session, 5000, 5000, 5000, 5000))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      Options options = new Options {
        Flags = pac.Length != 0 ? 2u : 1u,
        AutoDetectFlags = pac.Length != 0 ? 0u : 3u,
        AutoConfigUrl = pac.Length != 0 ? pac : null,
        AutoLogon = false
      };
      if (!WinHttpGetProxyForUrl(session, url, ref options, out route)) {
        int error = Marshal.GetLastWin32Error();
        // No WPAD configuration is different from a configured PAC failing.
        if (pac.Length == 0 && error == 12180) {
          string proxy = Text(settings.Proxy);
          return new { accessType = proxy.Length == 0 ? 1u : 3u, server = proxy, bypass = Text(settings.Bypass) };
        }
        throw new Win32Exception(error);
      }
      return new { accessType = route.AccessType, server = Text(route.Proxy), bypass = Text(route.Bypass) };
    } finally {
      Free(route.Proxy); Free(route.Bypass); Free(settings);
      if (session != IntPtr.Zero) WinHttpCloseHandle(session);
    }
  }
}
'@
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($inputData.operation -eq 'settings') {
    [ShadowWindowsProxy]::ReadSettings() | ConvertTo-Json -Compress
  } else {
    [ShadowWindowsProxy]::Resolve($inputData.url, $inputData.pacUrl) | ConvertTo-Json -Compress
  }
} catch {
  $errorCode = $_.Exception.GetBaseException().NativeErrorCode
  @{errorCode = [int]$errorCode} | ConvertTo-Json -Compress
  exit 1
}
`

async function invoke(input: { operation: 'settings' | 'resolve'; url?: string; pacUrl?: string }, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') throw new Error('Windows system proxy resolution requires Windows.')
  const windows = process.env.SystemRoot ?? process.env.WINDIR
  if (!windows) throw new Error('Windows directory is unavailable for reading the configured system proxy.')
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { signal, timeout: input.operation === 'settings' ? 5000 : 15_000, maxBuffer: 16_384, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (signal?.aborted) { reject(signal.reason); return }
        if (error) {
          const code = stdout.match(/"errorCode"\s*:\s*(\d+)/)?.[1]
          const detail = code === '12167'
            ? 'Windows could not download the configured PAC script. Check that the PAC service is running and reachable.'
            : code === '12166' ? 'Windows could not evaluate the configured PAC script.'
            : code === '12002' ? 'Windows proxy resolution timed out.'
            : `Windows proxy ${input.operation} failed.`
          reject(new Error(`${detail}${code ? ` (WinHTTP ${code})` : ''} No settings or destination were logged.`))
        } else resolve(stdout)
      })
    child.stdin!.on('error', () => { child.kill() })
    child.stdin!.end(JSON.stringify(input))
  })
  try { return JSON.parse(stdout) }
  catch { throw new Error('Windows proxy resolution returned an invalid response; no settings or destination were logged.') }
}

export async function readWindowsProxy(signal?: AbortSignal): Promise<WindowsProxySettings> {
  const result = settingsSchema.safeParse(await invoke({ operation: 'settings' }, signal))
  if (!result.success) throw new Error('Windows proxy settings have an invalid format; their values were not logged.')
  return result.data
}

export async function resolveWindowsProxy(url: URL, signal?: AbortSignal, pacUrl?: string) {
  const result = routeSchema.safeParse(await invoke({ operation: 'resolve', url: url.href, pacUrl }, signal))
  if (!result.success || ![1, 3].includes(result.data.accessType)) {
    throw new Error('Windows returned an unsupported proxy route; its value was not logged.')
  }
  if (result.data.accessType === 3 && !result.data.server.trim()) {
    throw new Error('Windows returned an empty proxy route; refusing to bypass the system proxy.')
  }
  return { ...result.data, direct: result.data.accessType === 1 }
}
