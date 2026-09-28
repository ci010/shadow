import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execFileAsync = promisify(execFile)
export const proxyConfigurationSchema = z.object({
  source: z.enum(['direct', 'environment', 'windows-static']),
  http: z.string().optional(),
  https: z.string().optional(),
  bypass: z.array(z.string()),
}).strict()
export type ProxyConfiguration = z.infer<typeof proxyConfigurationSchema>
export interface WindowsProxySettings { enabled: boolean; server: string; bypass: string; automatic: boolean }
const direct = (): ProxyConfiguration => ({ source: 'direct', bypass: [] })

function proxyUrl(value: string): string {
  let url: URL
  try { url = new URL(value.includes('://') ? value : `http://${value}`) }
  catch { throw new Error('The configured proxy address is invalid; its value was not logged.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/' || /[\s\x00-\x1f]/.test(value)) {
    throw new Error('Local app/download proxies require an HTTP(S) address without credentials, paths or control characters.')
  }
  return url.href
}

export function windowsProxyConfiguration(settings: WindowsProxySettings): ProxyConfiguration {
  if (settings.automatic) throw new Error('Automatic/PAC proxy configuration is not supported by local Node downloads; use an explicitly configured HTTP(S) proxy or a Windows-aware client.')
  if (!settings.enabled || !settings.server.trim()) return direct()
  const configuration: ProxyConfiguration = {
    source: 'windows-static', bypass: settings.bypass.split(';').map(value => value.trim()).filter(Boolean),
  }
  if (!settings.server.includes('=')) {
    configuration.http = configuration.https = proxyUrl(settings.server.trim())
  } else {
    for (const entry of settings.server.split(';')) {
      const separator = entry.indexOf('=')
      const scheme = entry.slice(0, separator).trim().toLowerCase()
      if (scheme === 'http' || scheme === 'https') configuration[scheme] = proxyUrl(entry.slice(separator + 1).trim())
      else if (scheme === 'socks') throw new Error('SOCKS system proxies are not supported by the local HTTP(S) downloader.')
    }
    if (!configuration.http && !configuration.https) throw new Error('The Windows proxy configuration has no supported HTTP(S) route.')
  }
  return configuration
}

async function readWindowsProxy(signal?: AbortSignal): Promise<WindowsProxySettings> {
  const windows = process.env.SystemRoot ?? process.env.WINDIR
  if (!windows) throw new Error('Windows directory is unavailable for reading the configured system proxy.')
  const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=($p.ProxyEnable -eq 1);server=[string]$p.ProxyServer;bypass=[string]$p.ProxyOverride;automatic=[bool]$p.AutoConfigURL}|ConvertTo-Json -Compress"
  let stdout: string
  try {
    const result = await execFileAsync(join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { signal, timeout: 5000, maxBuffer: 16_384, windowsHide: true, encoding: 'utf8' })
    stdout = result.stdout
  } catch {
    signal?.throwIfAborted()
    throw new Error('Unable to read the Windows proxy configuration; no settings or credentials were logged.')
  }
  return z.object({ enabled: z.boolean(), server: z.string(), bypass: z.string(), automatic: z.boolean() })
    .parse(JSON.parse(stdout))
}

export async function localProxyConfiguration(signal?: AbortSignal, options: {
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readWindows?: typeof readWindowsProxy
} = {}): Promise<ProxyConfiguration> {
  signal?.throwIfAborted()
  const env = options.env ?? process.env
  const http = env.http_proxy ?? env.HTTP_PROXY
  const https = env.https_proxy ?? env.HTTPS_PROXY
  if (http !== undefined || https !== undefined) {
    return {
      source: 'environment', ...(http ? { http: proxyUrl(http) } : {}), ...(https ? { https: proxyUrl(https) } : {}),
      bypass: (env.no_proxy ?? env.NO_PROXY ?? '').split(/[,\s]+/).filter(Boolean),
    }
  }
  if ((options.platform ?? process.platform) !== 'win32') return direct()
  const settings = await (options.readWindows ?? readWindowsProxy)(signal)
  signal?.throwIfAborted()
  return windowsProxyConfiguration(settings)
}

function windowsBypass(pattern: string, url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (pattern.toLowerCase() === '<local>') return !hostname.includes('.') && isIP(hostname) === 0
  const expression = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return expression.test(hostname) || expression.test(url.host) || expression.test(url.origin)
}

export function proxyForUrl(configuration: ProxyConfiguration, value: string | URL): string | undefined {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  // Never send local app credentials or loopback service traffic through an upstream proxy.
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    /^127\./.test(hostname) || /^::ffff:7f[0-9a-f]{2}:/.test(hostname)) return undefined
  if (configuration.source === 'windows-static') {
    if (configuration.bypass.some(pattern => windowsBypass(pattern, url))) return undefined
  } else if (configuration.bypass.some(entry => {
    if (entry === '*') return true
    const match = entry.match(/^(.+):(\d+)$/)
    if (match && match[2] !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false
    const host = (match?.[1] ?? entry).replace(/^\*?\./, '').replace(/^\[|\]$/g, '').toLowerCase()
    return hostname === host || hostname.endsWith(`.${host}`)
  })) return undefined
  return url.protocol === 'https:' ? configuration.https ?? (configuration.source === 'environment' ? configuration.http : undefined)
    : url.protocol === 'http:' ? configuration.http : undefined
}
