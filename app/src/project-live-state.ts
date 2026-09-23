import { shallowReactive, shallowReadonly } from 'vue'
import { hostBase, projectBase } from './api-url.ts'
import { isRecord, parseSessionGraph } from './folders-sidebar.ts'
import { createProjectsClient, projectJson } from './projects.ts'
import { parseActiveRequestIds, parseSessionRecoveries, parseSessionStages } from './session-activity.ts'
import type { LiveClient, LiveObserver } from './live-client.ts'

/** A snapshot has one serialized reader, regardless of how many views use it. */
function createSnapshot<T>(load: (signal: AbortSignal) => Promise<T>, delayMs: number) {
  const state = shallowReactive({ value: undefined as T | undefined, loading: false, error: '', revision: 0, readRevision: 0 })
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
        state.error = cause instanceof Error ? cause.message : 'Live state is unavailable. Retry.'
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
    const snapshot = createSnapshot(signal => createProjectsClient(base, request).list(signal), delay)
    const subscription = pool.client(base).subscribe({ kind: 'projects' }, {
      event: () => snapshot.invalidate(), reset: () => snapshot.reset(),
      reconnected: () => snapshot.reset(),
    })
    void snapshot.read()
    return { snapshot, users: 0, dispose() { subscription.close(); snapshot.dispose() } }
  }
  function createProject(base: string, projectId: string) {
    const scope = projectBase(base, projectId)
    const graph = createSnapshot(async signal =>
      parseSessionGraph(await projectJson(scope, '/api/sessions/graph', { signal }, request), projectId), delay)
    const activity = createSnapshot(async signal => {
      const value = await projectJson(scope, '/api/sessions/stages', { signal }, request)
      return {
        stages: parseSessionStages(value),
        activeRequestIds: parseActiveRequestIds(value),
        recoveries: parseSessionRecoveries(value),
      }
    }, delay)
    const observers = new Set<Partial<LiveObserver>>()
    function reset(reason: Parameters<LiveObserver['reset']>[0]) {
      for (const observer of observers) observer.reset?.(reason)
      graph.reset()
      activity.reset()
    }
    const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId }, {
      event: event => {
        for (const observer of observers) observer.event?.(event)
        if (!isRecord(event.payload) || event.payload.event !== 'activity') graph.invalidate()
        activity.invalidate()
      },
      reset,
      reconnected: () => reset('reconnect'),
    })
    void graph.read()
    void activity.read()
    return { graph, activity, observers, users: 0,
      dispose() { subscription.close(); graph.dispose(); activity.dispose(); observers.clear() },
    }
  }
  return {
    acquireCatalog(base: string) {
      if (disposed) throw new Error('Project live state has been disposed.')
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
    acquireProject(base: string, projectId: string, observer?: Partial<LiveObserver>) {
      if (disposed) throw new Error('Project live state has been disposed.')
      const host = hostBase(base)
      const key = JSON.stringify([host, projectId])
      let entry = projects.get(key)
      if (!entry) { entry = createProject(host, projectId); projects.set(key, entry) }
      const current = entry
      current.users++
      if (observer) current.observers.add(observer)
      let released = false
      return {
        graph: current.graph, activity: current.activity,
        refresh: () => released ? Promise.resolve() : Promise.all([current.graph.refresh(), current.activity.refresh()]).then(() => {}),
        release() {
          if (released) return
          released = true
          if (observer) current.observers.delete(observer)
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
