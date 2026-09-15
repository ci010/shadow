import { mkdir, writeFile } from 'node:fs/promises'
import type { Bus } from '../bus/bus.ts'
import { deriveSessionId, type InboundMessage } from '../bus/events.ts'
import type { DeliverInput, InputOrigin, SessionMessageInput } from '../sessions/input.ts'
import type {
  CreateEventSubscription,
  EventDelivery,
  EventSourceDescriptor,
  EventSubscription,
  EventUrgency,
  SystemEvent,
} from './types.ts'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'
import { getOrganizationScope, type OrganizationScope } from '../otel/scope.ts'

const SUBSCRIPTIONS_FILE = '.events/subscriptions.json'
const SOURCES_FILE = '.events/sources.json'
const DEFAULT_DEBOUNCE_MS = 30_000

export function eventToInput(
  evt: SystemEvent,
  delivery: { urgency: Exclude<EventUrgency, 'debounce'> },
): SessionMessageInput {
  return {
    kind: 'message',
    id: crypto.randomUUID(),
    source: {
      kind: 'event',
      eventId: evt.id,
      type: evt.type.trim() || 'custom',
      source: evt.source,
      senderId: evt.senderId,
      senderName: evt.senderName,
      isGroup: evt.isGroup,
      origin: evt.origin,
      attributes: { ...evt.meta },
    },
    content: evt.content ?? '',
    media: evt.media,
    timestamp: evt.timestamp,
    policy: delivery.urgency,
  }
}

/**
 * Session-scoped subscription router for normalized system events.
 */
export class EventService {
  private subscriptions = new Map<string, EventSubscription>()
  private subscriptionsPath: string
  /** Registered event sources, keyed by their `source` tag. */
  private sources = new Map<string, EventSourceDescriptor>()
  private sourcesPath: string
  private stopped = false
  private deliveries = new Set<Promise<void>>()
  private persistenceTail: Promise<void> = Promise.resolve()
  private persistenceErrors = new Map<string, unknown>()
  /** Trailing-debounce buffers, keyed by session and coalescing key. */
  private debouncers = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>
      evt: SystemEvent
      sessionId: string
      count: number
      eventIds: string[]
      origins: InputOrigin[]
    }
  >()

  constructor(
    private workspace: string,
    private bus: Bus,
    private deliver: DeliverInput,
    private scope: OrganizationScope | undefined = getOrganizationScope(),
  ) {
    this.subscriptionsPath = workspacePath(workspace, SUBSCRIPTIONS_FILE)
    this.sourcesPath = workspacePath(workspace, SOURCES_FILE)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.flush()
    await this.loadSubscriptions()
    await this.loadSources()
    this.registerBuiltinSources()
  }

  /** Stop routing immediately, then drain definition writes before workspace cleanup. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const d of this.debouncers.values()) clearTimeout(d.timer)
    this.debouncers.clear()
    await Promise.allSettled(this.deliveries)
    await this.flush()
  }

  /** Await pending definition writes; synchronous mutations remain compatible. */
  async flush(): Promise<void> {
    let pending: Promise<void>
    do {
      pending = this.persistenceTail
      await pending
    } while (pending !== this.persistenceTail)
    if (this.persistenceErrors.size > 0) {
      throw new AggregateError([...this.persistenceErrors.values()], 'Event definition persistence failed')
    }
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('EventService is stopped')
  }

  // ── Event sources ──────────────────────────────────────────────────────

  private registerBuiltinSources(): void {
    const builtins: EventSourceDescriptor[] = [
      { source: 'system', kind: 'system', description: 'Internal system events', createdAt: new Date().toISOString() },
      { source: 'cron', kind: 'cron', description: 'Scheduled cron jobs', createdAt: new Date().toISOString() },
      { source: 'agent', kind: 'agent', description: 'Events emitted by agents via the event tool', createdAt: new Date().toISOString() },
    ]
    for (const b of builtins) {
      // Do not clobber a persisted custom override with the same tag.
      if (!this.sources.has(b.source)) this.sources.set(b.source, b)
    }
  }

  /** Register (or replace) a named event source. Custom sources are persisted. */
  registerSource(desc: Omit<EventSourceDescriptor, 'createdAt'> & { createdAt?: string }): EventSourceDescriptor {
    this.assertRunning()
    const source = desc.source.trim()
    if (!source) throw new TypeError('source is required')
    const full: EventSourceDescriptor = {
      ...desc,
      source,
      createdAt: desc.createdAt ?? new Date().toISOString(),
    }
    this.sources.set(source, full)
    if (full.kind !== 'system') this.saveSources()
    return full
  }

  unregisterSource(source: string): boolean {
    this.assertRunning()
    const existing = this.sources.get(source)
    // Built-in sources cannot be removed.
    if (!existing || ['channel', 'cron', 'agent', 'system'].includes(existing.kind) && !existing.ownerSessionId) {
      return false
    }
    const ok = this.sources.delete(source)
    if (ok) this.saveSources()
    return ok
  }

  listSources(): EventSourceDescriptor[] {
    return Array.from(this.sources.values())
  }

  subscribe(input: CreateEventSubscription): EventSubscription {
    this.assertRunning()
    const event = input.event.trim()
    if (!event) {
      throw new TypeError('event is required')
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    const sub: EventSubscription = {
      id,
      sessionId: input.sessionId,
      event,
      source: input.source,
      channel: input.channel,
      chatId: input.chatId,
      cronJobId: input.cronJobId,
      delivery: input.delivery,
      createdAt: new Date().toISOString(),
    }
    this.subscriptions.set(id, sub)
    this.saveSubscriptions()
    return sub
  }

  unsubscribe(id: string): boolean {
    this.assertRunning()
    const ok = this.subscriptions.delete(id)
    if (ok) this.saveSubscriptions()
    return ok
  }

  /**
   * Remove any subscriptions linked to the given cron job. Used to clean up
   * orphaned subscriptions when a scheduled (e.g. `once=true`) cron job is
   * removed after firing.
   */
  unsubscribeByCronJob(cronJobId: string): number {
    this.assertRunning()
    let removed = 0
    for (const [id, sub] of this.subscriptions) {
      if (sub.cronJobId === cronJobId) {
        this.subscriptions.delete(id)
        removed++
      }
    }
    if (removed > 0) this.saveSubscriptions()
    return removed
  }

  list(sessionId?: string): EventSubscription[] {
    const all = Array.from(this.subscriptions.values())
    if (!sessionId) return all
    return all.filter((s) => s.sessionId === sessionId)
  }

  /** Resolves after directed acceptances (or router-side debounce buffering), not model completion. */
  async emit(evt: Omit<SystemEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): Promise<void> {
    const full: SystemEvent = {
      ...evt,
      id: evt.id ?? crypto.randomUUID(),
      timestamp: evt.timestamp ?? new Date().toISOString(),
      source: evt.source ?? 'system',
    }

    await this.dispatch(full)
  }

  /** Publish once at channel ingress, after accepting the original direct input. */
  async publishChannelMessage(msg: InboundMessage): Promise<void> {
    const origin: InputOrigin = {
      sessionId: deriveSessionId(msg),
      inputId: msg.messageId,
      source: {
        kind: 'user',
        sender: {
          channel: msg.channel,
          chatId: msg.chatId,
          messageId: msg.messageId,
          platformMessageId: msg.platformMessageId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          chatName: msg.chatName,
          isGroup: msg.isGroup,
          admin: msg.admin,
        },
      },
    }
    await this.dispatch({
      id: msg.messageId,
      type: 'channel.message',
      source: `channel:${msg.channel}`,
      timestamp: msg.timestamp,
      content: msg.content,
      media: msg.media,
      channel: msg.channel,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      isGroup: msg.isGroup,
      silent: msg.silent,
      origin,
      meta: {
        ...msg.eventMeta,
        platformMessageId: msg.platformMessageId,
        chatName: msg.chatName,
        admin: msg.admin,
      },
    }, origin.sessionId)
  }

  private async dispatch(full: SystemEvent, excludedSessionId?: string): Promise<void> {
    const operation = () => this.dispatchWithinScope(full, excludedSessionId)
    await this.trackDelivery(this.scope ? this.scope.run(operation) : operation())
  }

  private trackDelivery(pending: Promise<void>): Promise<void> {
    this.deliveries.add(pending)
    void pending.then(() => this.deliveries.delete(pending), () => this.deliveries.delete(pending))
    return pending
  }

  private async dispatchWithinScope(full: SystemEvent, excludedSessionId?: string): Promise<void> {
    this.assertRunning()
    this.bus.emit('system.event', full)

    const delivered = new Set<string>()
    if (excludedSessionId) delivered.add(excludedSessionId)
    const acceptances: Promise<void>[] = []

    if (full.targetSessionId && !delivered.has(full.targetSessionId)) {
      const pseudo: EventSubscription = {
        id: 'target',
        sessionId: full.targetSessionId,
        event: full.type,
        createdAt: full.timestamp,
      }
      acceptances.push(this.route(full, pseudo))
      delivered.add(full.targetSessionId)
    }

    for (const sub of this.subscriptions.values()) {
      if (!this.matches(sub, full)) continue
      if (delivered.has(sub.sessionId)) continue
      acceptances.push(this.route(full, sub))
      delivered.add(sub.sessionId)
    }

    // Independent targets may accept even if another fails; no rollback or exactly-once guarantee.
    const outcomes = await Promise.allSettled(acceptances)
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
    if (failures.length === 1) throw failures[0].reason
    if (failures.length > 1) {
      throw new AggregateError(failures.map((failure) => failure.reason), `Event ${full.id} delivery failed`)
    }
  }

  /**
   * Resolve the effective delivery policy for an event on a given subscription.
   * The legacy record-only flag wins; otherwise event → subscription → source → queue.
   */
  private resolveDelivery(evt: SystemEvent, sub: EventSubscription): EventDelivery {
    if (evt.silent) return { urgency: 'silent' }
    return evt.delivery ?? sub.delivery ?? this.sources.get(evt.source)?.delivery ?? { urgency: 'queue' }
  }

  /** Deliver an event to one session, honoring its effective urgency. */
  private async route(evt: SystemEvent, sub: EventSubscription): Promise<void> {
    this.assertRunning()
    const delivery = this.resolveDelivery(evt, sub)
    if (delivery.urgency === 'debounce') {
      this.scheduleDebounced(evt, sub, delivery)
      return
    }
    await this.deliver(sub.sessionId, eventToInput(evt, { urgency: delivery.urgency }))
  }

  /**
   * Trailing-debounce: buffer events sharing a coalesce key per session and
   * deliver a single wake (the latest event) once quiet for `debounceMs`.
   */
  private scheduleDebounced(evt: SystemEvent, sub: EventSubscription, delivery: EventDelivery): void {
    const key = delivery.coalesceKey ?? `${evt.type}:${evt.source}`
    const bufKey = JSON.stringify([sub.sessionId, key])
    const windowMs = delivery.debounceMs ?? DEFAULT_DEBOUNCE_MS

    const existing = this.debouncers.get(bufKey)
    if (existing) {
      clearTimeout(existing.timer)
      existing.evt = evt
      existing.count += 1
      existing.eventIds.push(evt.id)
      if (evt.origin) existing.origins.push(evt.origin)
      existing.timer = setTimeout(() => { void this.trackDelivery(this.flushDebounced(bufKey)) }, windowMs)
      return
    }
    const timer = setTimeout(() => { void this.trackDelivery(this.flushDebounced(bufKey)) }, windowMs)
    this.debouncers.set(bufKey, {
      timer,
      evt,
      sessionId: sub.sessionId,
      count: 1,
      eventIds: [evt.id],
      origins: evt.origin ? [evt.origin] : [],
    })
  }

  private async flushDebounced(bufKey: string): Promise<void> {
    const buf = this.debouncers.get(bufKey)
    if (!buf || this.stopped) return
    this.debouncers.delete(bufKey)
    let inputId: string | undefined
    try {
      const input = eventToInput(buf.evt, { urgency: 'queue' })
      inputId = input.id
      if (input.source.kind === 'event') {
        input.source.coalesced = { count: buf.count, eventIds: buf.eventIds, origins: buf.origins }
        input.source.attributes = { ...input.source.attributes, coalesced: buf.count }
      }
      await this.deliver(buf.sessionId, input)
    } catch {
      // Error messages can contain provider tokens or payloads; report correlation IDs only.
      console.error('[events] Debounced delivery failed', {
        targetSessionId: buf.sessionId,
        eventId: buf.evt.id,
        inputId,
      })
    }
  }

  private matches(sub: EventSubscription, evt: SystemEvent): boolean {
    if (sub.event !== '*' && sub.event !== evt.type) return false
    if (sub.source && sub.source !== evt.source) return false
    if (sub.channel && sub.channel !== evt.channel) return false
    if (sub.chatId && sub.chatId !== evt.chatId) return false
    if (evt.targetSessionId && evt.targetSessionId !== sub.sessionId) return false
    return true
  }

  private async loadSubscriptions(): Promise<void> {
    const raw = await readFileIfExists(this.subscriptionsPath)
    if (!raw) return
    try {
      const arr = JSON.parse(raw) as EventSubscription[]
      for (const sub of arr) {
        if (!sub?.id || !sub?.event || !sub?.sessionId) continue
        this.subscriptions.set(sub.id, sub)
      }
    } catch {
      console.warn('[events] Failed to parse subscriptions file, starting empty')
    }
  }

  private saveSubscriptions(): void {
    const arr = Array.from(this.subscriptions.values())
    this.persist(SUBSCRIPTIONS_FILE, this.subscriptionsPath, arr)
  }

  private async loadSources(): Promise<void> {
    const raw = await readFileIfExists(this.sourcesPath)
    if (!raw) return
    try {
      const arr = JSON.parse(raw) as EventSourceDescriptor[]
      for (const src of arr) {
        if (!src?.source || !src?.kind) continue
        this.sources.set(src.source, src)
      }
    } catch {
      console.warn('[events] Failed to parse sources file, starting empty')
    }
  }

  private saveSources(): void {
    // Persist only non-system (custom/agent) sources; builtins are re-registered on start.
    const arr = Array.from(this.sources.values()).filter((s) => s.kind !== 'system')
    this.persist(SOURCES_FILE, this.sourcesPath, arr)
  }

  private persist(file: string, path: string, definitions: unknown[]): void {
    const contents = JSON.stringify(definitions, null, 2)
    this.persistenceTail = this.persistenceTail.then(async () => {
      try {
        await mkdir(workspacePath(this.workspace, '.events'), { recursive: true })
        await writeFile(path, contents)
        this.persistenceErrors.delete(file)
      } catch (error) {
        this.persistenceErrors.set(file, error)
        console.error('[events] Failed to persist definitions', { file })
      }
    })
  }
}
