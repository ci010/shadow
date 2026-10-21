export function redactFrontendText(value: string): string {
  if (/(?:authorization|cookie|bearer\s|basic\s|(?:token|secret|password|credential|headers|body|payload|input|output|prompt|messages|content|api[-_]?key)\s*["']?\s*[:=])/i.test(value)) return '[redacted sensitive text]'
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[redacted URL]')
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
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') result[key] = redactFrontendText(descriptor.value).slice(0, 2048)
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
export function installFrontendLog(target: Window & { console: Console }, send: (events: Array<{ level: string; message: string }>) => Promise<unknown>): () => void {
  const logger = target.console
  let active = true
  let inside = false
  let sending = false
  let queue: Array<{ level: string; message: string }> = []
  let count = 0
  let minute = Date.now()
  const capture = (level: string, args: unknown[]) => {
    if (!active || inside || sending) return
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
  const error = (event: ErrorEvent) => capture('window.error', [event.error ?? event.message])
  const rejection = (event: PromiseRejectionEvent) => capture('unhandledrejection', [event.reason])
  target.addEventListener('error', error)
  target.addEventListener('unhandledrejection', rejection)
  const timer = target.setInterval(() => {
    if (!queue.length || sending) return
    const events = queue; queue = []; sending = true
    void Promise.resolve().then(() => send(events)).catch(() => {}).finally(() => { sending = false })
  }, 1000)
  return () => {
    active = false; queue = []
    target.clearInterval(timer)
    target.removeEventListener('error', error)
    target.removeEventListener('unhandledrejection', rejection)
    levels.forEach((level, index) => { if (logger[level] === wrappers[index]) logger[level] = originals[index]! })
  }
}

export async function startFrontendLog(base: string, signal: AbortSignal): Promise<() => void> {
  const endpoint = `${base.replace(/\/$/, '')}/api/runtime/frontend-logs`
  try {
    const response = await fetch(endpoint, { credentials: 'include', signal })
    if (!response.ok || (await response.json()).enabled !== true || signal.aborted) return () => {}
    const tabId = crypto.randomUUID()
    const stop = installFrontendLog(window, events => fetch(endpoint, {
      method: 'POST', credentials: 'include', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId, events }),
    }))
    signal.addEventListener('abort', stop, { once: true })
    return stop
  } catch { return () => {} }
}
