import { presenceReportSchema, type PresenceReport } from '../sessions/presence.ts'
import { randomUUID } from 'node:crypto'
import { parseSessionActivityReadModel, type SessionActivityReadModel } from '../sessions/activity-read-model.ts'
import type { Hono } from 'hono'
import type { WebSocket, RawData } from 'ws'
import { upgradeGatewayWebSocket } from '../gateway/websocket.ts'
import { registerRealtimeSocketTicket } from './socket-ticket.ts'
import { parseRealtimeSocketCommand, REALTIME_SUBSCRIBE_BYTES, type RealtimeSubscriptionAck } from './subscription.ts'
import { isRealtimeCursor, isRealtimeTopic, parseRealtimeTopics, realtimeTopicKey, type RealtimeEnvelope, type RealtimeTopic, type RealtimeResource, type RealtimeSessionChange, type RealtimeSessionActivityPayload } from './protocol.ts'

type EventEnvelope = Extract<RealtimeEnvelope, { type: 'event' }>
type ResetReason = Extract<RealtimeEnvelope, { type: 'reset' }>['reason']
type TelemetryKind = 'logs' | 'spans'
export interface RealtimeTelemetry {
  latest(kind: TelemetryKind): number
  query(kind: TelemetryKind, afterId: number, limit: number): { id: number }[]
}
export interface RealtimePublisher {
  activeChatSessions?(): string[]
  chat(sessionId: string, payload: unknown, requestId?: string): void
  invalidateSessions(sessionId?: string, completedTurnId?: string, changes?: readonly RealtimeSessionChange[]): void
  invalidateActivity(sessionId: string, activity?: SessionActivityReadModel): void
  invalidateIo?(runId: string): void
  invalidateIntegrations?(): void
  invalidateResource?(resource: RealtimeResource): void
  close(): void
}
interface Project {
  presence?: (report: PresenceReport) => void
  conversation?: (sessionId: string) => Promise<{ data?: unknown; error?: string }>
  telemetry?: RealtimeTelemetry
  tails: Map<TelemetryKind, { startedAt: number; count: number; timer: ReturnType<typeof setInterval> }>
}
interface Client {
  topics: RealtimeTopic[]
  conversationTopics?: Set<string>
  keys: Set<string>
  send(frame: Uint8Array): boolean
  close(error?: Error): void
  refresh(reason: ResetReason, projectId: string): void
  removeProject?(projectId: string): void
}
interface JournalEntry { sequence: number; projectId?: string; key: string; frame: Uint8Array; conversationOnly: boolean }

/** One host-owned feed. Publishers are leased to trusted runtime instances;
 * closing a lease invalidates even callbacks already queued by that runtime. */
export class RealtimeHub {
  private readonly epoch = randomUUID()
  private sequence = 0
  private replayFloor = 0
  private journal: JournalEntry[] = []
  private journalBytes = 0
  private clients = new Set<Client>()
  private projects = new Map<string, Project>()
  private closed = false
  private readonly encoder = new TextEncoder()
  private readonly options: Required<RealtimeHubOptions>

  constructor(options: RealtimeHubOptions = {}) {
    this.options = {
      journalCount: 2048, journalBytes: 4 * 1024 * 1024,
      clientBytes: 8 * 1024 * 1024, heartbeatMs: 15_000, telemetryMs: 1000,
      diagnostic: (reason) => console.warn(`[realtime] ${reason}`), ...options,
      projectExists: options.projectExists ?? (id => this.projects.has(id)),
    }
    for (const key of ['journalCount', 'journalBytes', 'clientBytes', 'heartbeatMs', 'telemetryMs'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new TypeError(`Invalid ${key}`)
    }
  }

  get cursor(): string { return `${this.epoch}:${this.sequence}` }
  get stats() { return { clients: this.clients.size, journalCount: this.journal.length, journalBytes: this.journalBytes, projects: this.projects.size } }

  invalidateProjects(): void {
    if (!this.closed) this.publish({ kind: 'projects' }, { event: 'invalidate' })
  }

  projectReady(projectId: string): void {
    for (const client of this.clients) {
      if (client.topics.some(topic => topic.projectId === projectId)) client.refresh('project-restored', projectId)
    }
  }

  registerProject(projectId: string, telemetry?: RealtimeTelemetry, conversation?: Project['conversation'], presence?: Project['presence']): RealtimePublisher {
    if (this.closed || !isRealtimeTopic({ kind: 'sessions', projectId }) || this.projects.has(projectId)) {
      throw new TypeError('Invalid or duplicate realtime project')
    }
    const project: Project = { telemetry, conversation, presence, tails: new Map() }
    this.projects.set(projectId, project)
    for (const client of this.clients) {
      if (client.topics.some(topic => topic.projectId === projectId)) client.refresh('project-restored', projectId)
    }
    const active = () => !this.closed && this.projects.get(projectId) === project
    return {
      activeChatSessions: () => active() ? [...new Set([...this.clients].flatMap(client =>
        client.topics.flatMap(topic => topic.kind === 'chat' && topic.projectId === projectId &&
          client.conversationTopics?.has(realtimeTopicKey(topic)) ? [topic.sessionId] : [])))] : [],
      chat: (sessionId, payload, requestId) => {
        if (active()) this.publish({ kind: 'chat', projectId, sessionId }, payload, requestId)
      },
      invalidateSessions: (sessionId, completedTurnId, changes) => {
        if (active()) this.publish({ kind: 'sessions', projectId }, { event: 'invalidate', sessionId, ...(completedTurnId ? { completedTurnId } : {}), ...(changes ? { changes } : {}) })
      },
      invalidateActivity: (sessionId, activity) => {
        const snapshot = parseSessionActivityReadModel(activity)
        if (active()) this.publish({ kind: 'sessions', projectId }, { event: 'activity', sessionId,
          ...(snapshot ? { activity: snapshot } : {}) } satisfies RealtimeSessionActivityPayload)
      },
      invalidateIo: runId => {
        if (active()) this.publish({ kind: 'io', projectId }, { event: 'invalidate', runId })
      },
      invalidateIntegrations: () => {
        if (active()) this.publish({ kind: 'integrations', projectId }, { event: 'invalidate' })
      },
      invalidateResource: resource => {
        if (active()) this.publish({ kind: 'resources', projectId }, { event: 'invalidate', resource })
      },
      close: () => {
        if (!active()) return
        this.projects.delete(projectId)
        for (const tail of project.tails.values()) clearInterval(tail.timer)
        project.tails.clear()
        this.replayFloor = this.sequence
        this.journal = this.journal.filter(entry => entry.projectId !== projectId)
        this.journalBytes = this.journal.reduce((sum, entry) => sum + entry.frame.byteLength, 0)
        for (const client of [...this.clients]) {
          if (!client.topics.some(topic => topic.projectId === projectId)) continue
          if (this.options.projectExists(projectId)) {
            client.refresh('project-removed', projectId)
            continue
          }
          if (client.removeProject) { client.removeProject(projectId); continue }
          client.send(this.frame({ type: 'reset', reason: 'project-removed', cursor: this.cursor }))
          client.close()
        }
      },
    }
  }

  private frame(envelope: RealtimeEnvelope): Uint8Array {
    return this.encoder.encode(`${envelope.type === 'event' ? `id: ${envelope.cursor}\n` : ''}event: realtime\ndata: ${JSON.stringify(envelope)}\n\n`)
  }

  private publish(topic: RealtimeTopic, payload: unknown, requestId?: string): void {
    if (!isRealtimeTopic(topic)) throw new TypeError('Invalid realtime publication topic')
    const event: EventEnvelope = { type: 'event', cursor: `${this.epoch}:${++this.sequence}`, topic, payload, ...(requestId ? { requestId } : {}) }
    const frame = this.frame(event)
    const key = realtimeTopicKey(topic)
    const conversationOnly = !!payload && typeof payload === 'object' && 'event' in payload && (payload.event === 'conversation_summary' || payload.event === 'conversation_history_changed')
    this.journal.push({ sequence: this.sequence, projectId: topic.projectId, key, frame, conversationOnly })
    this.journalBytes += frame.byteLength
    while (this.journal.length > this.options.journalCount || this.journalBytes > this.options.journalBytes) {
      const removed = this.journal.shift()!
      this.journalBytes -= removed.frame.byteLength
      this.replayFloor = Math.max(this.replayFloor, removed.sequence)
    }
    for (const client of this.clients) if (client.keys.has(key) && (!conversationOnly || client.conversationTopics?.has(key))) client.send(frame)
  }

  private subscribeTelemetry(topic: RealtimeTopic): () => void {
    if (topic.kind !== 'logs' && topic.kind !== 'spans') return () => {}
    const project = this.projects.get(topic.projectId)
    if (!project) return () => {}
    const store = project.telemetry
    if (!store) return () => {}
    const kind = topic.kind
    let tail = project.tails.get(kind)
    if (!tail) {
      let lastId = store.latest(kind)
      const timer = setInterval(() => {
        if (this.projects.get(topic.projectId) !== project) return
        try {
          // Bounded work per tick, with subsequent ticks draining the backlog.
          for (const row of store.query(kind, lastId, 100)) {
            this.publish(topic, row)
            lastId = row.id
          }
        } catch {
          this.options.diagnostic('telemetry-query-failed')
          const key = realtimeTopicKey(topic)
          for (const client of [...this.clients]) {
            if (client.keys.has(key)) client.close(new Error('Realtime telemetry query failed; reconnect and resnapshot'))
          }
        }
      }, this.options.telemetryMs)
      timer.unref?.()
      // Reserve a cursor boundary so a restarted tail cannot replay across its gap,
      // even if another subscriber has already started polling again.
      tail = { startedAt: ++this.sequence, count: 0, timer }
      project.tails.set(kind, tail)
    }
    tail.count++
    return () => {
      if (--tail.count === 0) {
        clearInterval(tail.timer)
        project.tails.delete(kind)
      }
    }
  }

  private resume(topics: RealtimeTopic[], cursor?: string): { reason?: ResetReason; after: number } {
    let reason: ResetReason | undefined
    let after = this.sequence
    if (cursor === undefined) reason = 'initial'
    else if (!isRealtimeCursor(cursor)) reason = 'invalid'
    else {
      const [epoch, sequence] = cursor.split(':')
      after = Number(sequence)
      if (epoch !== this.epoch) reason = 'epoch'
      else if (after > this.sequence) reason = 'invalid'
      else if (after < this.replayFloor) reason = 'expired'
    }
    // Stopped telemetry tails leave an interval that the journal cannot replay.
    if (!reason && topics.some(topic => {
      if (topic.kind !== 'logs' && topic.kind !== 'spans') return false
      const tail = this.projects.get(topic.projectId)?.tails.get(topic.kind)
      return !tail || after < tail.startedAt
    })) reason = 'expired'
    return { reason, after }
  }

  connectSocket(socket: WebSocket, authorizeTopic: (topic: RealtimeTopic) => boolean): void {
    if (this.closed) { socket.close(1012); return }
    let ended = false
    let lastId = -1
    const active = new Map<string, { topic: RealtimeTopic; release(): void }>()
    const decoder = new TextDecoder()
    const send = (text: string) => {
      if (ended || socket.readyState !== socket.OPEN) return false
      if (socket.bufferedAmount + Buffer.byteLength(text) > this.options.clientBytes) {
        this.options.diagnostic('slow-client-disconnected')
        client.close(new Error('Realtime client exceeded bounded queue'))
        return false
      }
      socket.send(text)
      return true
    }
    const remove = (key: string) => {
      active.get(key)?.release()
      active.delete(key)
      client.keys.delete(key)
      client.conversationTopics?.delete(key)
    }
    const availability = (projectId: string, reason: ResetReason, removed: boolean) => {
      const topics = [...active.values()].map(entry => entry.topic).filter(topic => topic.projectId === projectId)
      for (const topic of topics) {
        const key = realtimeTopicKey(topic)
        if (removed) remove(key)
        else {
          const entry = active.get(key)!
          entry.release()
          entry.release = this.subscribeTelemetry(topic)
        }
      }
      client.topics = [...active.values()].map(entry => entry.topic)
      send(JSON.stringify({ type: 'topic-reset', cursor: this.cursor, topics, reason,
        unavailable: this.projects.has(projectId) ? [] : topics }))
    }
    const cleanup = () => {
      if (ended) return
      ended = true
      clearInterval(heartbeat)
      this.clients.delete(client)
      socket.off('message', onMessage)
      for (const key of active.keys()) remove(key)
    }
    const client: Client = {
      topics: [], keys: new Set(), conversationTopics: new Set(),
      // Clients share the journal's serialized events; unwrap the SSE framing.
      send: frame => {
        const text = decoder.decode(frame)
        return send(text.slice(text.indexOf('\ndata: ') + 7, -2))
      },
      close: error => {
        cleanup()
        if (error) socket.terminate()
        else socket.close(1012)
      },
      refresh: (reason, projectId) => {
        try { availability(projectId, reason, false) }
        catch { client.close(new Error('Realtime project refresh failed')) }
      },
      removeProject: projectId => availability(projectId, 'project-removed', true),
    }
    let updating = false
    const onMessage = async (data: RawData, binary: boolean) => {
      let command: ReturnType<typeof parseRealtimeSocketCommand>
      try {
        if (binary || !Buffer.isBuffer(data) || data.byteLength > REALTIME_SUBSCRIBE_BYTES) throw new TypeError('Invalid realtime frame')
        const text = data.toString('utf8')
        const message = JSON.parse(text)
        if (message?.type === 'presence') {
          const topic = { kind: 'sessions', projectId: message.projectId }
          const report = presenceReportSchema.safeParse(message.report)
          if (isRealtimeTopic(topic) && report.success && authorizeTopic(topic)) {
            this.projects.get(topic.projectId)?.presence?.(report.data)
          }
          return
        }
        if (updating) throw new TypeError('Concurrent subscription command')
        command = parseRealtimeSocketCommand(text)
        if (command.id <= lastId) throw new TypeError('Non-monotonic subscription ID')
      } catch {
        cleanup()
        socket.close(1008, 'Invalid subscription update')
        return
      }
      try {
        lastId = command.id
        const projects = [...this.projects.values()]
        const ack: RealtimeSubscriptionAck = {
          type: 'subscribed', id: lastId, cursor: this.cursor, added: [], removed: [], rejected: [],
          ...(projects.some(project => project.conversation) ? { conversationOpen: true } : {}),
          ...(projects.some(project => project.presence) ? { socketPresence: true } : {}),
        }
        const desired = new Map<string, typeof command.subscriptions[number]>()
        for (const entry of command.subscriptions) {
          const { topic } = entry
          if (!authorizeTopic(topic) || (topic.kind !== 'projects' && !this.projects.has(topic.projectId) && !this.options.projectExists(topic.projectId))) {
            ack.rejected.push(topic)
          } else desired.set(realtimeTopicKey(topic), entry)
        }
        const opening = new Set<string>()
        if ('conversations' in command && command.conversations) {
          updating = true
          const topics = command.conversations
          // A stable journal interval avoids publishing an async snapshot on
          // the wrong side of an append, rollover, or activity notification.
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = this.sequence
            const reads = await Promise.all(topics.map(async topic => {
              const key = realtimeTopicKey(topic)
              const project = desired.has(key) ? this.projects.get(topic.projectId) : undefined
              try {
                const result = await project?.conversation?.(topic.sessionId)
                return { topic, project, result: result ?? { error: 'conversation_unavailable' } }
              } catch { return { topic, project, result: { error: 'conversation_unavailable' } } }
            }))
            if (ended) return
            if (before < this.replayFloor || this.journal.some(event => event.sequence > before && topics.some(topic =>
              event.key === realtimeTopicKey(topic) || event.key === realtimeTopicKey({ kind: 'sessions', projectId: topic.projectId })))) continue
            ack.conversations = reads.map(({ topic, project, result }) => {
              const key = realtimeTopicKey(topic)
              if (!project || project !== this.projects.get(topic.projectId) || !authorizeTopic(topic)) {
                return { topic, error: 'conversation_unavailable' }
              }
              if ('data' in result && result.data !== undefined) opening.add(key)
              return { topic, ...result }
            })
            break
          }
          ack.conversations ??= topics.map(topic => ({ topic, error: 'conversation_changed' }))
          updating = false
        }
        for (const [key, entry] of active) if (!desired.has(key)) {
          ack.removed.push(entry.topic)
          remove(key)
        }
        const replayAfter = new Map<string, number>()
        for (const [key, { topic, cursor, conversation }] of desired) {
          if (conversation) client.conversationTopics!.add(key)
          if (active.has(key)) continue
          const { reason, after } = this.resume([topic], opening.has(key) ? this.cursor : cursor)
          const unavailable = topic.kind !== 'projects' && !this.projects.has(topic.projectId)
          active.set(key, { topic, release: this.subscribeTelemetry(topic) })
          client.keys.add(key)
          ack.added.push({ topic, ...(reason ? { reason } : {}), ...(unavailable ? { unavailable: true } : {}) })
          if (!reason && !unavailable) replayAfter.set(key, after)
        }
        for (const key of opening) client.conversationTopics!.add(key)
        client.topics = [...active.values()].map(entry => entry.topic)
        if (replayAfter.size) for (const event of this.journal) {
          const after = replayAfter.get(event.key)
          if (after !== undefined && event.sequence > after && (!event.conversationOnly || client.conversationTopics?.has(event.key)) && !client.send(event.frame)) return
        }
        ack.cursor = this.cursor
        send(JSON.stringify(ack))
      } catch { client.close(new Error('Realtime subscription failed')) }
    }
    const heartbeat = setInterval(() => send(JSON.stringify({ type: 'heartbeat', cursor: this.cursor })), this.options.heartbeatMs)
    heartbeat.unref?.()
    this.clients.add(client)
    socket.on('message', onMessage)
    socket.once('close', cleanup)
    socket.on('error', () => client.close(new Error('Realtime socket failed')))
  }

  connect(topics: RealtimeTopic[], signal: AbortSignal, cursor?: string): Response {
    if (this.closed) return Response.json({ error: 'realtime_stopping' }, { status: 503 })
    // Also validate direct callers; the HTTP route is not the trust boundary.
    topics = parseRealtimeTopics(JSON.stringify(topics))
    if (topics.some(topic => topic.kind !== 'projects' && !this.projects.has(topic.projectId) && !this.options.projectExists(topic.projectId))) {
      return Response.json({ error: 'unknown_realtime_project' }, { status: 404 })
    }
    const { reason, after } = this.resume(topics, cursor)
    let client: Client
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let ended = false
        let heartbeat: ReturnType<typeof setInterval> | undefined
        const releases: Array<() => void> = []
        const abort = () => client.close()
        const subscribe = () => {
          for (const release of releases.splice(0)) release()
          for (const topic of topics) releases.push(this.subscribeTelemetry(topic))
        }
        const sendAvailability = () => {
          const unavailable = topics.filter(topic => topic.kind !== 'projects' && !this.projects.has(topic.projectId))
          if (unavailable.length) client.send(this.frame({ type: 'unavailable', cursor: this.cursor, topics: unavailable }))
          client.send(this.frame({ type: 'ready', cursor: this.cursor }))
        }
        client = {
          topics, keys: new Set(topics.map(realtimeTopicKey)),
          close: error => {
            if (ended) return
            ended = true
            this.clients.delete(client)
            if (heartbeat) clearInterval(heartbeat)
            signal.removeEventListener('abort', abort)
            for (const release of releases) release()
            try { if (error) controller.error(error); else controller.close() } catch { /* cancelled */ }
          },
          send: frame => {
            if (ended) return false
            if (frame.byteLength > (controller.desiredSize ?? 0)) {
              this.options.diagnostic('slow-client-disconnected')
              client.close(new Error('Realtime client exceeded bounded queue; reconnect and resnapshot'))
              return false
            }
            controller.enqueue(frame)
            return true
          },
          refresh: reason => {
            if (ended) return
            try {
              subscribe()
              client.send(this.frame({ type: 'reset', reason, cursor: this.cursor }))
              sendAvailability()
            } catch (error) { client.close(error instanceof Error ? error : new Error(String(error))) }
          },
        }
        if (signal.aborted) { client.close(); return }
        this.clients.add(client)
        signal.addEventListener('abort', abort, { once: true })
        try {
          subscribe()
          if (reason) client.send(this.frame({ type: 'reset', cursor: this.cursor, reason }))
          else for (const entry of this.journal) {
            if (entry.sequence > after && client.keys.has(entry.key) && !entry.conversationOnly) client.send(entry.frame)
          }
          sendAvailability()
          if (!ended) {
            heartbeat = setInterval(() => client.send(this.frame({ type: 'heartbeat', cursor: this.cursor })), this.options.heartbeatMs)
            heartbeat.unref?.()
          }
        } catch (error) { client.close(error instanceof Error ? error : new Error(String(error))) }
      },
      cancel: () => client?.close(),
    }, { highWaterMark: this.options.clientBytes, size: frame => frame.byteLength })
    return new Response(stream, { headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    } })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const client of [...this.clients]) client.close()
    for (const project of this.projects.values()) {
      for (const tail of project.tails.values()) clearInterval(tail.timer)
    }
    this.projects.clear()
    this.journal = []
    this.journalBytes = 0
  }
}

export interface RealtimeHubOptions {
  projectExists?: (projectId: string) => boolean
  journalCount?: number
  journalBytes?: number
  clientBytes?: number
  heartbeatMs?: number
  telemetryMs?: number
  diagnostic?: (reason: string) => void
}

export { REALTIME_SOCKET_PATH } from './socket-ticket.ts'

export function registerRealtimeRoute(
  app: Hono, hub: RealtimeHub, authorize: (request: Request) => boolean | Promise<boolean>,
  socketAccess?: {
    authorize(request: Request): boolean | Promise<boolean>
    authorizeTopic(request: Request, topic: RealtimeTopic): boolean
    ownerSignal?(request: Request): AbortSignal | undefined
  },
): void {
  if (socketAccess) registerRealtimeSocketTicket(app, {
    authorize: socketAccess.authorize,
    allowDirect: true,
    ownerSignal: socketAccess.ownerSignal,
    upgrade: (c, ownerRequest, lifetimeSignal, protocol) => upgradeGatewayWebSocket(app, c, socket => {
      // Electron's upgrade has no verified frame. Bind the socket to the
      // separately authenticated HTTP principal's lifetime instead.
      const revoke = () => socket.close(1008, 'Session ended')
      if (lifetimeSignal?.aborted) { revoke(); return }
      lifetimeSignal?.addEventListener('abort', revoke, { once: true })
      socket.once('close', () => lifetimeSignal?.removeEventListener('abort', revoke))
      hub.connectSocket(socket, topic => !lifetimeSignal?.aborted && socketAccess.authorizeTopic(ownerRequest, topic))
    }, protocol),
  })
  app.get('/api/live', async c => {
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    const query = c.req.queries()
    if ((query.topics?.length ?? 0) !== 1 || (query.cursor?.length ?? 0) > 1) {
      return c.json({ error: 'Invalid realtime query' }, 400)
    }
    let topics: RealtimeTopic[]
    try { topics = parseRealtimeTopics(c.req.query('topics')) }
    catch { return c.json({ error: 'Invalid realtime topics' }, 400) }
    return hub.connect(topics, c.req.raw.signal, c.req.query('cursor') ?? c.req.header('Last-Event-ID'))
  })
}
