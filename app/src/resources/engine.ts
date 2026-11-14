/** Framework-independent, single-flight resource ownership. Values must be treated as readonly. */
export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error' | 'forbidden' | 'disposed'
export interface ResourceState<T> {
  readonly value: T | undefined
  readonly loading: boolean
  readonly error: string
  readonly status: ResourceStatus
  readonly revision: number
  /** Wire version, distinct from local commit revision; supplied by the validated adapter. */
  readonly version: string | undefined
  readonly readRevision: number
  readonly generation: number
  readonly refreshReason: string
  readonly readReason: string
}
export interface ResourceOptions<T> {
  initialLoading?: boolean
  version?: (value: T) => string | undefined
  reconcile?: (value: T) => T
  /** Throw (or return false) to reject the entire candidate before publication. */
  validate?: (value: T) => void | boolean
  /** Called before the one permitted validation/base recovery read. Clear adapter base here. */
  recover?: () => void
  timeoutMs?: number
  /** Domain callback adapters may project an error; failures here cannot break cleanup. */
  onError?: (error: unknown) => void
}
export class ResetRequired extends Error {}
export class ResourceValidationError extends Error {}

export function createResource<T>(load: (signal: AbortSignal) => Promise<T>, delayMs = 0, options: ResourceOptions<T> = {}) {
  let state: ResourceState<T> = Object.freeze({ value: undefined, loading: options.initialLoading ?? false,
    error: '', status: options.initialLoading ? 'loading' : 'idle', revision: 0, version: undefined, readRevision: 0,
    generation: 0, refreshReason: 'initial', readReason: 'initial' })
  const listeners = new Set<(state: ResourceState<T>) => void>()
  const waiters = new Set<() => void>()
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false, closed = false, recovered = false
  function publish(patch: Partial<ResourceState<T>>) {
    state = Object.freeze({ ...state, ...patch })
    // Observers cannot turn a successful commit into a failed read.
    for (const listener of [...listeners]) { try { listener(state) } catch { /* observer isolation */ } }
  }
  function settle() { for (const resolve of waiters) resolve(); waiters.clear() }
  function schedule() {
    if (!closed && !controller && timer === undefined && pending) timer = setTimeout(() => { void run() }, Math.max(0, delayMs))
  }
  function candidate(value: T): T {
    const next = options.reconcile ? options.reconcile(value) : value
    if (options.validate?.(next) === false) throw new ResourceValidationError('Invalid resource candidate')
    return next
  }
  async function run() {
    timer = undefined
    if (closed || !pending) return
    pending = false
    const generation = state.generation
    const current = controller = new AbortController()
    const valid = () => !closed && !current.signal.aborted && controller === current && state.generation === generation
    publish({ readRevision: state.readRevision + 1, readReason: state.refreshReason })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const work = load(current.signal)
      const value = options.timeoutMs === undefined ? await work : await Promise.race([work, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Resource read timed out')), options.timeoutMs)
      })])
      if (!valid()) return
      let next: T
      try { next = candidate(value) } catch (error) {
        if (error instanceof ResetRequired || error instanceof ResourceValidationError) throw error
        throw new ResourceValidationError(error instanceof Error ? error.message : 'Invalid resource candidate')
      }
      if (!valid()) return
      const version = options.version?.(next)
      if (!valid()) return
      publish({ value: next, version, error: '', status: 'ready', revision: state.revision + (Object.is(next, state.value) ? 0 : 1) })
      recovered = false
    } catch (cause) {
      if (!valid()) return
      const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : undefined
      if ((cause instanceof ResetRequired || cause instanceof ResourceValidationError) && options.recover && !recovered) {
        recovered = true
        try { options.recover(); pending = true } catch (error) {
          publish({ error: error instanceof Error ? error.message : 'Resource recovery failed', status: 'error' })
        }
      } else {
        // Never retry authorization or arbitrary network failures as version failures.
        try { options.onError?.(cause) } catch { /* domain observer isolation */ }
        const protectedError = status === 401 || status === 403
        if (protectedError) pending = false
        publish({ error: cause instanceof Error ? cause.message : 'Resource is unavailable. Retry.',
          status: protectedError ? 'forbidden' : 'error', ...(protectedError ? { value: undefined, version: undefined, revision: state.revision + 1 } : {}) })
      }
    } finally {
      clearTimeout(timeout)
      if (controller === current) {
        current.abort()
        controller = undefined
        if (pending) schedule()
        else { publish({ loading: false }); settle() }
      }
    }
  }
  function invalidate(reason = 'invalidation') {
    if (closed) return
    pending = true
    publish({ refreshReason: reason, loading: true, status: state.value === undefined ? 'loading' : 'refreshing' })
    schedule()
  }
  function read(): Promise<void> {
    if (closed) return Promise.resolve()
    if (state.value === undefined && !state.error && !state.loading) invalidate('initial-read')
    return state.loading ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve()
  }
  function cancel() {
    clearTimeout(timer); timer = undefined
    controller?.abort(); controller = undefined
    pending = false
  }
  return {
    get state() { return state },
    subscribe(listener: (state: ResourceState<T>) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    read, invalidate,
    update(transform: (value: T) => T) {
      if (closed || state.value === undefined) return false
      const next = transform(state.value)
      if (options.validate?.(next) === false) throw new ResourceValidationError('Invalid resource candidate')
      publish({ value: next, revision: state.revision + (Object.is(next, state.value) ? 0 : 1) })
      return true
    },
    refresh() { recovered = false; invalidate('manual'); return read() },
    reset(reason = 'recovery') {
      if (closed) return
      cancel(); recovered = false
      publish({ generation: state.generation + 1 })
      invalidate(reason)
    },
    pause() {
      if (closed) return
      cancel()
      publish({ generation: state.generation + 1, loading: false, status: state.value === undefined ? 'idle' : 'ready' })
      settle()
    },
    dispose() {
      if (closed) return
      closed = true; cancel()
      publish({ value: undefined, version: undefined, generation: state.generation + 1, loading: false, status: 'disposed' })
      settle(); listeners.clear()
    },
  }
}
export type Resource<T> = ReturnType<typeof createResource<T>>

/** Arrays retain business order. Only object field order is canonicalized. Never pass secrets. */
export function canonicalResourceKey(scope: { host: string; authGeneration: number; projectId?: string; resource: string; projection: string; entityId?: string; query?: unknown }): string {
  function normalize(value: unknown): unknown {
    if (value === undefined) return undefined
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(item => { if (item === undefined) throw new TypeError('Undefined query item'); return normalize(item) })
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, normalize((value as Record<string, unknown>)[key])]))
    }
    throw new TypeError('Resource scope must be JSON data')
  }
  return JSON.stringify(normalize({ ...scope, host: scope.host.replace(/\/+$/, '') }))
}

/** App-owned registry. Heterogeneous values are hidden behind a typed acquisition boundary. */
export class ResourceRegistry {
  private entries = new Map<string, { resource: Resource<unknown>; leases: number; inactiveAt: number; bytes: number }>()
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private options: { maxInactive?: number; maxInactiveBytes?: number; ttlMs?: number; now?: () => number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now() }
  acquire<T>(key: string, create: () => Resource<T>) {
    if (this.closed) throw new Error('Resource registry is disposed')
    this.sweep()
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { resource: create() as Resource<unknown>, leases: 0, inactiveAt: 0, bytes: 0 }
      this.entries.set(key, entry)
    }
    entry.leases++
    let released = false
    const resource = entry.resource as Resource<T>
    return { resource, release: () => {
      if (released || this.closed) return
      released = true
      entry!.leases--
      if (!entry!.leases) {
        resource.pause(); entry!.inactiveAt = this.now()
        // Only retained, inactive projections pay this one-time serialization cost.
        // This is a UTF-8 retention budget, not a claim about actual JS heap size.
        if ((this.options.maxInactive ?? 32) > 0) {
          try { entry!.bytes = new TextEncoder().encode(JSON.stringify(resource.state.value) ?? '').byteLength }
          catch { entry!.bytes = Infinity }
        }
        this.sweep()
      }
    } }
  }
  sweep() {
    clearTimeout(this.timer); this.timer = undefined
    const now = this.now(), ttl = Math.max(0, this.options.ttlMs ?? 30_000)
    const inactive = [...this.entries].filter(([, entry]) => !entry.leases).sort((a, b) => a[1].inactiveAt - b[1].inactiveAt)
    let remaining = inactive.length
    const totalBytes = () => [...this.entries.values()].filter(entry => !entry.leases).reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [key, entry] of inactive) {
      if (now - entry.inactiveAt >= ttl || remaining > Math.max(0, this.options.maxInactive ?? 32)
        || totalBytes() > Math.max(0, this.options.maxInactiveBytes ?? 16 * 1024 * 1024)) {
        entry.resource.dispose(); this.entries.delete(key); remaining--
      }
    }
    const next = [...this.entries.values()].filter(entry => !entry.leases).map(entry => entry.inactiveAt + ttl - now)
    if (next.length && !this.closed) this.timer = setTimeout(() => this.sweep(), Math.max(1, Math.min(...next)))
  }
  get size() { return this.entries.size }
  dispose() {
    if (this.closed) return
    this.closed = true; clearTimeout(this.timer)
    for (const entry of this.entries.values()) entry.resource.dispose()
    this.entries.clear()
  }
}
