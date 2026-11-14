import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { createKnowledgeMaintenanceClient } from '../knowledge-maintenance.ts'

/** Summary and immutable report projections have independent leases. No report prefetch. */
export function createMaintenanceResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  const clients = new Map<string, { users: number; client: ReturnType<typeof createKnowledgeMaintenanceClient> }>()
  const key = (base: string, projectId: string, projection: string, entityId?: string) => canonicalResourceKey({ host: base,
    authGeneration: 0, projectId, resource: 'maintenance', projection, ...(entityId ? { entityId } : {}) })
  return {
    acquire(base: string, projectId: string) {
      const id = key(base, projectId, 'summary-v1')
      let entry = clients.get(id)
      if (!entry) { entry = { users: 0, client: createKnowledgeMaintenanceClient(base, request) }; clients.set(id, entry) }
      entry.users++
      const lease = views.acquire(id, signal => entry!.client.summary(signal))
      void lease.read()
      let released = false
      return { ...lease, release() {
        if (released) return
        released = true
        lease.release()
        if (--entry!.users === 0) clients.delete(id)
      } }
    },
    report(base: string, projectId: string, reportId: string) {
      const client = clients.get(key(base, projectId, 'summary-v1'))?.client ?? createKnowledgeMaintenanceClient(base, request)
      const lease = views.acquire(key(base, projectId, 'report-v1', reportId), signal => client.report(reportId, signal))
      void lease.read()
      return lease
    },
    dispose() { views.dispose(); clients.clear() },
  }
}
export const useMaintenanceResourceStore = defineStore('resource-maintenance', () => {
  const owner = markRaw(createMaintenanceResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
