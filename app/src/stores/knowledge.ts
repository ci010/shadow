import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { createKnowledgeClient } from '../knowledge.ts'

/** No knowledge live topic exists. Explicit refresh and activation revalidate;
 * neither an idle timer nor a hidden detail prefetch is introduced. */
export function createKnowledgeResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  const key = (base: string, projectId: string, projection: string, entityId?: string) =>
    canonicalResourceKey({ host: base, authGeneration: 0, projectId, resource: 'knowledge', projection, entityId })
  async function load<T>(base: string, read: (client: ReturnType<typeof createKnowledgeClient>) => Promise<T>) {
    let status: number | undefined
    const client = createKnowledgeClient(base, async (url, init) => {
      const response = await request(url, init)
      if (!response.ok) status = response.status
      return response
    })
    try { return await read(client) }
    catch (error) { if (status && error instanceof Error) Object.assign(error, { status }); throw error }
  }
  return {
    catalog(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'catalog-v1'), signal => load(base, client => client.list(signal)))
      void lease.read()
      return lease
    },
    detail(base: string, projectId: string, id: string, revision: string) {
      // Revision keeps a changed catalog entry from borrowing an old detail body.
      const lease = views.acquire(key(base, projectId, `detail-v1:${revision}`, id), signal => load(base, async client => {
        const detail = await client.read(id, signal)
        if (detail.entry.revision !== revision) throw new Error('Knowledge entry revision changed. Refresh the catalog.')
        return detail
      }))
      void lease.read()
      return lease
    },
    dispose: views.dispose,
  }
}
export const useKnowledgeResourceStore = defineStore('resource-knowledge', () => {
  const owner = markRaw(createKnowledgeResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
