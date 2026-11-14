import { defineStore } from 'pinia'
import { markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { createBotSettingsClient } from '../bot-settings.ts'
import { createProjectsClient } from '../projects.ts'
import { apiUrl } from '../api-url.ts'
import { parseServiceGroups, type ServiceGroupSource } from '../service-group-contract.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from '../live-resource-refresh.ts'

/** Only public BOT projections enter this owner. Credentials and admin drafts do not. */
export function createBotResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  const key = (base: string, projectId: string, projection: string, query?: unknown) => canonicalResourceKey({
    host: base, authGeneration: 0, projectId, resource: 'bots', projection, query,
  })
  function live<T>(base: string, projectId: string, projection: string, pool: ResourceLivePool,
    resource: 'channels' | 'service-groups', load: (signal: AbortSignal) => Promise<T>, query?: unknown) {
    let retry: ReturnType<typeof setTimeout> | undefined
    let retryMs = 3_000, closed = false, invalidate = () => {}
    return views.acquire(key(base, projectId, projection, query), async signal => {
      clearTimeout(retry)
      try { const result = await load(signal); retryMs = 3_000; return result }
      catch (error) {
        const status = (error as { status?: number })?.status
        if (!closed && !signal.aborted && status !== 401 && status !== 403) {
          retry = setTimeout(() => { if (!closed) invalidate() }, retryMs)
          retryMs = Math.min(30_000, retryMs * 2)
        }
        throw error
      }
    }, {}, refresh => {
      invalidate = refresh
      const subscription = createLiveResourceRefresh(pool, { base, projectId, resource, refresh })
      return () => { closed = true; clearTimeout(retry); subscription.dispose() }
    })
  }
  return {
    catalog(base: string, projectId: string, pool: ResourceLivePool) {
      // Project only safe catalog fields; editable config/secret flags are discarded by the parser.
      const client = createBotSettingsClient(base, projectId, async (url, init) => {
        const response = await request(url, init)
        if (!response.ok) throw Object.assign(new Error('BOT catalog unavailable'), { status: response.status })
        return response
      })
      return live(base, projectId, 'catalog-v1', pool, 'channels', signal => client.catalog(signal))
    },
    groups(options: ServiceGroupSource, pool: ResourceLivePool) {
      const { apiBase: base, projectId, group, session } = options
      return live(base, projectId, 'observed-groups-v1', pool, 'service-groups', async signal => {
        const url = apiUrl(base, '/api/service-groups')
        if (group) url.searchParams.set('group', group)
        if (session) url.searchParams.set('session', session)
        const response = await request(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) throw Object.assign(new Error('Observed groups unavailable'), { status: response.status })
        return parseServiceGroups(await response.json())
      }, { group, session })
    },
    status(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'runtime-status-v1'), signal => createProjectsClient(base, request).status(projectId, signal))
      void lease.read()
      return lease
    },
    dispose: views.dispose,
  }
}
export const useBotResourceStore = defineStore('resource-bots', () => {
  const owner = markRaw(createBotResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
