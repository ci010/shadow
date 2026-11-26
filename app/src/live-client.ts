import { projectionKinds, type ProjectionTopic } from '../../src/realtime/projection-wire.ts'
import type { PresenceReport } from '../../src/sessions/presence.ts'
import { t } from './i18n.ts'
import {
  isRealtimeCursor, isRealtimeEnvelope, isRealtimeTopic, realtimeTopicKey, REALTIME_MAX_TOPICS, REALTIME_MAX_TOPICS_BYTES,
  type RealtimeEnvelope, type RealtimeTopic,
} from '../../src/realtime/protocol.ts'
import { apiUrl, hostBase } from './api-url.ts'

const projectionTopic = (topic: RealtimeTopic): topic is ProjectionTopic => (projectionKinds as readonly string[]).includes(topic.kind)

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
  projectionSnapshot?: (data: unknown) => void
  projectionUnavailable?: () => void
  conversationSnapshot?: (data: unknown) => void
  conversationRefreshFailed?: () => void
}
export interface LiveSubscription {
  ready: (signal?: AbortSignal) => Promise<void>
  close: () => void
  refreshProjection?: () => boolean
  refreshConversation?: () => boolean
}
type Socket = { addEventListener(type: string, listener: EventListener): void; send(data: string): void; close(): void }
type Source = { addEventListener: (type: string, listener: EventListener) => void; close: () => void }
let mobileSource: ((url: string) => Source) | undefined
export function installMobileLiveSource(factory: (url: string) => Source) {
  mobileSource = factory
  return () => { if (mobileSource === factory) mobileSource = undefined }
}
type Subscriber = { topic: RealtimeTopic; observer: LiveObserver; closed: boolean; initialized: boolean; opened?: boolean; refreshRequested?: boolean }
type Waiter = { owner: Subscriber; resolve: () => void; reject: (error: unknown) => void }

export function createLiveClient(base: string, options: {
  source?: (url: string) => Source
  socket?: (url: string, protocols: string[]) => Socket
  ticket?: (url: string, signal: AbortSignal) => Promise<string[] | undefined>
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
  const socketUrl = () => apiUrl(hostBase(base), '/api/live/ws')
  const mayUseSocket = () => !options.source && !mobileSource && (options.socket || (typeof window !== 'undefined' && typeof WebSocket !== 'undefined'))
  let useSocket: boolean | undefined = mayUseSocket() ? undefined : false
  let probe: AbortController | undefined
  let socket: Socket | undefined
  let socketOpened = false
  let requestId = 0
  let supportsProjections = false
  let supportsConversationOpen = false
  let socketPresence = false
  let everSocketPresence = false
  let pending: { id: number; desired: Set<string>; opening: Map<string, Subscriber[]>; capabilitiesKnown: boolean } | undefined
  let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined
  let rejectedTopics = new Set<string>()
  const topicCursors = new Map<string, string>()
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
    const previous = source
    source = undefined
    previous?.close()
    const previousSocket = socket
    socket = undefined
    socketOpened = false
    supportsProjections = false
    supportsConversationOpen = false
    socketPresence = false
    // A disconnected socket cannot acknowledge the refresh it took.
    for (const group of pending?.opening.values() ?? []) for (const subscriber of group) {
      if (!subscriber.closed && subscriber.opened) subscriber.refreshRequested = true
    }
    pending = undefined
    clearTimeout(acknowledgementTimer)
    acknowledgementTimer = undefined
    probe?.abort()
    probe = undefined
    previousSocket?.close()
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
    for (const [key, topic] of unique) if (projectionTopic(topic) && !(useSocket && supportsProjections)) {
      unique.delete(key)
      const bootstrap: RealtimeTopic = { kind: 'resources', projectId: topic.projectId }
      unique.set(realtimeTopicKey(bootstrap), bootstrap)
    }
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, topic]) => topic)
  }
  function heartbeat() {
    clearTimeout(watchdog)
    watchdog = setTimeout(reconnect, options.heartbeatTimeoutMs ?? 45_000)
  }
  function reconnect() {
    if (disposed) return
    if (!subscribers.size) { stopSource(); update({ phase: 'idle' }); return }
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
      for (const subscriber of subscribers) if (!subscriber.closed && projectionTopic(subscriber.topic) && !subscriber.initialized) {
        subscriber.initialized = true
        subscriber.observer.projectionUnavailable?.()
      }
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
  const denied = () => new Error(t('This live topic is not available to the current connection.'))
  function settleSocketTopics() {
    for (const waiter of [...waiters]) {
      const key = realtimeTopicKey(waiter.owner.topic)
      if (rejectedTopics.has(key)) waiter.reject(denied())
      else if (unavailableTopics.has(key)) waiter.reject(projectUnavailable())
      else if (connectedTopics.has(key) && waiter.owner.initialized) waiter.resolve()
    }
  }
  let needsUpdate = false
  function sendSubscriptions() {
    if (!socket || !socketOpened || pending || !needsUpdate) return
    needsUpdate = false
    const selected = topics()
    const desired = new Set(selected.map(realtimeTopicKey))
    const acknowledged = new Set([...connectedTopics, ...rejectedTopics])
    const opening = new Map<string, Subscriber[]>()
    if (supportsConversationOpen) for (const subscriber of subscribers) {
      if (subscriber.closed || (subscriber.initialized && !subscriber.refreshRequested) || !subscriber.observer.conversationSnapshot || subscriber.topic.kind !== 'chat') continue
      const key = realtimeTopicKey(subscriber.topic)
      opening.set(key, [...opening.get(key) ?? [], subscriber])
      // Consume at dispatch, not acknowledgement: a later invalidation may
      // already be queued when the current snapshot arrives.
      subscriber.refreshRequested = false
    }
    const projecting = new Set([...subscribers].filter(s => !s.closed && supportsProjections && projectionTopic(s.topic) && (!s.initialized || s.refreshRequested)).map(s => realtimeTopicKey(s.topic)))
    if (!opening.size && !projecting.size && desired.size === acknowledged.size && [...desired].every(key => acknowledged.has(key)) && ready) return
    pending = { id: ++requestId, desired, opening, capabilitiesKnown: supportsConversationOpen }
    acknowledgementTimer = setTimeout(reconnect, options.readyTimeoutMs ?? 10_000)
    try {
      socket.send(JSON.stringify({ type: opening.size ? 'openConversation' : 'subscribe', id: requestId,
        ...(opening.size ? { conversations: selected.filter(topic => opening.has(realtimeTopicKey(topic))) } : {}),
        subscriptions: selected.map(topic => ({ topic, ...(projectionTopic(topic) && projecting.has(realtimeTopicKey(topic)) ? { snapshot: true } : {}), cursor: topicCursors.get(realtimeTopicKey(topic)),
          ...([...subscribers].some(subscriber => subscriber.opened && realtimeTopicKey(subscriber.topic) === realtimeTopicKey(topic)) ? { conversation: true } : {}),
        })) }))
      for (const subscriber of subscribers) if (projecting.has(realtimeTopicKey(subscriber.topic))) subscriber.refreshRequested = false
    } catch { reconnect() }
  }
  const topicArray = (value: unknown): RealtimeTopic[] => {
    if (!Array.isArray(value) || value.length > REALTIME_MAX_TOPICS || !value.every(isRealtimeTopic)) throw new Error('Invalid live topics')
    return value
  }
  const resetReasons = new Set<LiveResetReason>(['initial', 'expired', 'epoch', 'invalid', 'project-removed', 'project-restored'])
  function deliverSocket(data: unknown) {
    if (!data || typeof data !== 'object') throw new Error('Invalid live frame')
    const frame = data as Record<string, unknown>
    const watermark = frame.cursor
    if (!isRealtimeCursor(watermark)) throw new Error('Invalid live cursor')
    if (isRealtimeEnvelope(data)) {
      if (data.type === 'heartbeat') return
      if (data.type !== 'event') throw new Error('Unexpected live frame')
      const key = realtimeTopicKey(data.topic)
      if (!connectedTopics.has(key) && !pending?.desired.has(key)) throw new Error('Unexpected live event topic')
      const before = topicCursors.get(key)?.split(':')
      const after = data.cursor.split(':')
      if (before && (before[0] !== after[0] || Number(before[1]) >= Number(after[1]))) {
        if (before[0] !== after[0]) throw new Error('Live epoch changed without a reset')
        return
      }
      topicCursors.set(key, data.cursor)
      for (const subscriber of [...subscribers]) if (!subscriber.closed && subscriber.initialized && realtimeTopicKey(subscriber.topic) === key) {
        subscriber.observer.event(data)
      }
      return
    }
    if (frame.type === 'subscribed') {
      if (!pending || pending.id !== frame.id) throw new Error('Unexpected live acknowledgement')
      const { desired, opening, capabilitiesKnown } = pending
      const hadProjections = supportsProjections
      supportsProjections = frame.projectionSnapshots === true
      if (supportsProjections && !hadProjections && [...subscribers].some(s => projectionTopic(s.topic))) needsUpdate = true
      supportsConversationOpen = frame.conversationOpen === true
      socketPresence = frame.socketPresence === true
      everSocketPresence ||= socketPresence
      const removed = topicArray(frame.removed).map(realtimeTopicKey)
      const rejected = new Set(topicArray(frame.rejected).map(realtimeTopicKey))
      if ([...rejected].some(key => !desired.has(key))) throw new Error('Unexpected rejected topic')
      if (!Array.isArray(frame.added) || frame.added.length > REALTIME_MAX_TOPICS) throw new Error('Invalid live acknowledgement')
      const resets = new Map<string, LiveResetReason>()
      for (const key of removed) { unavailableTopics.delete(key); topicCursors.delete(key) }
      for (const key of rejected) { unavailableTopics.delete(key); topicCursors.delete(key) }
      for (const added of frame.added as unknown[]) {
        if (!added || typeof added !== 'object') throw new Error('Invalid added topic')
        const { topic, reason, unavailable } = added as Record<string, unknown>
        if (!isRealtimeTopic(topic) || (reason !== undefined && !resetReasons.has(reason as LiveResetReason)) ||
          (unavailable !== undefined && unavailable !== true)) throw new Error('Invalid added topic')
        const key = realtimeTopicKey(topic)
        if (!desired.has(key) || rejected.has(key)) throw new Error('Unexpected added topic')
        if (reason) resets.set(key, reason as LiveResetReason)
        if (unavailable) unavailableTopics.add(key)
        else unavailableTopics.delete(key)
      }
      connectedTopics = new Set([...desired].filter(key => !rejected.has(key)))
      rejectedTopics = rejected
      clearTimeout(acknowledgementTimer)
      acknowledgementTimer = undefined
      pending = undefined
      for (const key of topicCursors.keys()) if (!connectedTopics.has(key) || unavailableTopics.has(key)) topicCursors.delete(key)
      for (const key of connectedTopics) if (!unavailableTopics.has(key)) topicCursors.set(key, watermark)
      ready = true
      attempt = 0
      if (!supportsProjections) for (const subscriber of subscribers) {
        if (!subscriber.closed && !subscriber.initialized && projectionTopic(subscriber.topic)) {
          subscriber.initialized = true
          subscriber.observer.projectionUnavailable?.()
        }
      }
      if (status.phase !== 'live') update({ phase: 'live' })
      const receivedSnapshots = new Set<Subscriber>()
      if (Array.isArray(frame.conversations) && frame.conversations.length <= opening.size) {
        for (const entry of frame.conversations as unknown[]) {
          if (!entry || typeof entry !== 'object') continue
          const { topic, data } = entry as Record<string, unknown>
          if (!isRealtimeTopic(topic) || data === undefined) continue
          for (const subscriber of opening.get(realtimeTopicKey(topic)) ?? []) {
            if (!subscriber.closed) { receivedSnapshots.add(subscriber); subscriber.opened = true; subscriber.observer.conversationSnapshot?.(data) }
          }
        }
      }
      const receivedProjections = new Set<Subscriber>()
      if (Array.isArray(frame.projections)) for (const entry of frame.projections) {
        if (!entry || typeof entry !== 'object' || !isRealtimeTopic(entry.topic) || !projectionTopic(entry.topic) || !desired.has(realtimeTopicKey(entry.topic))) throw new Error('Invalid projection acknowledgement')
        for (const subscriber of subscribers) if (!subscriber.closed && realtimeTopicKey(subscriber.topic) === realtimeTopicKey(entry.topic)) {
          subscriber.initialized = true
          if (entry.snapshot !== undefined) { subscriber.observer.projectionSnapshot?.(entry.snapshot); receivedProjections.add(subscriber) }
          else { subscriber.observer.projectionUnavailable?.(); receivedProjections.add(subscriber) }
        }
      }
      for (const subscriber of [...subscribers]) {
        const key = realtimeTopicKey(subscriber.topic)
        if (subscriber.closed || !connectedTopics.has(key) || unavailableTopics.has(key)) continue
        if (receivedProjections.has(subscriber)) continue
        const reset = resets.get(key)
        const openingSubscriber = opening.get(key)?.includes(subscriber)
        const needsSnapshot = !subscriber.initialized && capabilitiesKnown || recovering && !!reset
        if (supportsConversationOpen && subscriber.observer.conversationSnapshot && needsSnapshot && !openingSubscriber) {
          subscriber.initialized = false
          needsUpdate = true
          continue
        }
        if (receivedSnapshots.has(subscriber) && subscriber.opened) subscriber.initialized = true
        else if (openingSubscriber && subscriber.opened) {
          // A failed refresh is not a subscription reset. Remain live and
          // let the observer recover once without reissuing this WS request.
          subscriber.initialized = true
          subscriber.observer.conversationRefreshFailed?.()
        } else if (reset || !subscriber.initialized) initialize(subscriber, reset ?? 'subscription')
        else if (recovering && !(supportsConversationOpen && subscriber.observer.conversationSnapshot)) subscriber.observer.reconnected?.()
      }
      recovering = false
      settleSocketTopics()
      sendSubscriptions()
      return
    }
    if (frame.type === 'topic-reset' && (frame.reason === 'project-removed' || frame.reason === 'project-restored')) {
      const affected = new Set(topicArray(frame.topics).map(realtimeTopicKey))
      const unavailable = new Set(topicArray(frame.unavailable).map(realtimeTopicKey))
      if ([...affected].some(key => !connectedTopics.has(key)) || [...unavailable].some(key => !affected.has(key))) throw new Error('Unexpected reset topics')
      for (const key of affected) {
        if (unavailable.has(key)) { unavailableTopics.add(key); topicCursors.delete(key) }
        else { unavailableTopics.delete(key); topicCursors.set(key, watermark) }
      }
      for (const subscriber of [...subscribers]) {
        if (subscriber.closed || !affected.has(realtimeTopicKey(subscriber.topic))) continue
        if (frame.reason === 'project-restored' && projectionTopic(subscriber.topic)) {
          subscriber.refreshRequested = true; needsUpdate = true
        } else if (frame.reason === 'project-restored' && supportsConversationOpen && subscriber.observer.conversationSnapshot) {
          subscriber.initialized = false
          needsUpdate = true
        } else initialize(subscriber, frame.reason)
      }
      settleSocketTopics()
      sendSubscriptions()
      return
    }
    throw new Error('Invalid live envelope')
  }
  function connectSocket(protocols: string[]) {
    const url = socketUrl()
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = (options.socket ?? ((url, offered) => new WebSocket(url, offered)))(url.toString(), protocols)
    socket = current
    socketOpened = false
    supportsConversationOpen = false
    socketPresence = false
    requestId = 0
    connectedTopics.clear()
    rejectedTopics.clear()
    unavailableTopics.clear()
    needsUpdate = true
    update({ phase: attempt ? 'reconnecting' : 'connecting' })
    heartbeat()
    current.addEventListener('open', () => {
      if (socket !== current) return
      socketOpened = true
      sendSubscriptions()
    })
    current.addEventListener('message', event => {
      if (socket !== current || disposed) return
      try {
        if (!('data' in event) || typeof event.data !== 'string') throw new Error('Invalid live frame')
        heartbeat()
        deliverSocket(JSON.parse(event.data))
      } catch {
        fail(new Error(t('Could not validate or apply live updates. Retry live updates to reload saved state.')))
      }
    })
    for (const event of ['error', 'close']) current.addEventListener(event, () => { if (socket === current) reconnect() })
  }
  async function connect() {
    timer = undefined
    if (disposed || !subscribers.size || probe) return
    if (useSocket !== false) {
      const current = new AbortController()
      probe = current
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(3000)])
      let protocols: string[] | undefined
      try {
        const acquire = options.ticket ?? (async (url: string, signal: AbortSignal) => {
          const response = await fetch(url, { method: 'POST', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
          if (!response.ok) { await response.body?.cancel(); return }
          const { protocol, proof } = await response.json()
          if (protocol === 'shadow.live.v1' && typeof proof === 'string' && /^ticket\.[a-f0-9-]{36}$/.test(proof)) return [protocol, proof]
        })
        protocols = await acquire(socketUrl().toString(), signal)
      } catch { /* Older and delegated hosts do not issue WebSocket tickets. */ }
      if (probe !== current || disposed) return
      probe = undefined
      if (!subscribers.size) { update({ phase: 'idle' }); return }
      if (protocols) {
        useSocket = true
        stopSource()
        try { connectSocket(protocols) } catch { reconnect() }
        return
      }
      if (useSocket) { reconnect(); return }
      useSocket = false
    }
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
    if (useSocket && socket) {
      needsUpdate = true
      clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; sendSubscriptions() }, 0)
      return
    }
    if (probe) return
    if (timer !== undefined && status.phase === 'reconnecting') return
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
    if (projectionTopic(topic)) subscriber.refreshRequested = true
    changed()
    if (!projectionTopic(topic) && !(supportsConversationOpen && observer.conversationSnapshot) && ready && connectedTopics.has(realtimeTopicKey(topic)) && !unavailableTopics.has(realtimeTopicKey(topic)) &&
      (!pending || pending.desired.has(realtimeTopicKey(topic)))) {
      queueMicrotask(() => {
        if (subscriber.closed) return
        try { initialize(subscriber, 'subscription') }
        catch { fail(new Error(t('Could not reload live state. Retry live updates.'))) }
      })
    }
    return {
      refreshProjection() {
        if (subscriber.closed || !supportsProjections || !ready || !projectionTopic(topic)
          || rejectedTopics.has(realtimeTopicKey(topic)) || unavailableTopics.has(realtimeTopicKey(topic))) return false
        subscriber.refreshRequested = true; changed(); return true
      },
      refreshConversation() {
        if (subscriber.closed || !subscriber.opened || !supportsConversationOpen || !ready) return false
        // The current topic remains live while its replacement snapshot is read.
        subscriber.refreshRequested = true
        changed()
        return true
      },
      ready(signal) {
        if (subscriber.closed) return Promise.reject(new DOMException(t('Live subscription closed'), 'AbortError'))
        if (signal?.aborted) return Promise.reject(signal.reason)
        if (ready && rejectedTopics.has(realtimeTopicKey(topic))) return Promise.reject(denied())
        if (ready && unavailableTopics.has(realtimeTopicKey(topic))) return Promise.reject(projectUnavailable())
        if ((!projectionTopic(topic) || subscriber.initialized) && !(supportsConversationOpen && observer.conversationSnapshot && !subscriber.initialized) && ready && connectedTopics.has(realtimeTopicKey(topic)) && (!pending || pending.desired.has(realtimeTopicKey(topic)))) return Promise.resolve()
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
        if (!useSocket && topic.kind === 'chat' && connectedTopics.has(key)
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
    canOpenConversation: () => supportsConversationOpen && ready,
    reportPresence(projectId: string, report: PresenceReport) {
      if (!everSocketPresence || useSocket === false) return false
      // Don't replay presence measured during a disconnect: receipt time is
      // evidence freshness. The next local heartbeat samples the device anew.
      if (socketPresence && socket && socketOpened) {
        try { socket.send(JSON.stringify({ type: 'presence', projectId, report })) } catch { reconnect() }
      }
      return true
    },
    isLive: () => ready,
    retry() {
      if (disposed) return
      clearRetained()
      cursor = undefined
      topicCursors.clear()
      useSocket = mayUseSocket() ? undefined : false
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
