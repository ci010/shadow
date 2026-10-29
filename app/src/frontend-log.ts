import { installFrontendNetworkLog } from './frontend-network-log.ts'
import { createUuid } from './uuid.ts'
import { redactDiagnosticUrls } from '../../src/runtime/module-diagnostic.ts'

export function redactFrontendText(value: string): string {
  value = redactDiagnosticUrls(value)
  if (/(?:authorization|cookie|bearer\s|basic\s|(?:token|secret|password|credential|headers|body|payload|input|output|prompt|messages|content|api[-_]?key)\s*["']?\s*[:=])/i.test(value)) return '[redacted sensitive text]'
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '[redacted token]')
}
const levels = ['log', 'info', 'warn', 'error'] as const
const sensitive = /token|secret|password|credential|cookie|header|body|payload|input|prompt|message|content|auth|key|url/i

/** Does not invoke toJSON, getters, or arbitrary object string conversion. */
export function summarizeFrontendArgs(args: unknown[]): string {
  const seen = new WeakSet<object>()
  let budget = 80
  const visit = (value: unknown, depth: number): unknown => {
    if (--budget < 0) return '[limit]'
    if (typeof value === 'string') return redactFrontendText(value).slice(0, 2048)
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value !== 'object') return `[${typeof value}]`
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (depth > 2) return '[object]'
    try {
      if (value instanceof Error) {
        const result: Record<string, string> = { name: 'Error' }
        for (const key of ['name', 'message', 'stack']) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') result[key === 'message' ? 'detail' : key] = redactFrontendText(descriptor.value).slice(0, 2048)
        }
        return result
      }
      // Unknown platform/DOM objects are not enumerated.
      const proto = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return '[non-plain object]'
      const result: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(value).slice(0, 20)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        result[key.slice(0, 80)] = sensitive.test(key) ? '[redacted field]' : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[accessor]'
      }
      return result
    } catch { return '[unavailable]' }
  }
  try { return JSON.stringify(args.slice(0, 10).map(arg => visit(arg, 0))).slice(0, 4096) } catch { return '[unserializable]' }
}

/** Transport is silent: no console use on any diagnostic failure. */
export function installFrontendLog(target: Window & { console: Console }, send: (events: Array<{ level: string; message: string }>) => Promise<unknown>, networkBase?: string): () => void {
  const logger = target.console
  let active = true
  let inside = false
  let sending = false
  let queue: Array<{ level: string; message: string }> = []
  let count = 0
  let minute = Date.now()
  const capture = (level: string, args: unknown[]) => {
    if (!active || inside) return
    inside = true
    try {
      if (Date.now() - minute >= 60_000) { minute = Date.now(); count = 0 }
      if (count++ < 120 && queue.length < 20) queue.push({ level, message: summarizeFrontendArgs(args) })
    } catch { /* diagnostics must never affect the application */ } finally { inside = false }
  }
  const originals = levels.map(level => logger[level])
  const wrappers = levels.map((level, index) => {
    const wrapper = (...args: unknown[]) => {
      // Preserve arguments, receiver, return/throw behavior of the original method.
      const result = Reflect.apply(originals[index]!, logger, args)
      capture(level, args)
      return result
    }
    logger[level] = wrapper
    return wrapper
  })
  const stopNetwork = networkBase ? installFrontendNetworkLog(target as Window & typeof globalThis, networkBase, message => capture('error', [message])) : () => {}
  const error = (event: ErrorEvent) => {
    if (event.error || event.message) capture('window.error', [event.error ?? event.message])
    else capture('window.error', ['Resource failed to load (URL omitted; native status unavailable)'])
  }
  const rejection = (event: PromiseRejectionEvent) => capture('unhandledrejection', [event.reason])
  target.addEventListener('error', error, true)
  target.addEventListener('unhandledrejection', rejection)
  const timer = target.setInterval(() => {
    if (!queue.length || sending) return
    // The server's 96 KiB limit is bytes, not characters. Leave room for
    // the envelope/tab ID and split multi-byte or heavily escaped summaries.
    let bytes = 0
    let length = 0
    for (const event of queue) {
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1
      if (bytes + size > 90 * 1024) break
      bytes += size; length++
    }
    const events = queue.splice(0, length)
    sending = true
    void Promise.resolve().then(() => {
      if (!active) return
      // Suppress only synchronous transport diagnostics, not application logs
      // emitted while an asynchronous request is in flight.
      inside = true
      try { return send(events) } finally { inside = false }
    }).catch(() => {
      if (active) queue = [...events, ...queue].slice(0, 20)
    }).finally(() => { sending = false })
  }, 1000)
  return () => {
    active = false; queue = []
    stopNetwork()
    target.clearInterval(timer)
    target.removeEventListener('error', error, true)
    target.removeEventListener('unhandledrejection', rejection)
    levels.forEach((level, index) => { if (logger[level] === wrappers[index]) logger[level] = originals[index]! })
  }
}

/** Discover diagnostics for the explicit visible Project. Capability discovery
 * is authoritative even for production-built Child assets. Only a Vite development
 * caller may opt into bounded early capture before the authenticated capability responds. */
export function startFrontendLog(base: string, signal: AbortSignal, captureEarly = false): () => void {
  if (signal.aborted) return () => {}
  const endpoint = `${base.replace(/\/$/, '')}/api/runtime/frontend-logs`
  const tabId = createUuid()
  // Coarse, unverified diagnostic labels only; never identifiers or authorization.
  const platformHint = typeof navigator === 'undefined' ? '' : navigator.platform
  const client = { platform: /Win/i.test(platformHint) ? 'windows' : /Mac/i.test(platformHint) ? 'macos' : /Linux/i.test(platformHint) ? 'linux' : 'other',
    renderer: captureEarly ? 'vite-development' : 'built' }
  let active = true
  let enabled = false
  let uninstall = () => {}
  let retry: number | undefined
  let checking: Promise<void> | undefined
  const check = (): Promise<void> => {
    if (enabled) return Promise.resolve()
    if (!checking) checking = (async () => {
      // Match normal API requests: cookies only on same-origin web deployments.
      // Cross-port desktop requests use the native launch Authorization header;
      // the gateway deliberately does not allow cross-origin cookie credentials.
      const response = await fetch(endpoint, { credentials: 'same-origin', signal, cache: 'no-store' })
      if (!active || signal.aborted) return
      if (response.status === 404) { stop(); return }
      if (!response.ok) throw new Error('Frontend diagnostics capability unavailable')
      if ((await response.json()).enabled !== true) { stop(); return }
      if (active && !signal.aborted) {
        enabled = true
        if (retry !== undefined) { window.clearInterval(retry); retry = undefined }
        if (!captureEarly) install()
      }
    })().finally(() => { checking = undefined })
    return checking
  }
  const install = () => { uninstall = installFrontendLog(window, async events => {
    await check()
    if (!active || signal.aborted || !enabled) return
    const response = await fetch(endpoint, {
      method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId, client, events }),
    })
    // Temporary authentication loss retries without uninstalling hooks; invalid/oversized batches are
    // dropped rather than starving all future logs with a permanent retry.
    if (response.status === 404) { stop(); return }
    if (!response.ok && ([401, 403, 429].includes(response.status) || response.status >= 500)) {
      throw new Error('Frontend diagnostics batch not accepted')
    }
  }, base) }
  function stop() {
    active = false
    signal.removeEventListener('abort', stop)
    uninstall()
    if (retry !== undefined) window.clearInterval(retry)
  }
  if (captureEarly) install()
  else retry = window.setInterval(() => { void check().catch(() => {}) }, 5000)
  signal.addEventListener('abort', stop, { once: true })
  void check().catch(() => {})
  return stop
}
