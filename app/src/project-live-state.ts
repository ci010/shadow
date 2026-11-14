import { createSnapshotReader } from './snapshot-reader.ts'
import { unkeyedWork } from '../../src/shared/snapshot-wire.ts'
import { affectsSessionResource, affectsSessionSummary } from './session-invalidation.ts'
import { createSessionSummaryLoader } from './session-summary-snapshot.ts'
import { createInitialLiveSnapshot } from './initial-live-snapshot.ts'
import { t } from './i18n.ts'
import { shallowReactive, shallowReadonly } from 'vue'
import { hostBase, projectBase } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'
import { createConditionalProjectJson, createProjectsClient, projectJson } from './projects.ts'
import { parseSessionActivity, recoveredSessionStage } from './session-activity.ts'
import type { LiveClient, LiveObserver } from './live-client.ts'
import { projectWorkLiveOverviewSchema } from '../../src/projects/work-overview.ts'
import { parseSessionActivityReadModel, type SessionActivityReadModel } from '../../src/sessions/activity-read-model.ts'

/** A snapshot has one serialized reader, regardless of how many views use it.
 * initialLoading represents an external readiness gate; its owner must invalidate
 * when ready (or dispose to settle readers), without starting HTTP early. */
export function createSnapshot<T>(load: (signal: AbortSignal) => Promise<T>, delayMs: number, options: { initialLoading?: boolean; reconcile?: (value: T) => T } = {}) {
  const state = shallowReactive({ value: undefined as T | undefined, loading: options.initialLoading ?? false, error: '', revision: 0, readRevision: 0, refreshReason: 'initial', readReason: 'initial' })
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
    state.readReason = state.refreshReason
    try {
      const value = await load(current.signal)
      if (closed || current.signal.aborted || controller !== current) return
      state.value = options.reconcile ? options.reconcile(value) : value
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
  function invalidate(reason = 'invalidation') {
    if (closed) return
    state.refreshReason = reason
    pending = true
    state.loading = true
    schedule()
  }
  function read(): Promise<void> {
    if (closed) return Promise.resolve()
    if (state.value === undefined && !state.error && !state.loading) invalidate('initial-read')
    if (!state.loading) return Promise.resolve()
    return new Promise(resolve => waiters.add(resolve))
  }
  return {
    state: shallowReadonly(state), read, invalidate,
    update(transform: (value: T) => T) {
      if (closed || state.value === undefined) return false
      state.value = transform(state.value)
      state.revision++
      return true
    },
    refresh() { invalidate('manual'); return read() },
    reset(reason = 'recovery') {
      controller?.abort()
      controller = undefined
      invalidate(reason)
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
  function createProject(base: string, projectId: string, summaryScope: 'full' | 'navigation') {
    const scope = projectBase(base, projectId)
    const summaryLoader = createSessionSummaryLoader(scope, projectId, request, summaryScope)
    type Activity = ReturnType<typeof parseSessionActivity>
    const unknownActivity = new Set<string>()
    let directory: Set<string> | undefined
    let latestActivity: Activity | undefined
    function projectActivity(value: Activity): Activity {
      const next: Activity = { stages: {}, activeRequestIds: {}, recoveries: {} }
      for (const id of directory ?? []) {
        Object.defineProperty(next.stages, id, { value: Object.hasOwn(value.stages, id) ? value.stages[id] : 'inactive', enumerable: true })
        if (Object.hasOwn(value.activeRequestIds, id)) Object.defineProperty(next.activeRequestIds, id, { value: value.activeRequestIds[id], enumerable: true })
        if (Object.hasOwn(value.recoveries, id)) Object.defineProperty(next.recoveries, id, { value: value.recoveries[id], enumerable: true })
      }
      return next
    }
    const sessions = createSnapshot(signal => summaryLoader.load(signal), delay, { initialLoading: true, reconcile(value) {
      directory = new Set(value.map(session => session.sessionId))
      if ([...unknownActivity].some(id => !directory!.has(id))) sessions.invalidate()
      unknownActivity.clear()
      if (latestActivity) activity.update(() => projectActivity(latestActivity!))
      return value
    } })
    // Each read owns its overlay. Events arriving after HTTP started must win,
    // even if the response was captured before a fast tool finished.
    let overlay = new Map<string, SessionActivityReadModel>()
    function applyActivity(value: Activity, id: string, model: SessionActivityReadModel): Activity {
      const next = { stages: { ...value.stages, [id]: model.waitingForCall ? 'waiting-for-call' as const : recoveredSessionStage(model.stage, model.recovery) },
        activeRequestIds: { ...value.activeRequestIds }, recoveries: { ...value.recoveries } }
      delete next.activeRequestIds[id]
      delete next.recoveries[id]
      if (model.activeRequestId !== null) Object.defineProperty(next.activeRequestIds, id, { value: model.activeRequestId, enumerable: true })
      if (model.recovery !== null) Object.defineProperty(next.recoveries, id, { value: model.recovery, enumerable: true })
      return next
    }
    const activityReader = createConditionalProjectJson<Activity>(scope, '/api/sessions/stages', parseSessionActivity, request)
    const activity = createSnapshot<Activity>(async signal => {
      overlay = new Map()
      return activityReader.load(signal)
    }, delay, { initialLoading: true, reconcile(result: Activity) {
      for (const [id, model] of overlay) result = applyActivity(result, id, model)
      overlay.clear()
      latestActivity = result
      const ids = Object.keys(result.stages)
      if (!directory && sessions.state.loading) for (const id of ids) unknownActivity.add(id)
      else if (ids.some(id => !directory?.has(id))) sessions.invalidate()
      return projectActivity(result)
    } })
    const workReader = createSnapshotReader(
      (version, signal) => projectJson(scope, '/api/work?transport=snapshot-v1' + (version ? '&since=' + encodeURIComponent(version) : ''), { signal }, request),
      value => projectWorkLiveOverviewSchema.parse(value), unkeyedWork)
    const work = createSnapshot(signal => workReader.load(signal), delay)
    const usage = { work: 0 }
    const observers = new Set<Partial<LiveObserver>>()
    function reset(reason: Parameters<LiveObserver['reset']>[0]) {
      for (const observer of observers) observer.reset?.(reason)
      gate.reset()
    }
    let started = false
    const gate = createInitialLiveSnapshot({ refresh() {
      started = true
      sessions.reset(); activity.reset()
      if (usage.work) work.reset()
    } })
    const subscription = pool.client(base).subscribe({ kind: 'sessions', projectId }, {
      event: event => {
        for (const observer of observers) observer.event?.(event)
        // Events before readiness are covered by the initial snapshot.
        if (!started) return
        if (affectsSessionSummary(event.payload)) {
          sessions.invalidate()
        }
        const payload = event.payload
        const model = isRecord(payload) && payload.event === 'activity'
          && typeof payload.sessionId === 'string' && payload.sessionId.length > 0
          ? parseSessionActivityReadModel(payload.activity) : undefined
        if (model && isRecord(payload) && typeof payload.sessionId === 'string') {
          const id = payload.sessionId
          if (activity.state.loading) overlay.set(id, model)
          if (latestActivity) {
            latestActivity = applyActivity(latestActivity, id, model)
            activity.update(() => projectActivity(latestActivity!))
          } else if (!activity.state.loading) activity.invalidate()
          // Activity is not an existence directory. Recover unknown IDs through
          // summary, retaining the event until that independently arriving read.
          if (!directory && sessions.state.loading) unknownActivity.add(id)
          else if (!directory?.has(id)) sessions.invalidate()
        } else if (!isRecord(payload) || payload.event !== 'invalidate'
          || affectsSessionResource(payload, undefined, 'activity')) activity.invalidate()
        if (usage.work && (isRecord(event.payload) && event.payload.event === 'activity'
          || affectsSessionResource(event.payload, undefined, 'work')
          || affectsSessionResource(event.payload, undefined, 'activity'))) work.invalidate()
      },
      reset,
      reconnected: () => reset('reconnect'),
    })
    gate.attach(subscription)
    const gated = <T>(snapshot: ReturnType<typeof createSnapshot<T>>) => ({ ...snapshot,
      async read() { await gate.getPromise(); await snapshot.read() },
    })
    return { sessions: gated(sessions), activity: gated(activity), ready: gate.getPromise, work, usage, observers, users: 0,
      dispose() { gate.dispose(); subscription.close(); sessions.dispose(); activity.dispose(); work.dispose(); observers.clear() },
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
    acquireProject(base: string, projectId: string, observer?: Partial<LiveObserver>, includeWork = false, summaryScope: 'full' | 'navigation' = 'navigation') {
      if (disposed) throw new Error(t('Project live state has been disposed.'))
      const host = hostBase(base)
      const key = JSON.stringify([host, projectId, summaryScope])
      let entry = projects.get(key)
      if (!entry) { entry = createProject(host, projectId, summaryScope); projects.set(key, entry) }
      const current = entry
      current.users++
      if (includeWork && current.usage.work++ === 0) void current.ready().then(() => { if (current.usage.work) void current.work.refresh() })
      if (observer) current.observers.add(observer)
      let released = false
      return {
        sessions: current.sessions, activity: current.activity, work: current.work,
        read: () => Promise.all([current.sessions.read(), current.activity.read()]).then(() => {}),
        refresh: () => released ? Promise.resolve() : Promise.all([
          current.sessions.refresh(), current.activity.refresh(), ...(includeWork ? [current.work.refresh()] : []),
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
