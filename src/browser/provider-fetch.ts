import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { CapabilityError, resolveCapabilityAddresses } from '../execution/grants.ts'

export interface ProviderBrowserBinding { instance: string; targetId: string }
export interface ProviderBrowserAccess {
  binding: ProviderBrowserBinding
  assertCurrent(): void
  request: typeof fetch
}
type Command = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>

/** Private host connection. Never closes a target/browser, never accepts provider code. */
async function connect(endpoint: string): Promise<{ command: Command; close(): void }> {
  const socket = new WebSocket(endpoint, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 5000 })
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let id = 0
  const failure = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser connection unavailable')) }
    pending.clear()
  }
  socket.on('error', failure); socket.on('close', failure)
  socket.on('message', data => {
    try {
      const message = JSON.parse(String(data)), entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error('Browser command failed'))
      else entry.resolve(message.result)
    } catch { failure(); socket.terminate() }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve); socket.once('error', () => reject(new Error('Browser connection unavailable')))
  })
  return {
    command(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const key = ++id
        const timer = setTimeout(() => { pending.delete(key); reject(new Error('Browser command timed out')) }, 20000)
        pending.set(key, { resolve, reject, timer })
        socket.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
          if (error) { clearTimeout(timer); pending.delete(key); reject(new Error('Browser connection unavailable')) }
        })
      })
    },
    close() { failure(); socket.terminate() },
  }
}

/** Enumerate metadata only in an already-authorized managed browser. No navigation. */
export async function providerBrowserTargets(endpoint: string): Promise<Array<{ targetId: string; origin: string }>> {
  const client = await connect(endpoint)
  try {
    const { targetInfos } = await client.command('Target.getTargets')
    return targetInfos.filter((target: any) => target.type === 'page' && /^https:\/\//.test(target.url)).slice(0, 128)
      .map((target: any) => ({ targetId: target.targetId, origin: new URL(target.url).origin }))
  } finally { client.close() }
}

/** Cookie auth in an exact existing target. Private isolated world; no navigation. */
export async function browserProviderFetch(endpoint: string, targetId: string, input: URL | RequestInfo,
  init: RequestInit = {}, assertCurrent: () => void): Promise<Response> {
  const url = new URL(String(input))
  if (init.credentials !== 'include' || init.redirect !== 'error') throw new CapabilityError('browser_policy', 'Invalid browser transport policy.')
  assertCurrent(); init.signal?.throwIfAborted()
  // Chromium owns DNS/socket; preflight retains public-address checks but is not native DNS pinning.
  await resolveCapabilityAddresses(url.hostname.replace(/^\[|\]$/g, ''))
  assertCurrent(); init.signal?.throwIfAborted()
  const client = await connect(endpoint).catch(() => {
    throw new CapabilityError('browser_fetch_failed', 'Managed browser connection unavailable; no native fallback.')
  })
  let sessionId: string | undefined, contextId: number | undefined
  const key = `__shadow_fetch_${randomUUID().replaceAll('-', '')}`
  let aborted = false, fetchStarted = false, fetchSettled = false
  let cleanup: Promise<unknown> | undefined
  const abort = () => {
    aborted = true
    if (contextId !== undefined && sessionId) cleanup = client.command('Runtime.evaluate', {
      contextId, expression: `(async () => { const h = globalThis[${JSON.stringify(key)}]; if (h) { h.abort(); await h.done; } return true; })()`, awaitPromise: true, returnByValue: true,
    }, sessionId).then(result => result.result?.value === true, () => false)
  }
  init.signal?.addEventListener('abort', abort, { once: true })
  try {
    const target = await client.command('Target.getTargetInfo', { targetId })
    if (target.targetInfo.type !== 'page' || new URL(target.targetInfo.url).origin !== url.origin) throw new Error('Wrong page origin')
    ;({ sessionId } = await client.command('Target.attachToTarget', { targetId, flatten: true }))
    const { frameTree } = await client.command('Page.getFrameTree', {}, sessionId)
    if (new URL(frameTree.frame.url).origin !== url.origin) throw new Error('Wrong frame origin')
    const world = await client.command('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'shadow-provider-fetch-v1', grantUniveralAccess: false }, sessionId)
    contextId = world.executionContextId
    assertCurrent(); init.signal?.throwIfAborted()
    const config = JSON.stringify({ url: url.href, origin: url.origin, method: init.method, body: init.body, headers: init.headers, key })
    fetchStarted = true
    const { result, exceptionDetails } = await client.command('Runtime.evaluate', {
      contextId, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const c = ${config};
        if (location.origin !== c.origin) return {error:true};
        const controller = new AbortController(); let finish;
        globalThis[c.key] = {abort: () => controller.abort(), done: new Promise(resolve => {finish = resolve})};
        const timeout = setTimeout(() => controller.abort(), 15000);
        let reader;
        try {
          const response = await fetch(c.url, {method:c.method, body:c.body, headers:c.headers,
            credentials:'include', redirect:'error', mode:'cors', signal:controller.signal});
          if (response.type === 'opaque' || response.redirected || new URL(response.url).origin !== c.origin) return {error:true};
          reader = response.body?.getReader(); const chunks = []; let size = 0;
          if (reader) while (true) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength; if (size > 262144) throw new Error('limit');
            chunks.push(item.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return {status:response.status, text:new TextDecoder().decode(bytes)};
        } catch { return {error:true}; }
        finally { clearTimeout(timeout); controller.abort(); if (reader) await reader.cancel().catch(() => {}); delete globalThis[c.key]; finish(); }
      })()`,
    }, sessionId)
    fetchSettled = !exceptionDetails
    if (aborted) throw new Error('Aborted')
    assertCurrent(); init.signal?.throwIfAborted()
    const value = result?.value
    if (exceptionDetails || !value || value.error || !Number.isInteger(value.status) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > 1024 * 1024) throw new Error('Browser fetch failed')
    return new Response([204, 205, 304].includes(value.status) ? null : value.text, { status: value.status })
  } catch {
    throw new CapabilityError(aborted || init.signal?.aborted ? 'aborted' : 'browser_fetch_failed',
      'Browser fetch unavailable, cancelled, over limit, or blocked by origin/CORS/authentication policy; no native fallback.')
  } finally {
    init.signal?.removeEventListener('abort', abort)
    abort()
    const confirmed = await cleanup
    if (sessionId) await client.command('Target.detachFromTarget', { sessionId }).catch(() => undefined)
    client.close()
    if (fetchStarted && !fetchSettled && confirmed !== true) throw new CapabilityError('browser_cleanup_unconfirmed',
      'Browser fetch cleanup could not be confirmed; stop/reload is not confirmed drained. Inspect the managed browser before replacing this runtime.')
  }
}
