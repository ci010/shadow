import { t } from './i18n.ts'
import {
  isRealtimeEnvelope, isRealtimeTopic, realtimeTopicKey, REALTIME_MAX_TOPICS, REALTIME_MAX_TOPICS_BYTES,
  type RealtimeEnvelope, type RealtimeTopic,
} from '../../src/realtime/protocol.ts'
import { apiUrl, hostBase } from './api-url.ts'

export type LiveEvent = Extract<RealtimeEnvelope, { type: 'event' }>
export type LiveResetReason = Extract<RealtimeEnvelope, { type: 'reset' }>['reason'] | 'subscription' | 'reconnect'
export interface LiveStatus {
  phase: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
  error?: string
}
export interface LiveObserver {
  event: (event: LiveEvent) => void
  reset: (reason: LiveResetReason) => void
  reconnected?: () => void
}
export interface LiveSubscription {
  ready: (signal?: AbortSignal) => Promise<void>
  close: () => void
}
type Source = { addEventListener: (type: string, listener: EventListener) => void; close: () => void }
let mobileSource: ((url: string) => Source) | undefined
export function installMobileLiveSource(factory: (url: string) => Source) {
  mobileSource = factory
  return () => { if (mobileSource === factory) mobileSource = undefined }
}
type Subscriber = { topic: RealtimeTopic; observer: LiveObserver; closed: boolean; initialized: boolean }
type Waiter = { owner: Subscriber; resolve: () => void; reject: (error: unknown) => void }

export function createLiveClient(base: string, options: {
  source?: (url: string) => Source
  status?: (status: LiveStatus) => void
  heartbeatTimeoutMs?: number
  readyTimeoutMs?: number
} = {}) {
  const subscribers = new Set<Subscriber>()
  const waiters = new Set<Waiter>()
  // Only previously requested chat topics are kept warm. This is not a cache of
  // chat bodies: closed observers receive nothing and new observers snapshot.
  const retained = new Map<string, { topic: RealtimeTopic }>()
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  function forget(key: string) {
    retained.delete(key)
    if (!retained.size) {
      clearTimeout(retentionTimer)
      retentionTimer = undefined
    }
  }
  function clearRetained() {
    for (const key of retained.keys()) forget(key)
  }
  let source: Source | undefined
  let connectedTopics = new Set<string>()
  let unavailableTopics = new Set<string>()
  let ready = false
  let cursor: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let recovering = false
  let disposed = false
  let status: LiveStatus = { phase: 'idle' }

  function update(next: LiveStatus) {
    status = next
    options.status?.(next)
  }
  function stopSource() {
    ready = false
    clearTimeout(watchdog)
    watchdog = undefined
    source?.close()
    source = undefined
  }
  function fail(error: Error) {
    clearRetained()
    clearTimeout(timer)
    timer = undefined
    stopSource()
    update({ phase: 'error', error: error.message })
    for (const waiter of [...waiters]) waiter.reject(error)
  }
  function topics() {
    const unique = new Map<string, RealtimeTopic>()
    for (const subscriber of subscribers) unique.set(realtimeTopicKey(subscriber.topic), subscriber.topic)
    for (const [key, entry] of retained) unique.set(key, entry.topic)
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, topic]) => topic)
  }
  function heartbeat() {
    clearTimeout(watchdog)
    watchdog = setTimeout(reconnect, options.heartbeatTimeoutMs ?? 45_000)
  }
  function reconnect() {
    if (disposed || !subscribers.size) return
    recovering = true
    // A necessary reconnect also removes unused topics, without a later
    // cleanup-only reconnect. Active observers retain the replay cursor.
    clearRetained()
    stopSource()
    clearTimeout(timer)
    update({ phase: 'reconnecting', error: t('Live updates disconnected. Reconnecting to Main; saved history remains available.') })
    timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)))
  }
  function initialize(subscriber: Subscriber, reason: LiveResetReason) {
    subscriber.initialized = true
    subscriber.observer.reset(reason)
  }
  function projectUnavailable() {
    return new Error(t('This project is unavailable. Retry project startup before submitting a message.'))
  }
  function deliver(envelope: RealtimeEnvelope) {
    if (envelope.type === 'unavailable') {
      const keys = envelope.topics.map(realtimeTopicKey)
      if (keys.some(key => !connectedTopics.has(key))) throw new Error(t('Unexpected unavailable live topic'))
      unavailableTopics = new Set(keys)
      for (const waiter of [...waiters]) {
        if (unavailableTopics.has(realtimeTopicKey(waiter.owner.topic))) waiter.reject(projectUnavailable())
      }
      return
    }
    if (envelope.type === 'event') {
      if (cursor) {
        const separator = cursor.lastIndexOf(':')
        const nextSeparator = envelope.cursor.lastIndexOf(':')
        if (cursor.slice(0, separator) !== envelope.cursor.slice(0, nextSeparator)) {
          throw new Error(t('Main changed its live event generation without a reset. Retry live updates.'))
        }
        if (Number(envelope.cursor.slice(nextSeparator + 1)) <= Number(cursor.slice(separator + 1))) return
      }
      const key = realtimeTopicKey(envelope.topic)
      for (const subscriber of [...subscribers]) {
        if (!subscriber.closed && subscriber.initialized && realtimeTopicKey(subscriber.topic) === key) subscriber.observer.event(envelope)
      }
      cursor = envelope.cursor
      return
    }
    cursor = envelope.cursor
    if (envelope.type === 'reset') {
      ready = false
      recovering = false
      unavailableTopics.clear()
      for (const subscriber of [...subscribers]) if (!subscriber.closed) initialize(subscriber, envelope.reason)
    } else if (envelope.type === 'ready') {
      ready = true
      attempt = 0
      update({ phase: 'live' })
      for (const subscriber of [...subscribers]) {
        if (subscriber.closed || !connectedTopics.has(realtimeTopicKey(subscriber.topic))
          || unavailableTopics.has(realtimeTopicKey(subscriber.topic))) continue
        if (!subscriber.initialized) initialize(subscriber, 'subscription')
        else if (recovering) subscriber.observer.reconnected?.()
      }
      recovering = false
      for (const waiter of [...waiters]) {
        const key = realtimeTopicKey(waiter.owner.topic)
        if (unavailableTopics.has(key)) waiter.reject(projectUnavailable())
        else if (connectedTopics.has(key)) waiter.resolve()
      }
    }
  }
  function connect() {
    timer = undefined
    if (disposed || !subscribers.size) return
    stopSource()
    const selected = topics()
    const nextTopics = new Set(selected.map(realtimeTopicKey))
    const url = apiUrl(hostBase(base), '/api/live', { topics: JSON.stringify(selected), ...(cursor ? { cursor } : {}) })
    try {
      const current = (options.source ?? mobileSource ?? (url => new EventSource(url)))(url.toString())
      source = current
      connectedTopics = nextTopics
      unavailableTopics.clear()
      update({ phase: attempt ? 'reconnecting' : 'connecting', ...(attempt ? { error: t('Live updates are reconnecting to Main.') } : {}) })
      heartbeat()
      current.addEventListener('realtime', event => {
        if (source !== current || disposed) return
        try {
          if (!('data' in event) || typeof event.data !== 'string') throw new Error('Invalid live frame')
          const envelope: unknown = JSON.parse(event.data)
          if (!isRealtimeEnvelope(envelope)) throw new Error('Invalid live envelope')
          heartbeat()
          deliver(envelope)
        } catch {
          fail(new Error(t('Could not validate or apply live updates. Retry live updates to reload saved state.')))
        }
      })
      current.addEventListener('error', () => { if (source === current) reconnect() })
    } catch {
      fail(new Error(t('Could not open live updates. Check the Main address and retry.')))
    }
  }
  function changed() {
    if (disposed) return
    // Never carry warm chat subscriptions into an unrelated project, or let
    // them consume the wire budget needed by active subscriptions.
    for (const [key, entry] of retained) {
      if (![...subscribers].some(subscriber => subscriber.topic.projectId === entry.topic.projectId)) forget(key)
    }
    while (retained.size && (retained.size > 4 || topics().length > REALTIME_MAX_TOPICS
      || new TextEncoder().encode(JSON.stringify(topics())).byteLength > REALTIME_MAX_TOPICS_BYTES)) {
      forget(retained.keys().next().value!)
    }
    const desired = new Set(topics().map(realtimeTopicKey))
    if (source && desired.size === connectedTopics.size && [...desired].every(key => connectedTopics.has(key))) {
      clearTimeout(timer)
      timer = undefined
      return
    }
    clearTimeout(timer)
    timer = undefined
    // Keep the current stream until the batched topic set is known. A pane can
    // unsubscribe and resubscribe to the same topic in one synchronous update.
    // connect() closes it if a different topic set is still needed next tick.
    if (!subscribers.size) {
      clearRetained()
      stopSource()
      connectedTopics.clear()
      update({ phase: 'idle' })
    } else timer = setTimeout(connect, 0)
  }
  function subscribe(topic: RealtimeTopic, observer: LiveObserver): LiveSubscription {
    if (disposed) throw new Error(t('Live updates have been disposed.'))
    if (!isRealtimeTopic(topic)) throw new Error(t('Invalid live subscription.'))
    const subscriber: Subscriber = { topic, observer, closed: false, initialized: false }
    forget(realtimeTopicKey(topic))
    subscribers.add(subscriber)
    changed()
    if (ready && connectedTopics.has(realtimeTopicKey(topic)) && !unavailableTopics.has(realtimeTopicKey(topic))) {
      queueMicrotask(() => {
        if (subscriber.closed) return
        try { initialize(subscriber, 'subscription') }
        catch { fail(new Error(t('Could not reload live state. Retry live updates.'))) }
      })
    }
    return {
      ready(signal) {
        if (subscriber.closed) return Promise.reject(new DOMException(t('Live subscription closed'), 'AbortError'))
        if (signal?.aborted) return Promise.reject(signal.reason)
        if (ready && unavailableTopics.has(realtimeTopicKey(topic))) return Promise.reject(projectUnavailable())
        if (ready && connectedTopics.has(realtimeTopicKey(topic))) return Promise.resolve()
        if (status.phase === 'error') return Promise.reject(new Error(status.error))
        return new Promise<void>((resolve, reject) => {
          const deadline = AbortSignal.timeout(options.readyTimeoutMs ?? 10_000)
          const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
          const finish = (error?: unknown) => {
            combined.removeEventListener('abort', abort)
            waiters.delete(waiter)
            if (error !== undefined) reject(error)
            else resolve()
          }
          const abort = () => finish(signal?.aborted ? signal.reason : new Error(t('Live updates are not ready. Check Main and retry; no message was submitted.')))
          const waiter: Waiter = { owner: subscriber, resolve: () => finish(), reject: finish }
          waiters.add(waiter)
          combined.addEventListener('abort', abort, { once: true })
          if (combined.aborted) abort()
        })
      },
      close() {
        if (subscriber.closed) return
        subscriber.closed = true
        subscribers.delete(subscriber)
        const key = realtimeTopicKey(topic)
        if (topic.kind === 'chat' && connectedTopics.has(key)
          && ![...subscribers].some(other => realtimeTopicKey(other.topic) === key)) {
          forget(key)
          retained.set(key, { topic })
          // One non-sliding deadline per batch, not one reconnect per topic.
          // Later entries have a shorter warm period; none exceed 30 seconds.
          if (retentionTimer === undefined) retentionTimer = setTimeout(() => {
            clearRetained()
            changed()
          }, 30_000)
        }
        for (const waiter of [...waiters]) if (waiter.owner === subscriber) waiter.reject(new DOMException(t('Live subscription closed'), 'AbortError'))
        changed()
      },
    }
  }
  return {
    subscribe,
    isLive: () => ready,
    retry() {
      if (disposed) return
      clearRetained()
      cursor = undefined
      attempt = 0
      for (const subscriber of subscribers) subscriber.initialized = false
      clearTimeout(timer)
      stopSource()
      if (subscribers.size) timer = setTimeout(connect, 0)
    },
    dispose() {
      disposed = true
      clearRetained()
      clearTimeout(timer)
      stopSource()
      for (const waiter of [...waiters]) waiter.reject(new DOMException(t('Live updates closed'), 'AbortError'))
      subscribers.clear()
      update({ phase: 'idle' })
    },
  }
}
export type LiveClient = ReturnType<typeof createLiveClient>
