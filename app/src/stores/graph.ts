import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { hostBase, projectBase } from '../api-url.ts'
import { createSessionGraphLoader } from '../session-graph-snapshot.ts'
import { createInitialLiveSnapshot } from '../initial-live-snapshot.ts'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { useLiveTransportStore } from './live.ts'
import type { LiveClient } from '../live-client.ts'

/** Full graph is distinct from the navigation directory. It is never prefetched.
 * Domain topology/partial-response validation stays in the existing adapter. */
export function createGraphResources(pool: { client(base: string): Pick<LiveClient, 'subscribe'> }, request: typeof fetch = fetch) {
  const views = resourceViews()
  return {
    acquire(base: string, projectId: string) {
      const host = hostBase(base), scope = projectBase(host, projectId)
      const key = canonicalResourceKey({ host, authGeneration: 0, projectId, resource: 'sessions', projection: 'full-graph-v1' })
      const loader = createSessionGraphLoader(scope, projectId, request)
      return views.acquire(key, loader.load, { initialLoading: true }, invalidate => {
        const gate = createInitialLiveSnapshot({ refresh: invalidate })
        const subscription = pool.client(host).subscribe({ kind: 'sessions', projectId }, {
          event(event) { loader.invalidate(event.payload); gate.invalidate() },
          reset() { loader.reset(); gate.reset() },
          reconnected() { loader.reset(); gate.reconnected() },
        })
        gate.attach(subscription)
        return () => { gate.dispose(); subscription.close() }
      })
    },
    dispose: views.dispose,
  }
}
export const useSessionGraphStore = defineStore('resource-session-graph', () => {
  const { pool } = useLiveTransportStore()
  const owner = markRaw(createGraphResources(pool))
  onScopeDispose(owner.dispose)
  return { owner }
})
