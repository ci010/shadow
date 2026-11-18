import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { listAgentDefinitions, listBotDocuments, readBotDocument, readBotRuntime } from '../knowledge-definitions.ts'
import { createKnowledgeClient } from '../knowledge.ts'

/** No knowledge live topic exists. Explicit refresh and activation revalidate;
 * neither an idle timer nor a hidden detail prefetch is introduced. */
export function createKnowledgeResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  // Immutable revision-scoped details remain reusable when another page is
  // selected. Retention uses the registry's TTL/UTF-8 budget, not a second cache.
  const details = resourceViews(16)
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
    agents(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'agent-definitions'), signal => listAgentDefinitions(base, signal, request))
      void lease.read()
      return lease
    },
    bots(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'bot-markdown'), signal => listBotDocuments(base, projectId, signal, request))
      void lease.read()
      return lease
    },
    botDocument(base: string, projectId: string, bot: string, path: string, revision: string) {
      const lease = details.acquire(key(base, projectId, `bot-markdown:${revision}`, JSON.stringify([bot, path])), signal => readBotDocument(base, bot, path, revision, signal, request))
      void lease.read()
      return lease
    },
    botRuntime(base: string, projectId: string, bot: string, revision: string, scope?: string) {
      const lease = views.acquire(key(base, projectId, 'bot-runtime', JSON.stringify([bot, revision, scope])),
        signal => readBotRuntime(base, projectId, bot, revision, scope, signal, request))
      void lease.read()
      return lease
    },
    catalog(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'catalog-v1'), signal => load(base, client => client.list(signal)))
      void lease.read()
      return { ...lease, removeEntry(id: string) {
        // A confirmed delete must remain visible even if reconciliation fails.
        // Preserve incoming edges so references to the deleted target remain explicit.
        lease.commit(catalog => ({ entries: catalog.entries.filter(entry => entry.id !== id),
          links: catalog.links.filter(link => link.source !== id) }))
      } }
    },
    detail(base: string, projectId: string, id: string, revision: string) {
      // Revision keeps a changed catalog entry from borrowing an old detail body.
      const lease = details.acquire(key(base, projectId, `detail-v1:${revision}`, id), signal => load(base, async client => {
        const detail = await client.read(id, signal)
        if (detail.entry.revision !== revision) throw new Error('Knowledge entry revision changed. Refresh the catalog.')
        return detail
      }))
      void (lease.state.value.error ? lease.refresh() : lease.read())
      return lease
    },
    dispose() { views.dispose(); details.dispose() },
  }
}
export const useKnowledgeResourceStore = defineStore('resource-knowledge', () => {
  const owner = markRaw(createKnowledgeResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
