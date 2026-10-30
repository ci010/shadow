import { createInitialLiveSnapshot } from './initial-live-snapshot.ts'
import { t } from './i18n.ts'
import { shallowReactive, shallowReadonly } from 'vue'
import { hostBase, projectBase } from './api-url.ts'
import { isRecord, parseSessionGraph } from './folders-sidebar.ts'
import { createProjectsClient, projectJson } from './projects.ts'
import { parseActiveRequestIds, parseSessionRecoveries, parseSessionStages } from './session-activity.ts'
import type { LiveClient, LiveObserver } from './live-client.ts'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'

/** A snapshot has one serialized reader, regardless of how many views use it.
 * initialLoading represents an external readiness gate; its owner must invalidate
 * when ready (or dispose to settle readers), without starting HTTP early. */
export function createSnapshot<T>(load: (signal: AbortSignal) => Promise<T>, delayMs: number, options: { initialLoading?: boolean } = {}) {
  const state = shallowReactive({ value: undefined as T | undefined, loading: options.initialLoading ?? false, error: '', revision: 0, readRevision: 0 })
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  let closed = false
  const waiters = new Set<() => void>()
  function settle() { for (const resolve of waiters) resolve(); waiters.clear() }
  function schedule() {
    if (closed || controller || timer !== undefined || !pending) return
    timer = setTimeout(() => { void run() }, delayMs)
  }
  async function run() {
    timer = undefined
    if (closed || !pending) return
    pending = false
    const current = controller = new AbortController()
    state.readRevision++
    try {
      const value = await load(current.signal)
      if (closed || current.signal.aborted || controller !== current) return
      state.value = value
      state.error = ''
      state.revision++
    } catch (cause) {
      if (!closed && !current.signal.aborted && controller === current) {
        state.error = cause instanceof Error ? cause.message : t('Live state is unavailable. Retry.')
      }
    } finally {
      if (controller === current) {
        controller = undefined
        if (pending) schedule()
        else { state.loading = false; settle() }
      }
    }
  }
  function invalidate() {
    if (closed) return
    pending = true
    state.loading = true
    schedule()
  }
  function read(): Promise<void> {
    if (closed) return Promise.resolve()
    if (state.value === undefined && !state.error && !state.loading) invalidate()
    if (!state.loading) return Promise.resolve()
    return new Promise(resolve => waiters.add(resolve))
  }
  return {
    state: shallowReadonly(state), read, invalidate,
    refresh() { invalidate(); return read() },
    reset() {
      controller?.abort()
      controller = undefined
      invalidate()
    },
    pause() {
      clearTimeout(timer)
      timer = undefined
      controller?.abort()
      controller = undefined
      pending = false
      state.loading = false
      settle()
    },
    dispose() {
      closed = true
      clearTimeout(timer)
      controller?.abort()
      controller = undefined
      state.loading = false
      settle()
    },
  }
}

export function createProjectLiveState(
  pool: { client: (base: string) => Pick<LiveClient, 'subscribe'> },
  options: { request?: typeof fetch; delayMs?: number } = {},
) {
  const request = options.request ?? fetch
  const delay = options.delayMs ?? 50
  const catalogs = new Map<string, ReturnType<typeof createCatalog>>()
  const projects = new Map<string, ReturnType<typeof createProject>>()
  let disposed = false

  function createCatalog(base: string) {
    const snapshot = createSnapshot(signal => createProjectsClient(base, request).list(signal), delay, { initialLoading: true })
    const gate = createInitialLiveSnapshot({ refresh: () => snapshot.invalidate() })
    const subscription = pool.client(base).subscribe({ kind: 'projects' }, {
      event: () => gate.invalidate(), reset: gate.reset, reconnected: gate.reconnected,
    })
    gate.attach(subscription)
    return { snapshot: { ...snapshot, read: async () => { await gate.getPromise(); await snapshot.read() } }, users: 0, dispose() { gate.dispose(); subscription.close(); snapshot.dispose() } }
  }
  function createProject(base: string, projectId: string) {
    const scope = projectBase(base, projectId)
    const graph = createSnapshot(async signal =>
      parseSessionGraph(await projectJson(scope, '/api/sessions/graph', { signal }, request), projectId), delay, { initialLoading: true })
    const activity = createSnapshot(async signal => {
      const value = await projectJson(scope, '/api/sessions/stages', { signal }, request)
      return {
        stages: parseSessionStages(value),
        activeRequestIds: parseActiveRequestIds(value),
        recoveries: parseSessionRecoveries(value),
      }
    }, delay, { initialLoading: true })
    const work = createSnapshot(async signal =>
      projectWorkOverviewSchema.parse(await projectJson(scope, '/api/work', { signal }, request)), delay)
    const usage = { work: 0 }
    const observers = new Set<Partial<LiveObserver>>()
    function reset(reason: Parameters<LiveObserver['reset']>[0]) {
      for (const observer of observers) observer.reset?.(reason)
      gate.reset()
    }
    let started = false
    const gate = createInitialLiveSnapshot({ refresh() {
      started = true
      graph.reset(); activity.reset()
      if (usage.work) work.reset()
    } })
    const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId }, {
      event: event => {
        for (const observer of observers) observer.event?.(event)
        // Events before readiness are covered by the initial snapshot.
        if (!started) return
        if (!isRecord(event.payload) || event.payload.event !== 'activity') graph.invalidate()
        activity.invalidate()
        if (usage.work) work.invalidate()
      },
      reset,
      reconnected: () => reset('reconnect'),
    })
    gate.attach(subscription)
    const gated = <T>(snapshot: ReturnType<typeof createSnapshot<T>>) => ({ ...snapshot,
      async read() { await gate.getPromise(); await snapshot.read() },
    })
    return { graph: gated(graph), activity: gated(activity), ready: gate.getPromise, work, usage, observers, users: 0,
      dispose() { gate.dispose(); subscription.close(); graph.dispose(); activity.dispose(); work.dispose(); observers.clear() },
    }
  }
  return {
    acquireCatalog(base: string) {
      if (disposed) throw new Error(t('Project live state has been disposed.'))
      const key = hostBase(base)
      let entry = catalogs.get(key)
      if (!entry) { entry = createCatalog(key); catalogs.set(key, entry) }
      const current = entry
      current.users++
      let released = false
      return {
        state: current.snapshot.state,
        read: () => current.snapshot.read(),
        refresh: () => released ? Promise.resolve() : current.snapshot.refresh(),
        release() {
          if (released) return
          released = true
          if (--current.users === 0) { current.dispose(); catalogs.delete(key) }
        },
      }
    },
    acquireProject(base: string, projectId: string, observer?: Partial<LiveObserver>, includeWork = false) {
      if (disposed) throw new Error(t('Project live state has been disposed.'))
      const host = hostBase(base)
      const key = JSON.stringify([host, projectId])
      let entry = projects.get(key)
      if (!entry) { entry = createProject(host, projectId); projects.set(key, entry) }
      const current = entry
      current.users++
      if (includeWork && current.usage.work++ === 0) void current.ready().then(() => { if (current.usage.work) void current.work.refresh() })
      if (observer) current.observers.add(observer)
      let released = false
      return {
        graph: current.graph, activity: current.activity, work: current.work,
        read: () => Promise.all([current.graph.read(), current.activity.read()]).then(() => {}),
        refresh: () => released ? Promise.resolve() : Promise.all([
          current.graph.refresh(), current.activity.refresh(), ...(includeWork ? [current.work.refresh()] : []),
        ]).then(() => {}),
        release() {
          if (released) return
          released = true
          if (observer) current.observers.delete(observer)
          if (includeWork && --current.usage.work === 0) current.work.pause()
          if (--current.users === 0) { current.dispose(); projects.delete(key) }
        },
      }
    },
    dispose() {
      disposed = true
      for (const entry of catalogs.values()) entry.dispose()
      for (const entry of projects.values()) entry.dispose()
      catalogs.clear()
      projects.clear()
    },
  }
}

export type ProjectLiveState = ReturnType<typeof createProjectLiveState>
export type ProjectLiveLease = ReturnType<ProjectLiveState['acquireProject']>
