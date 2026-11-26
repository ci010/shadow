import { defineStore } from 'pinia'
import { computed, markRaw, onScopeDispose } from 'vue'
import { canonicalResourceKey } from '../resources/engine.ts'
import { resourceViews } from '../resources/vue-resource.ts'
import { parseProjects } from '../projects.ts'
import { apiUrl } from '../api-url.ts'
import { createLiveProjection, type ProjectionPool } from '../live-projection.ts'
import type { ProjectionTopic } from '../../../src/realtime/projection-wire.ts'
import { createFoldersClient, parseFolder } from '../folders-client.ts'
import { fetchNodeInventory, parseNodeInventory } from '../node-inventory.ts'
import { fetchAutomations } from '../automations.ts'
import { createLiveResourceRefresh, type ResourceLivePool } from '../live-resource-refresh.ts'
import { liveProjectId } from '../composables/useLiveClient.ts'
import { workCompletionsSchema } from '../../../src/initiatives/work-contract.ts'
import { projectUsageSchema, projectUsagePageSchema } from '../../../src/projects/usage-contract.ts'

/** App-owned read projections. Commands are never cached or replayed. */
export function createCatalogResources(request: typeof fetch = fetch) {
  const views = resourceViews()
  // Keep the last successful usage snapshot across tab releases, within registry TTL and memory limits.
  const usageViews = resourceViews(12)
  const key = (base: string, projectId: string, resource: string, query?: unknown) => canonicalResourceKey({ host: apiUrl(base, '/').toString(),
    authGeneration: 0, projectId, resource, projection: 'v1', query })
  async function json(base: string, path: string, signal: AbortSignal) {
    const response = await request(apiUrl(base, path), { signal, cache: 'no-store' })
    if (!response.ok) throw Object.assign(new Error('Resource request failed'), { status: response.status })
    return response.json()
  }
  async function usageSummary(base: string, projectId: string, signal: AbortSignal) {
    const result = projectUsageSchema.parse(await json(base, '/api/project/usage', signal))
    if (result.projectId !== projectId) throw new Error('Project mismatch')
    return result
  }
  const projected = new Map<string, { users: number; owner: ReturnType<typeof createLiveProjection<unknown>> }>()
  function acquireProjection<T>(base: string, projectId: string, pool: ProjectionPool, topic: ProjectionTopic,
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
    return { state: computed(() => owner.state), read: owner.read, refresh: owner.refresh, invalidate: owner.invalidate,
      commit(transform: (value: T) => T) { return !released && owner.update(transform) },
      release() { if (released) return; released = true; if (--current.users === 0) { owner.dispose(); projected.delete(id) } },
    }
  }
  return {
    folders(base: string, projectId: string, pool: ProjectionPool) {
      return acquireProjection(base, projectId, pool, { kind: 'folders', projectId }, value => {
        if (!value || typeof value !== 'object' || !('folders' in value) || !Array.isArray(value.folders)) throw new Error('Invalid folders snapshot')
        const folders = value.folders.map(parseFolder)
        if (new Set(folders.map(row => row.id)).size !== folders.length) throw new Error('Duplicate folders')
        return folders
      }, signal => createFoldersClient(base, request).list(signal))
    },
    pickerDevices(base: string, projectId: string, pool: ProjectionPool) {
      return acquireProjection(base, projectId, pool, { kind: 'folder-devices', projectId }, value => {
        if (!value || typeof value !== 'object' || !('devices' in value) || !Array.isArray(value.devices) || value.devices.some(d =>
          !d || typeof d !== 'object' || typeof d.nodeId !== 'string' || !d.nodeId || typeof d.name !== 'string' ||
          !['main', 'child'].includes(d.role) || typeof d.online !== 'boolean' || typeof d.supported !== 'boolean')) throw new Error('Invalid folder devices')
        return value.devices as Awaited<ReturnType<ReturnType<typeof createFoldersClient>['pickerDevices']>>
      }, signal => createFoldersClient(base, request).pickerDevices(signal))
    },
    nodes(base: string, projectId: string, pool: ProjectionPool) {
      return acquireProjection(base, projectId, pool, { kind: 'nodes', projectId }, parseNodeInventory, signal => fetchNodeInventory(base, 'main',
        AbortSignal.any([signal, AbortSignal.timeout(5_000)]), request))
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
      const lease = usageViews.acquire(key(base, projectId, 'usage-summary'), signal => usageSummary(base, projectId, signal))
      if (!lease.state.value.loading) void lease.refresh()
      return lease
    },
    globalUsage(base: string) {
      const lease = usageViews.acquire(key(base, '', 'global-usage'), async signal => {
        const payload = await json(base, '/api/usage', AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
        return {
          aggregate: payload.aggregate === null ? undefined : projectUsageSchema.parse(payload.aggregate),
          rows: (payload.rows as Array<{ project: unknown; usage: unknown }>).flatMap(row => {
            const project = parseProjects({ projects: [row.project] })[0]
            if (!project) return []
            const usage = row.usage === null ? undefined : projectUsageSchema.parse(row.usage)
            if (usage && usage.projectId !== project.id) throw new Error('Project mismatch')
            return [{ project, usage }]
          }),
        }
      })
      if (!lease.state.value.loading) void lease.refresh()
      return lease
    },
    usagePage(base: string, projectId: string, page: number) {
      const lease = usageViews.acquire(key(base, projectId, 'usage-daily', { page }), async signal => {
        const result = projectUsagePageSchema.parse(await json(base, `/api/project/usage/daily?page=${page}`, signal))
        if (result.projectId !== projectId || result.page !== page) throw new Error('Usage page mismatch')
        return result
      })
      if (!lease.state.value.loading) void lease.refresh()
      return lease
    },
    dispose() { for (const entry of projected.values()) entry.owner.dispose(); projected.clear(); views.dispose(); usageViews.dispose() },
  }
}
export const useCatalogResourceStore = defineStore('resource-catalog', () => {
  const owner = markRaw(createCatalogResources())
  onScopeDispose(owner.dispose)
  return { owner }
})
