import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { apiUrl } from '../api-url.ts'
import { createFoldersClient } from '../folders-client.ts'
import { fetchNodeInventory } from '../node-inventory.ts'
import { fetchAutomations } from '../automations.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from '../live-resource-refresh.ts'
import { liveProjectId } from '../composables/useLiveClient.ts'
import { workCompletionsSchema } from '../../../src/initiatives/work-contract.ts'
import { projectUsageSchema, projectUsagePageSchema } from '../../../src/projects/usage-contract.ts'

/** App-owned read projections. Commands are never cached or replayed. */
export function createCatalogResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  const key = (base: string, projectId: string, resource: string, query?: unknown) => canonicalResourceKey({ host: apiUrl(base, '/').toString(),
    authGeneration: 0, projectId, resource, projection: 'v1', query })
  async function json(base: string, path: string, signal: AbortSignal) {
    const response = await request(apiUrl(base, path), { signal, cache: 'no-store' })
    if (!response.ok) throw Object.assign(new Error('Resource request failed'), { status: response.status })
    return response.json()
  }
  return {
    folders(base: string, projectId: string, pool: ResourceLivePool) {
      return views.acquire(key(base, projectId, 'folders'), signal => createFoldersClient(base, request).list(signal), {}, invalidate => {
        const live = createLiveResourceRefresh(pool, { base, projectId, resource: 'folders', refresh: invalidate })
        return live.dispose
      })
    },
    nodes(base: string, projectId: string, pool: ResourceLivePool) {
      return views.acquire(key(base, projectId, 'node-inventory'), signal => fetchNodeInventory(base, 'main',
        AbortSignal.any([signal, AbortSignal.timeout(5_000)]), request), {}, invalidate => {
        const live = createLiveResourceRefresh(pool, { base, projectId, resource: 'nodes', refresh: invalidate })
        return live.dispose
      })
    },
    automations(base: string, pool: ResourceLivePool) {
      const projectId = liveProjectId(base)
      return views.acquire(key(base, projectId, 'automations'), async signal => {
        try { return await fetchAutomations(base, signal, request) }
        catch (error) { if ((error as { kind?: string })?.kind === 'denied') Object.assign(error as object, { status: 403 }); throw error }
      }, {}, invalidate => {
        const live = createLiveResourceRefresh(pool, { base, projectId, resource: 'automations', refresh: invalidate })
        return live.dispose
      })
    },
    completions(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'work-completions'), async signal =>
        workCompletionsSchema.parse(await json(base, '/api/work/completions', signal)).items)
      void lease.read(); return lease
    },
    usage(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'usage-summary'), async signal => {
        const result = projectUsageSchema.parse(await json(base, '/api/project/usage', signal))
        if (result.projectId !== projectId) throw new Error('Project mismatch')
        return result
      })
      void lease.read(); return lease
    },
    usagePage(base: string, projectId: string, page: number) {
      const lease = views.acquire(key(base, projectId, 'usage-daily', { page }), async signal => {
        const result = projectUsagePageSchema.parse(await json(base, `/api/project/usage/daily?page=${page}`, signal))
        if (result.projectId !== projectId || result.page !== page) throw new Error('Usage page mismatch')
        return result
      })
      void lease.read(); return lease
    },
    dispose: views.dispose,
  }
}
export const useCatalogResourceStore = defineStore('resource-catalog', () => {
  const owner = markRaw(createCatalogResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
