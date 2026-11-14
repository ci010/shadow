import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { createChatHistorySnapshots, type ChatHistorySnapshotResult } from '../chat-history-snapshot.ts'
import { createReadonlyHistorySnapshots } from '../readonly-history-snapshot.ts'
import { canonicalResourceKey, createResource, ResourceRegistry } from '../resources/engine.ts'

export interface ChatReadScope { projectId: string; authGeneration?: number }
type Result<T> = { value: T; error?: never } | { error: unknown; value?: never }

/** History is a specialized protocol adapter, not an ordinary entity collection.
 * Adapter caches retain their byte/entry budgets and validators. The registry owns
 * only active flights; it never keeps another long-lived copy of message bodies.
 * Stream presentation/request controls stay with the pane and share LiveClient.
 */
export function createChatResources(request: typeof fetch = fetch) {
  const flights = new ResourceRegistry({ maxInactive: 0 })
  const delivered = new WeakSet<object>()
  type Adapters = { direct: ReturnType<typeof createChatHistorySnapshots>; readonly: ReturnType<typeof createReadonlyHistorySnapshots>; users: number }
  const adapters = new Map<string, Adapters>()
  let disposed = false
  function acquireAdapters(host: string, scope: ChatReadScope) {
    const key = canonicalResourceKey({ host, authGeneration: scope.authGeneration ?? 0, projectId: scope.projectId,
      resource: 'chat', projection: 'protocol-bases-v1' })
    let entry = adapters.get(key)
    if (!entry) {
      entry = { direct: createChatHistorySnapshots(request, 8 * 1024 * 1024, 8),
        readonly: createReadonlyHistorySnapshots(request, 8 * 1024 * 1024, 8), users: 0 }
    }
    adapters.delete(key); adapters.set(key, entry); entry.users++
    return { entry, release() {
      entry!.users--
      // At most two inactive scopes, with a combined 32 MiB protocol budget.
      let inactive = [...adapters.values()].filter(value => !value.users).length
      for (const [key, value] of adapters) {
        if (inactive <= 2) break
        if (!value.users) { value.direct.dispose(); value.readonly.dispose(); adapters.delete(key); inactive-- }
      }
    } }
  }

  async function read<T>(kind: string, url: string | URL, scope: ChatReadScope, signal: AbortSignal,
    load: (signal: AbortSignal, adapters: Adapters) => Promise<T>): Promise<T> {
    if (disposed || signal.aborted) throw new DOMException('History read cancelled', 'AbortError')
    const target = new URL(url)
    const key = canonicalResourceKey({ host: target.origin, authGeneration: scope.authGeneration ?? 0,
      projectId: scope.projectId, resource: 'chat', projection: kind, query: target.toString() })
    const lease = flights.acquire(key, () => createResource<Result<T>>(async signal => {
      const protocol = acquireAdapters(target.origin, scope)
      try { return { value: await load(signal, protocol.entry) } } catch (error) { return { error } }
      finally { protocol.release() }
    }))
    let abort: (() => void) | undefined
    try {
      await Promise.race([lease.resource.read(), new Promise<never>((_, reject) => {
        abort = () => { lease.release(); reject(new DOMException('History read cancelled', 'AbortError')) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
      if (signal.aborted || disposed) throw new DOMException('History read cancelled', 'AbortError')
      const result = lease.resource.state.value
      if (!result) throw new Error('History read was disposed')
      if ('error' in result) throw result.error
      return result.value
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
      lease.release()
    }
  }
  return {
    async readDirect(url: string | URL, scope: ChatReadScope, signal: AbortSignal): Promise<ChatHistorySnapshotResult> {
      const result = await read('direct-history-v1', url, scope, signal, (signal, adapters) => adapters.direct.read(url, signal))
      // The adapter already transfers an independently owned body. The usual
      // single-pane path adds no deep image/base64 traversal. Only additional
      // concurrent panes require another independently mutable presentation body.
      if (!delivered.has(result)) { delivered.add(result); return result }
      return result.ok ? { ...result, data: structuredClone(result.data) } : { ...result, response: result.response.clone() }
    },
    async readReadonly(url: string | URL, scope: ChatReadScope, signal: AbortSignal): Promise<Response> {
      const result = await read('readonly-history-v1', url, scope, signal, async (signal, adapters) => {
        const response = await adapters.readonly.read(url, signal)
        return { status: response.status, statusText: response.statusText, headers: response.headers,
          body: await response.text() }
      })
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers })
    },
    /** On-demand context and immutable physical segments share only their active
     * read. Pagination/segment order and stream overlays remain domain-owned. */
    async readDocument(url: string | URL, scope: ChatReadScope, signal: AbortSignal,
      projection: 'context-v1' | 'physical-history-v1'): Promise<Response> {
      const result = await read(projection, url, scope, signal, async signal => {
        const response = await request(url, { signal, cache: 'no-store' })
        return { status: response.status, statusText: response.statusText, headers: response.headers,
          body: await response.text() }
      })
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers: result.headers })
    },
    dispose() {
      if (disposed) return
      disposed = true
      flights.dispose()
      for (const entry of adapters.values()) { entry.direct.dispose(); entry.readonly.dispose() }
      adapters.clear()
    },
  }
}

export const useChatResourceStore = defineStore('resource-chat', () => {
  const owner = markRaw(createChatResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
