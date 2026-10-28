import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import { readWindowsProxy, resolveWindowsProxy, type WindowsProxySettings } from './windows-proxy.ts'
import { readMacOSProxy, type MacOSProxySettings } from './macos-proxy.ts'
export type { WindowsProxySettings } from './windows-proxy.ts'

export const proxyConfigurationSchema = z.object({
  source: z.enum(['direct', 'environment', 'windows-static', 'windows-auto', 'macos-static', 'macos-auto']),
  http: z.string().optional(),
  https: z.string().optional(),
  bypass: z.array(z.string()),
}).strict()
export type ProxyConfiguration = z.infer<typeof proxyConfigurationSchema>
let proxyEnabled = true
export function setLocalProxyEnabled(enabled: boolean): void { proxyEnabled = enabled }
export function isLocalProxyEnabled(): boolean { return proxyEnabled }

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
  if (settings.automatic) return { source: 'windows-auto', bypass: [] }
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

export function macOSProxyConfiguration(settings: MacOSProxySettings): ProxyConfiguration {
  if (settings.automatic) return { source: 'macos-auto', bypass: [] }
  if (settings.socks) throw new Error('SOCKS macOS system proxies are unsupported. Configure a static HTTP(S) proxy in Network > Proxies or HTTP_PROXY/HTTPS_PROXY.')
  if (!settings.http && !settings.https) return direct()
  return { source: 'macos-static',
    ...(settings.http ? { http: proxyUrl(settings.http) } : {}),
    ...(settings.https ? { https: proxyUrl(settings.https) } : {}),
    bypass: [...settings.bypass, ...(settings.excludeSimple ? ['<local>'] : [])],
  }
}

export async function localProxyConfiguration(signal?: AbortSignal, options: {
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readWindows?: typeof readWindowsProxy; readMacOS?: typeof readMacOSProxy; detectOnly?: boolean
} = {}): Promise<ProxyConfiguration> {
  signal?.throwIfAborted()
  if (!options.detectOnly && !proxyEnabled) return direct()
  const env = options.env ?? process.env
  const http = env.http_proxy ?? env.HTTP_PROXY
  const https = env.https_proxy ?? env.HTTPS_PROXY
  if (http !== undefined || https !== undefined) {
    return {
      source: 'environment', ...(http ? { http: proxyUrl(http) } : {}), ...(https ? { https: proxyUrl(https) } : {}),
      bypass: (env.no_proxy ?? env.NO_PROXY ?? '').split(/[,\s]+/).filter(Boolean),
    }
  }
  if ((options.platform ?? process.platform) === 'darwin') {
    const settings = await (options.readMacOS ?? readMacOSProxy)(signal)
    signal?.throwIfAborted()
    return macOSProxyConfiguration(settings)
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

function networkUrl(value: string | URL): URL {
  const url = new URL(value)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  if (url.protocol === 'ws:') url.protocol = 'http:'
  return url
}

function isLoopback(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' ||
    /^127\./.test(hostname) || /^::ffff:7f[0-9a-f]{2}:/.test(hostname)
}

export function proxyForUrl(configuration: ProxyConfiguration, value: string | URL): string | undefined {
  const url = networkUrl(value)
  // Never send local app credentials or loopback service traffic through an upstream proxy.
  if (isLoopback(url)) return undefined
  if (configuration.source === 'macos-auto') throw new Error('macOS PAC/automatic proxy resolution is not supported by the Node backend. Configure static Web Proxy and Secure Web Proxy in Network > Proxies, or HTTP_PROXY/HTTPS_PROXY; no direct fallback was attempted.')
  if (configuration.source === 'windows-auto') throw new Error('Automatic Windows proxy routes require asynchronous resolution.')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (configuration.source === 'windows-static' || configuration.source === 'macos-static') {
    if (configuration.bypass.some(pattern => {
      if (configuration.source === 'macos-static' && pattern.includes('/')) {
        const [address, prefix, extra] = pattern.split('/')
        const family = isIP(address)
        if (!family || extra !== undefined || !/^\d+$/.test(prefix ?? '')) return false
        try {
          const block = new BlockList()
          block.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6')
          return isIP(hostname) === family && block.check(hostname, family === 4 ? 'ipv4' : 'ipv6')
        } catch { return false }
      }
      return windowsBypass(pattern, url)
    })) return undefined
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

export async function resolveProxyForUrl(
  configuration: ProxyConfiguration, value: string | URL, signal?: AbortSignal,
  resolveWindows: typeof resolveWindowsProxy = resolveWindowsProxy,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  const url = networkUrl(value)
  if (isLoopback(url)) return undefined
  if (configuration.source !== 'windows-auto') return proxyForUrl(configuration, url)
  const route = await resolveWindows(url, signal)
  signal?.throwIfAborted()
  if (route.direct) return undefined
  // WinHTTP may return a failover list. Use its first route; never silently fail over to DIRECT.
  const server = route.server.includes('=') ? route.server : route.server.split(';')[0].trim()
  return proxyForUrl(windowsProxyConfiguration({
    enabled: true, server, bypass: route.bypass, automatic: false,
  }), url)
}
