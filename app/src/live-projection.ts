import { shallowReactive, shallowReadonly } from 'vue'
import { createResource } from './resources/engine.ts'
import type { ProjectionTopic } from '../../src/realtime/projection-wire.ts'
import type { LiveObserver, LiveSubscription, LiveStatus, LiveResetReason } from './live-client.ts'

export interface ProjectionPool {
  observeHost?(base: string, callback: (status: LiveStatus) => void): () => void
  client(base: string): { subscribe(topic: import('../../src/realtime/protocol.ts').RealtimeTopic, observer: LiveObserver): LiveSubscription }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A private baseline per live owner. Push commits cancel older HTTP generations.
 * HTTP is only the bounded initial/unsupported/error recovery route. */
export function createLiveProjection<T>(pool: ProjectionPool, options: {
  base: string; topic: ProjectionTopic; parse(value: unknown): T
  load(signal: AbortSignal): Promise<T>; key?: 'sessionId' | 'id'; field?: 'sessions' | 'runs'
  fallbackMs?: number; legacy?: boolean; failed?(error: unknown): void; reconcile?(value: T): T; changed?(value: T | undefined): void
}) {
  let revision: string | undefined, wire: unknown, disposed = false
  const lifetime = new AbortController()
  let resolve!: () => void
  const first = new Promise<void>(done => { resolve = done })
  const optionsPoolObservation = !!pool.observeHost
  let initialized = false, live = false, readyFailure = false, revoked = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const resource = createResource(options.load, 0, { initialLoading: true, reconcile: options.reconcile, onError(error) {
    if (record(error) && (error.status === 401 || error.status === 403)) { clearTimeout(timer); timer = undefined }
    options.failed?.(error)
  } })
  const state = shallowReactive({ ...resource.state })
  let notified: T | undefined
  const stop = resource.subscribe(next => { Object.assign(state, next); if (next.value !== notified) { notified = next.value; options.changed?.(next.value) } })
  function fallback() {
    if (disposed || revoked) return
    clearTimeout(timer); timer = undefined
    revision = undefined; wire = undefined
    resource.reset('projection-fallback'); initialized = true; resolve()
    if (!live && optionsPoolObservation) timer = setTimeout(fallback, 30_000)
  }
  function recover() {
    if (disposed || revoked) return
    revision = undefined; wire = undefined
    clearTimeout(timer)
    timer = setTimeout(fallback, options.fallbackMs ?? 10_000)
    if (!subscription.refreshProjection?.() && initialized) {
      clearTimeout(timer); timer = undefined
      resource.invalidate('legacy-invalidation'); resolve()
      if (!live && optionsPoolObservation) timer = setTimeout(fallback, 30_000)
    }
  }
  function apply(payload: unknown) {
    if (disposed) return
    try {
      if (!record(payload) || typeof payload.revision !== 'string' || !payload.revision) throw new Error('Invalid projection revision')
      let next: unknown
      if (payload.event === 'snapshot') next = payload.data
      else if (payload.event === 'delta' && payload.base === revision && record(wire) && options.key && options.field
        && Array.isArray(wire[options.field]) && Array.isArray(payload.upsert) && Array.isArray(payload.removed)) {
        const key = options.key
        const rows = new Map((wire[options.field] as unknown[]).map(row => {
          if (!record(row) || typeof row[key] !== 'string') throw new Error('Invalid projection row')
          return [row[key], row] as const
        }))
        const removed = new Set<string>()
        for (const id of payload.removed) {
          if (typeof id !== 'string' || removed.has(id) || !rows.delete(id)) throw new Error('Invalid removed projection row')
          removed.add(id)
        }
        const seen = new Set<string>()
        for (const row of payload.upsert) {
          if (!record(row) || typeof row[key] !== 'string' || !row[key] || seen.has(row[key]) || removed.has(row[key])) throw new Error('Invalid projection row')
          seen.add(row[key]); rows.set(row[key], row)
        }
        next = { ...wire, [options.field]: [...rows.values()] }
      } else throw new Error('Projection base mismatch')
      const parsed = options.parse(next)
      revoked = false
      wire = next; revision = payload.revision
      clearTimeout(timer); timer = undefined
      resource.replace(parsed)
      initialized = true; resolve()
    } catch {
      if (record(payload) && payload.event === 'snapshot') { readyFailure = true; fallback() }
      else recover()
    }
  }
  function resetProjection(reason?: LiveResetReason) {
    if (reason === 'project-removed') {
      revoked = true
      clearTimeout(timer); timer = undefined
      revision = undefined; wire = undefined
      resource.revoke('Project is unavailable')
      initialized = true; resolve()
    } else {
      if (reason === 'project-restored') revoked = false
      if (revoked) return
      if (reason === undefined && revision === undefined && initialized) resource.reset('projection-reset')
      else recover()
    }
  }
  const subscription = pool.client(options.base).subscribe(options.topic, {
    projectionSnapshot: apply, projectionUnavailable() { readyFailure = true; fallback() }, event: event => apply(event.payload),
    reset: resetProjection, reconnected() { recover() },
  })
  const legacyKind = options.topic.kind === 'io-runs' ? 'io' : options.topic.kind.startsWith('session-') ? 'sessions' : 'resources'
  const legacy = options.legacy === false ? undefined : pool.client(options.base).subscribe({ kind: legacyKind, projectId: options.topic.projectId }, {
    event(event) {
      if (revision !== undefined) return
      const payload = event.payload
      if (legacyKind !== 'resources' || record(payload) && (payload.resource === (options.topic.kind === 'folder-devices' ? 'nodes' : options.topic.kind) || options.topic.kind === 'folder-devices' && payload.resource === 'folders')) recover()
    },
    reset(reason) {
      if (reason === 'project-removed' || reason === 'project-restored') resetProjection(reason)
      else if (initialized && revision === undefined) recover()
    },
    reconnected() { if (revision === undefined) recover() },
  })
  timer = setTimeout(fallback, options.fallbackMs ?? 10_000)
  // Readiness acknowledges a subscription, not a missing data deadline. A
  // negotiated server owns the initial snapshot; explicit unsupported/failure
  // signals and the bounded transport deadline are the HTTP recovery routes.
  void subscription.ready(lifetime.signal).then(() => {
    // Legacy adapters without the projection capability use HTTP on ready.
    if (!disposed && !readyFailure && revision === undefined && !subscription.refreshProjection) {
      if (initialized) resource.invalidate('late-ready')
      else fallback()
    }
  }, () => {
    if (!disposed && !readyFailure && revision === undefined) fallback()
  })
  const unobserve = pool.observeHost?.(options.base, status => {
    live = status.phase === 'live'
    if (!live && initialized && timer === undefined) timer = setTimeout(fallback, options.fallbackMs ?? 10_000)
  })
  // SSE and old servers never receive fixed projection topics. They retain the
  // legacy notification subscription at the domain owner, with HTTP recovery.
  return {
    state: shallowReadonly(state),
    async read() { await first; await resource.read() },
    refresh() { recover(); return first.then(() => resource.read()) },
    invalidate() { recover() }, reset: resetProjection,
    update: resource.update,
    replace(value: T) { resource.replace(value) },
    get hasSnapshot() { return revision !== undefined },
    dispose() { disposed = true; lifetime.abort(); clearTimeout(timer); unobserve?.(); subscription.close(); legacy?.close(); resource.dispose(); stop(); resolve() },
  }
}
