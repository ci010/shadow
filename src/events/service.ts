import { mkdir, writeFile } from 'node:fs/promises'
import type { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import type {
  CreateEventSubscription,
  EventDelivery,
  EventSourceDescriptor,
  EventSubscription,
  EventUrgency,
  SystemEvent,
} from './types.ts'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'

const SUBSCRIPTIONS_FILE = '.events/subscriptions.json'
const SOURCES_FILE = '.events/sources.json'
const EVENT_PREFIX = 'event:'
const DEFAULT_DEBOUNCE_MS = 30_000

function eventToInbound(
  evt: SystemEvent,
  sub: EventSubscription,
  delivery: EventDelivery,
): InboundMessage {
  const [channel, ...rest] = sub.sessionId.split(':')
  const chatId = rest.join(':')
  const eventType = evt.type.trim() || 'custom'
  const sender = evt.senderId ?? `${EVENT_PREFIX}${eventType}`
  const silent = delivery.urgency === 'silent' || evt.silent === true

  return {
    channel,
    chatId,
    senderId: sender,
    senderName: evt.senderName ?? 'System Event',
    messageId: crypto.randomUUID(),
    content: evt.content ?? '',
    media: evt.media,
    timestamp: evt.timestamp,
    isGroup: evt.isGroup,
    silent,
    eventMeta: {
      __eventDispatch: true,
      source: evt.source,
      'event-id': evt.id,
      // Surfaced to the session's dispatch router (steering / queue / silent).
      // Omitted when the effective urgency is the default 'queue' to keep the
      // rendered <event> tag clean.
      ...(delivery.urgency !== 'queue' ? { urgency: delivery.urgency } : {}),
      ...(evt.meta ?? {}),
    },
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
  /** Trailing-debounce buffers, keyed by `${sessionId}::${coalesceKey}`. */
  private debouncers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; evt: SystemEvent; sub: EventSubscription; delivery: EventDelivery; count: number }
  >()

  constructor(private workspace: string, private bus: Bus) {
    this.subscriptionsPath = workspacePath(workspace, SUBSCRIPTIONS_FILE)
    this.sourcesPath = workspacePath(workspace, SOURCES_FILE)
  }

  async start(): Promise<void> {
    await this.loadSubscriptions()
    await this.loadSources()
    this.registerBuiltinSources()

    // Route channel/user messages and legacy event-prefixed messages.
    this.bus.on('message.inbound', (msg) => {
      if (msg.senderId.startsWith(EVENT_PREFIX)) {
        if (msg.eventMeta?.__eventDispatch === true) return
        const type = msg.senderId.slice(EVENT_PREFIX.length) || 'custom'
        this.emit({
          id: msg.messageId,
          type,
          source: typeof msg.eventMeta?.source === 'string'
            ? msg.eventMeta.source
            : `legacy:${msg.channel}`,
          timestamp: msg.timestamp,
          content: msg.content,
          media: msg.media,
          channel: msg.channel,
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          isGroup: msg.isGroup,
          targetSessionId: `${msg.channel}:${msg.chatId}`,
          silent: msg.silent,
          meta: msg.eventMeta,
        })
        return
      }

      this.emit({
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
        meta: {
          platformMessageId: msg.platformMessageId,
          chatName: msg.chatName,
          admin: msg.admin,
        },
      })
    })
  }

  /** Clear pending debounce timers. Call on shutdown. */
  stop(): void {
    for (const d of this.debouncers.values()) clearTimeout(d.timer)
    this.debouncers.clear()
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
    const source = desc.source.trim()
    if (!source) throw new TypeError('source is required')
    const full: EventSourceDescriptor = {
      ...desc,
      source,
      createdAt: desc.createdAt ?? new Date().toISOString(),
    }
    this.sources.set(source, full)
    if (full.kind !== 'system') this.saveSources().catch(() => {})
    return full
  }

  unregisterSource(source: string): boolean {
    const existing = this.sources.get(source)
    // Built-in sources cannot be removed.
    if (!existing || ['channel', 'cron', 'agent', 'system'].includes(existing.kind) && !existing.ownerSessionId) {
      return false
    }
    const ok = this.sources.delete(source)
    if (ok) this.saveSources().catch(() => {})
    return ok
  }

  listSources(): EventSourceDescriptor[] {
    return Array.from(this.sources.values())
  }

  subscribe(input: CreateEventSubscription): EventSubscription {
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
    this.saveSubscriptions().catch(() => {})
    return sub
  }

  unsubscribe(id: string): boolean {
    const ok = this.subscriptions.delete(id)
    if (ok) this.saveSubscriptions().catch(() => {})
    return ok
  }

  /**
   * Remove any subscriptions linked to the given cron job. Used to clean up
   * orphaned subscriptions when a scheduled (e.g. `once=true`) cron job is
   * removed after firing.
   */
  unsubscribeByCronJob(cronJobId: string): number {
    let removed = 0
    for (const [id, sub] of this.subscriptions) {
      if (sub.cronJobId === cronJobId) {
        this.subscriptions.delete(id)
        removed++
      }
    }
    if (removed > 0) this.saveSubscriptions().catch(() => {})
    return removed
  }

  list(sessionId?: string): EventSubscription[] {
    const all = Array.from(this.subscriptions.values())
    if (!sessionId) return all
    return all.filter((s) => s.sessionId === sessionId)
  }

  emit(evt: Omit<SystemEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): void {
    const full: SystemEvent = {
      ...evt,
      id: evt.id ?? crypto.randomUUID(),
      timestamp: evt.timestamp ?? new Date().toISOString(),
      source: evt.source ?? 'system',
    }

    this.bus.emit('system.event', full)

    const delivered = new Set<string>()

    if (full.targetSessionId) {
      const pseudo: EventSubscription = {
        id: 'target',
        sessionId: full.targetSessionId,
        event: full.type,
        createdAt: full.timestamp,
      }
      this.route(full, pseudo)
      delivered.add(full.targetSessionId)
    }

    for (const sub of this.subscriptions.values()) {
      if (!this.matches(sub, full)) continue
      if (delivered.has(sub.sessionId)) continue
      this.route(full, sub)
      delivered.add(sub.sessionId)
    }
  }

  /**
   * Resolve the effective delivery policy for an event on a given subscription.
   * Precedence: event.delivery → subscription.delivery → source default →
   * `silent` flag → `queue`.
   */
  private resolveDelivery(evt: SystemEvent, sub: EventSubscription): EventDelivery {
    const chosen = evt.delivery ?? sub.delivery ?? this.sources.get(evt.source)?.delivery ??
      (evt.silent ? { urgency: 'silent' as EventUrgency } : { urgency: 'queue' as EventUrgency })
    return chosen
  }

  /** Deliver an event to one session, honoring its effective urgency. */
  private route(evt: SystemEvent, sub: EventSubscription): void {
    const delivery = this.resolveDelivery(evt, sub)
    if (delivery.urgency === 'debounce') {
      this.scheduleDebounced(evt, sub, delivery)
      return
    }
    this.bus.emit('message.inbound', eventToInbound(evt, sub, delivery))
  }

  /**
   * Trailing-debounce: buffer events sharing a coalesce key per session and
   * deliver a single wake (the latest event) once quiet for `debounceMs`.
   */
  private scheduleDebounced(evt: SystemEvent, sub: EventSubscription, delivery: EventDelivery): void {
    const key = delivery.coalesceKey ?? `${evt.type}:${evt.source}`
    const bufKey = `${sub.sessionId}::${key}`
    const windowMs = delivery.debounceMs ?? DEFAULT_DEBOUNCE_MS

    const existing = this.debouncers.get(bufKey)
    if (existing) {
      clearTimeout(existing.timer)
      existing.evt = evt
      existing.sub = sub
      existing.delivery = delivery
      existing.count += 1
      existing.timer = setTimeout(() => this.flushDebounced(bufKey), windowMs)
      return
    }
    const timer = setTimeout(() => this.flushDebounced(bufKey), windowMs)
    this.debouncers.set(bufKey, { timer, evt, sub, delivery, count: 1 })
  }

  private flushDebounced(bufKey: string): void {
    const buf = this.debouncers.get(bufKey)
    if (!buf) return
    this.debouncers.delete(bufKey)
    // Deliver as a normal (queue) wake; annotate how many were coalesced.
    const inbound = eventToInbound(buf.evt, buf.sub, { urgency: 'queue' })
    if (buf.count > 1 && inbound.eventMeta) inbound.eventMeta.coalesced = buf.count
    this.bus.emit('message.inbound', inbound)
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

  private async saveSubscriptions(): Promise<void> {
    await mkdir(workspacePath(this.workspace, '.events'), { recursive: true })
    const arr = Array.from(this.subscriptions.values())
    await writeFile(this.subscriptionsPath, JSON.stringify(arr, null, 2))
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

  private async saveSources(): Promise<void> {
    await mkdir(workspacePath(this.workspace, '.events'), { recursive: true })
    // Persist only non-system (custom/agent) sources; builtins are re-registered on start.
    const arr = Array.from(this.sources.values()).filter((s) => s.kind !== 'system')
    await writeFile(this.sourcesPath, JSON.stringify(arr, null, 2))
  }
}
