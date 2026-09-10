/**
 * Unified typed event bus.
 *
 * Replaces the separate MessageBus (inbound/outbound messages) and EventBus
 * (system events) with a single topic-based pub/sub system.
 *
 * Three subscription mechanisms:
 *
 * 1. **on(topic, handler)** — fire-based. Handler invoked immediately on each
 *    matching event. No buffering.
 *
 * 2. **poll(topic, opts, handler)** — poll-based. Events buffered internally per
 *    subscription. A periodic timer drains the buffer and invokes the handler.
 *    Only fires when the buffer is non-empty. Optionally accepts `init` and
 *    `reduce` to fold events into an O(1) accumulator instead of buffering.
 *
 * 3. **consume(topic)** — queue-based. Returns a Promise that resolves with the
 *    next event. Exactly one consumer dequeues each event.
 */

import type { InboundMessage, OutboundMessage } from './events.ts'
import type { SystemEvent } from '../events/types.ts'

const MAX_BUFFER_SIZE = 200

// ── Topic → payload type map ──────────────────────────────────────────

export interface BusTopics {
  'message.inbound': InboundMessage
  'message.outbound': OutboundMessage
  'system.event': SystemEvent
  'session.handoff': { sessionId: string; sourceSessionId: string; targetSessionId: string }
  'app.lifecycle': { action: 'start' | 'stop' }
  'session.ended': { sessionId: string; agentType?: string }
}

// Allow string keys for extensibility (workspace-defined topics)
type TopicKey = keyof BusTopics | (string & {})
type PayloadFor<T> = T extends keyof BusTopics ? BusTopics[T] : unknown

// ── Internal handler types ────────────────────────────────────────────

interface OnHandler {
  id: string
  topic: string
  // deno-lint-ignore no-explicit-any
  handler: (payload: any) => void
}

/** When `agg` is present the handler uses fold semantics; otherwise it buffers. */
interface PollHandler {
  id: string
  topic: string
  // deno-lint-ignore no-explicit-any
  handler: (data: any) => void
  timer: ReturnType<typeof setInterval>

  // Buffer mode (default) — mutually exclusive with agg
  // deno-lint-ignore no-explicit-any
  buffer: any[] | null

  // Aggregate mode — present when caller supplies init/reduce
  agg: {
    // deno-lint-ignore no-explicit-any
    acc: any
    dirty: boolean
    // deno-lint-ignore no-explicit-any
    init: () => any
    // deno-lint-ignore no-explicit-any
    reduce: (acc: any, event: any) => any
  } | null
}

// ── Bus ───────────────────────────────────────────────────────────────

export class Bus {
  private onHandlers = new Map<string, OnHandler>()
  private pollHandlers = new Map<string, PollHandler>()
  // deno-lint-ignore no-explicit-any
  private consumeWaiters = new Map<string, Array<(payload: any) => void>>()
  // deno-lint-ignore no-explicit-any
  private consumeBuffers = new Map<string, any[]>()

  // ── Fire-based subscriptions ────────────────────────────────────────

  /**
   * Register a handler invoked immediately on each matching event.
   * @returns Subscription ID (for off()).
   */
  on<T extends TopicKey>(topic: T, handler: (payload: PayloadFor<T>) => void): string {
    const id = crypto.randomUUID()
    this.onHandlers.set(id, { id, topic, handler })
    return id
  }

  // ── Poll-based subscriptions ────────────────────────────────────────

  /**
   * Register a handler invoked periodically with buffered events.
   * Only fires when there are events in the buffer.
   * @returns Subscription ID (for off()).
   */
  poll<T extends TopicKey>(
    topic: T,
    opts: { intervalMs: number },
    handler: (events: PayloadFor<T>[]) => void,
  ): string

  /**
   * Register a handler invoked periodically with an aggregated value.
   * Each event is folded into an accumulator via `reduce`, keeping memory
   * O(1). Only fires when at least one event arrived since the last drain.
   * @returns Subscription ID (for off()).
   */
  poll<T extends TopicKey, TAcc>(
    topic: T,
    opts: {
      intervalMs: number
      init: () => TAcc
      reduce: (acc: TAcc, event: PayloadFor<T>) => TAcc
    },
    handler: (acc: TAcc) => void,
  ): string

  poll<T extends TopicKey, TAcc>(
    topic: T,
    opts: {
      intervalMs: number
      init?: () => TAcc
      reduce?: (acc: TAcc, event: PayloadFor<T>) => TAcc
    },
    // deno-lint-ignore no-explicit-any
    handler: (data: any) => void,
  ): string {
    const id = crypto.randomUUID()
    const useAgg = opts.init !== undefined && opts.reduce !== undefined

    const entry: PollHandler = {
      id,
      topic,
      handler,
      buffer: useAgg ? null : [],
      agg: useAgg
        ? { acc: opts.init!(), dirty: false, init: opts.init!, reduce: opts.reduce! }
        : null,
      timer: undefined!,
    }

    entry.timer = setInterval(() => {
      if (entry.agg) {
        if (!entry.agg.dirty) return
        const snapshot = entry.agg.acc
        entry.agg.acc = entry.agg.init()
        entry.agg.dirty = false
        try {
          handler(snapshot)
        } catch (err) {
          console.error(`[bus] Poll handler error (${topic}):`, err)
        }
      } else {
        const buf = entry.buffer!
        if (buf.length === 0) return
        const events = buf.splice(0)
        try {
          handler(events)
        } catch (err) {
          console.error(`[bus] Poll handler error (${topic}):`, err)
        }
      }
    }, opts.intervalMs)

    this.pollHandlers.set(id, entry)
    return id
  }

  // ── Queue-based consumption ─────────────────────────────────────────

  /**
   * Consume the next event for a topic, waiting if none available.
   * Exactly one consumer dequeues each event (work-queue semantics).
   */
  consume<T extends TopicKey>(topic: T): Promise<PayloadFor<T>> {
    const buf = this.consumeBuffers.get(topic)
    if (buf && buf.length > 0) {
      return Promise.resolve(buf.shift()!)
    }
    return new Promise((resolve) => {
      let waiters = this.consumeWaiters.get(topic)
      if (!waiters) {
        waiters = []
        this.consumeWaiters.set(topic, waiters)
      }
      waiters.push(resolve)
    })
  }

  // ── Publish ─────────────────────────────────────────────────────────

  /**
   * Emit an event to all matching subscribers.
   */
  emit<T extends TopicKey>(topic: T, payload: PayloadFor<T>): void {
    // 1. Fire on() handlers immediately
    for (const h of this.onHandlers.values()) {
      if (h.topic !== topic) continue
      try {
        h.handler(payload)
      } catch (err) {
        console.error(`[bus] on() handler error (${topic}):`, err)
      }
    }

    // 2. Feed poll() handlers (buffer or fold)
    for (const p of this.pollHandlers.values()) {
      if (p.topic !== topic) continue
      if (p.agg) {
        p.agg.acc = p.agg.reduce(p.agg.acc, payload)
        p.agg.dirty = true
      } else {
        p.buffer!.push(payload)
        if (p.buffer!.length > MAX_BUFFER_SIZE) {
          p.buffer!.splice(0, p.buffer!.length - MAX_BUFFER_SIZE)
        }
      }
    }

    // 3. Resolve consume() waiter or buffer
    const waiters = this.consumeWaiters.get(topic)
    const waiter = waiters?.shift()
    if (waiter) {
      waiter(payload)
    } else {
      let buf = this.consumeBuffers.get(topic)
      if (!buf) {
        buf = []
        this.consumeBuffers.set(topic, buf)
      }
      buf.push(payload)
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  /** Remove a subscription by ID (on, poll, or any future type). */
  off(id: string): void {
    if (this.onHandlers.delete(id)) return
    const poll = this.pollHandlers.get(id)
    if (poll) {
      clearInterval(poll.timer)
      this.pollHandlers.delete(id)
      return
    }
  }

  /** Stop all poll timers. Call on graceful shutdown. */
  stopAll(): void {
    for (const poll of this.pollHandlers.values()) {
      clearInterval(poll.timer)
    }
    this.pollHandlers.clear()
  }
}
