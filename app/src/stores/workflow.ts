import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { createWorkflowClient } from '../workflows.ts'

/** Workflow has no server invalidation topic yet: one active-only reconciliation timer.
 * It is shared across consumers, not a component polling loop or second reader. */
export function createWorkflowResources(request: typeof fetch = fetch, fallbackMs = 30_000) {
  const views = resourceViews(16)
  return {
    acquire(base: string, projectId: string) {
      const client = createWorkflowClient(base, projectId, request)
      const key = canonicalResourceKey({ host: base, authGeneration: 0, projectId, resource: 'workflow', projection: 'sync-v1' })
      const lease = views.acquire(key, client.read, {}, invalidate => {
        invalidate()
        let timer: ReturnType<typeof setTimeout>
        let closed = false
        function schedule() { timer = setTimeout(() => { if (!closed) { invalidate(); schedule() } }, fallbackMs) }
        schedule()
        return () => { closed = true; clearTimeout(timer) }
      })
      void lease.read()
      return lease
    },
    dispose: views.dispose,
  }
}
export const useWorkflowResourceStore = defineStore('resource-workflow', () => {
  const owner = markRaw(createWorkflowResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
