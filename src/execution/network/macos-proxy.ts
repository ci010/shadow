import { execFile } from 'node:child_process'

export interface MacOSProxySettings {
  http?: string
  https?: string
  bypass: string[]
  excludeSimple: boolean
  automatic: boolean
  socks: boolean
}

const invalid = () => new Error('macOS system proxy settings could not be read safely; check Network > Proxies or configure HTTP_PROXY/HTTPS_PROXY. No settings were logged.')

// scutil exposes the effective SystemConfiguration dictionary, not a guessed network service.
// Only the top-level effective policy applies; __SCOPED__/__SUPPLEMENTAL__ are not global routes.
export function parseMacOSProxyOutput(output: string): MacOSProxySettings {
  if (output.length > 65_536) throw invalid()
  const text = output.trim() === '<dictionary> {}' ? '<dictionary> {\n}' : output.trim()
  const lines = text.split(/\r?\n/).map(line => line.trim())
  if (lines.shift() !== '<dictionary> {' || lines.pop() !== '}') throw invalid()
  const values = new Map<string, string>()
  const bypass: string[] = []
  let depth = 0
  let exceptions = false
  for (const line of lines) {
    if (line === '}') {
      if (depth === 0) throw invalid()
      depth--
      if (!depth) exceptions = false
      continue
    }
    if (depth) {
      if (exceptions && depth === 1) {
        const match = line.match(/^\d+ : (.+)$/)
        if (!match || /[\x00-\x1f]/.test(match[1])) throw invalid()
        bypass.push(match[1])
      }
      if (line.endsWith('{')) depth++
      continue
    }
    const match = line.match(/^(\w+) : (.*)$/)
    if (!match || values.has(match[1])) throw invalid()
    values.set(match[1], match[2])
    if (match[2].endsWith('{')) {
      depth++
      exceptions = match[1] === 'ExceptionsList'
      if (exceptions && match[2] !== '<array> {') throw invalid()
    }
  }
  if (depth) throw invalid()
  const enabled = (key: string) => {
    const value = values.get(key)
    if (value !== undefined && value !== '0' && value !== '1') throw invalid()
    return value === '1'
  }
  const route = (scheme: string) => {
    if (!enabled(`${scheme}Enable`)) return undefined
    const host = values.get(`${scheme}Proxy`)
    const port = values.get(`${scheme}Port`)
    if (!host || !/^[a-zA-Z0-9._\-:[\]]+$/.test(host) || !port || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw invalid()
    // Secure Web Proxy means CONNECT for HTTPS destinations, not TLS to the proxy.
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
  }
  return {
    http: route('HTTP'), https: route('HTTPS'), bypass,
    excludeSimple: enabled('ExcludeSimpleHostnames'),
    automatic: enabled('ProxyAutoConfigEnable') || enabled('ProxyAutoDiscoveryEnable'),
    socks: enabled('SOCKSEnable'),
  }
}

export async function readMacOSProxy(signal?: AbortSignal): Promise<MacOSProxySettings> {
  signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('macOS system proxy discovery requires macOS.')
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--proxy'], {
      signal, timeout: 5000, maxBuffer: 65_536, encoding: 'utf8',
    }, (error, stdout) => {
      if (signal?.aborted) reject(signal.reason)
      else if (error) reject(invalid())
      else resolve(stdout)
    })
  })
  signal?.throwIfAborted()
  return parseMacOSProxyOutput(output)
}
