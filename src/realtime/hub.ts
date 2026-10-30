import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { isRealtimeCursor, isRealtimeTopic, parseRealtimeTopics, realtimeTopicKey, type RealtimeEnvelope, type RealtimeTopic } from './protocol.ts'

type EventEnvelope = Extract<RealtimeEnvelope, { type: 'event' }>
type ResetReason = Extract<RealtimeEnvelope, { type: 'reset' }>['reason']
type TelemetryKind = 'logs' | 'spans'
export interface RealtimeTelemetry {
  latest(kind: TelemetryKind): number
  query(kind: TelemetryKind, afterId: number, limit: number): { id: number }[]
}
export interface RealtimePublisher {
  chat(sessionId: string, payload: unknown, requestId?: string): void
  invalidateSessions(sessionId?: string, completedTurnId?: string): void
  invalidateActivity(sessionId: string): void
  invalidateIo?(runId: string): void
  invalidateIntegrations?(): void
  invalidateResource?(resource: 'interactions' | 'service-groups'): void
  close(): void
}
interface Project {
  telemetry?: RealtimeTelemetry
  tails: Map<TelemetryKind, { count: number; timer: ReturnType<typeof setInterval> }>
}
interface Client {
  topics: RealtimeTopic[]
  keys: Set<string>
  send(frame: Uint8Array): boolean
  close(error?: Error): void
  refresh(reason: ResetReason): void
}
interface JournalEntry { sequence: number; projectId?: string; key: string; frame: Uint8Array }

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
      if (client.topics.some(topic => topic.projectId === projectId)) client.refresh('project-restored')
    }
  }

  registerProject(projectId: string, telemetry?: RealtimeTelemetry): RealtimePublisher {
    if (this.closed || !isRealtimeTopic({ kind: 'sessions', projectId }) || this.projects.has(projectId)) {
      throw new TypeError('Invalid or duplicate realtime project')
    }
    const project: Project = { telemetry, tails: new Map() }
    this.projects.set(projectId, project)
    for (const client of this.clients) {
      if (client.topics.some(topic => topic.projectId === projectId)) client.refresh('project-restored')
    }
    const active = () => !this.closed && this.projects.get(projectId) === project
    return {
      chat: (sessionId, payload, requestId) => {
        if (active()) this.publish({ kind: 'chat', projectId, sessionId }, payload, requestId)
      },
      invalidateSessions: (sessionId, completedTurnId) => {
        if (active()) this.publish({ kind: 'sessions', projectId }, { event: 'invalidate', sessionId, ...(completedTurnId ? { completedTurnId } : {}) })
      },
      invalidateActivity: sessionId => {
        if (active()) this.publish({ kind: 'sessions', projectId }, { event: 'activity', sessionId })
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
            client.refresh('project-removed')
            continue
          }
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
    this.journal.push({ sequence: this.sequence, projectId: topic.projectId, key, frame })
    this.journalBytes += frame.byteLength
    while (this.journal.length > this.options.journalCount || this.journalBytes > this.options.journalBytes) {
      const removed = this.journal.shift()!
      this.journalBytes -= removed.frame.byteLength
      this.replayFloor = Math.max(this.replayFloor, removed.sequence)
    }
    for (const client of this.clients) if (client.keys.has(key)) client.send(frame)
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
      tail = { count: 0, timer }
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

  connect(topics: RealtimeTopic[], signal: AbortSignal, cursor?: string): Response {
    if (this.closed) return Response.json({ error: 'realtime_stopping' }, { status: 503 })
    // Also validate direct callers; the HTTP route is not the trust boundary.
    topics = parseRealtimeTopics(JSON.stringify(topics))
    if (topics.some(topic => topic.kind !== 'projects' && !this.projects.has(topic.projectId) && !this.options.projectExists(topic.projectId))) {
      return Response.json({ error: 'unknown_realtime_project' }, { status: 404 })
    }
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
    if (!reason && topics.some(topic => (topic.kind === 'logs' || topic.kind === 'spans')
      && !this.projects.get(topic.projectId)?.tails.has(topic.kind))) reason = 'expired'
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
            if (entry.sequence > after && client.keys.has(entry.key)) client.send(entry.frame)
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

export function registerRealtimeRoute(app: Hono, hub: RealtimeHub, authorize: (request: Request) => boolean | Promise<boolean>): void {
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
