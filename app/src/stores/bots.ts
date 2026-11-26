import { defineStore } from 'pinia'
import { computed, markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { createBotSettingsClient, parseBotCatalog } from '../bot-settings.ts'
import { createLiveProjection, type ProjectionPool } from '../live-projection.ts'
import type { ProjectionTopic } from '../../../src/realtime/projection-wire.ts'
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
  const projected = new Map<string, { users: number; owner: ReturnType<typeof createLiveProjection<unknown>> }>()
  function projection<T>(base: string, projectId: string, pool: ProjectionPool, topic: ProjectionTopic,
    parse: (value: unknown) => T, load: (signal: AbortSignal) => Promise<T>) {
    const id = key(base, projectId, topic.kind)
    let entry = projected.get(id)
    if (!entry) {
      entry = { users: 0, owner: createLiveProjection(pool, { base, topic, parse, load }) as ReturnType<typeof createLiveProjection<unknown>> }
      projected.set(id, entry)
    }
    const current = entry
    current.users++
    const owner = current.owner as ReturnType<typeof createLiveProjection<T>>
    let released = false
    // Lease consumers watch the ref, so track fields and publish a new state identity.
    return { state: computed(() => ({ ...owner.state })), read: owner.read, refresh: owner.refresh, invalidate: owner.invalidate,
      release() { if (released) return; released = true; if (--current.users === 0) { owner.dispose(); projected.delete(id) } } }
  }
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
    catalog(base: string, projectId: string, pool: ProjectionPool) {
      // Project only safe catalog fields; editable config/secret flags are discarded by the parser.
      const client = createBotSettingsClient(base, projectId, async (url, init) => {
        const response = await request(url, init)
        if (!response.ok) throw Object.assign(new Error('BOT catalog unavailable'), { status: response.status })
        return response
      })
      return projection(base, projectId, pool, { kind: 'channels', projectId }, value => parseBotCatalog(value, projectId), signal => client.catalog(signal))
    },
    groups(options: ServiceGroupSource, pool: ProjectionPool & ResourceLivePool) {
      const { apiBase: base, projectId, group, session } = options
      const load = async (signal: AbortSignal) => {
        const url = apiUrl(base, '/api/service-groups')
        if (group) url.searchParams.set('group', group)
        if (session) url.searchParams.set('session', session)
        const response = await request(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) throw Object.assign(new Error('Observed groups unavailable'), { status: response.status })
        return parseServiceGroups(await response.json())
      }
      // Selected observation bodies are explicit HTTP detail reads, not catalog push.
      return group || session
        ? live(base, projectId, 'observed-groups-v1', pool, 'service-groups', load, { group, session })
        : projection(base, projectId, pool, { kind: 'service-groups', projectId }, parseServiceGroups, load)
    },
    status(base: string, projectId: string) {
      const lease = views.acquire(key(base, projectId, 'runtime-status-v1'), signal => createProjectsClient(base, request).status(projectId, signal))
      void lease.read()
      return lease
    },
    dispose() { for (const entry of projected.values()) entry.owner.dispose(); projected.clear(); views.dispose() },
  }
}
export const useBotResourceStore = defineStore('resource-bots', () => {
  const owner = markRaw(createBotResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
