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
 *    Retains only the latest 200 events and fires only when non-empty.
 *    Optionally accepts `init` and `reduce` to fold events into an O(1)
 *    accumulator instead of buffering.
 *
 * 3. **declareQueue(topic), consume(topic)** — opt-in work queues. A declared
 *    queue retains events until exactly one consumer dequeues each event.
 *    Notification-only topics never allocate a consume buffer.
 */

import type { OutboundMessage } from './events.ts'
import type { SystemEvent } from '../events/types.ts'
import type { AcceptedSessionInput, SessionTurnFact } from '../sessions/input.ts'
import type { ChatMessage } from '../providers/provider.ts'

const MAX_BUFFER_SIZE = 200

// ── Topic → payload type map ──────────────────────────────────────────

export interface BusTopics {
  'message.outbound': OutboundMessage
  'system.event': SystemEvent
  'session.handoff': { sessionId: string; sourceSessionId: string; targetSessionId: string }
  'app.lifecycle': { action: 'start' | 'stop' }
  'session.ended': { sessionId: string; agentType?: string }
  'session.renamed': { sessionId: string }
  'session.input.accepted': AcceptedSessionInput
  'session.message.appended': { sessionId: string; physicalSessionId: string; message: ChatMessage }
  'session.turn.finished': SessionTurnFact
  'background.task.changed': { sessionId: string; taskId: string; status: 'running' | 'completed' | 'failed' }
}

// Allow string keys for extensibility (workspace-defined topics)
type TopicKey = keyof BusTopics | (string & {})
type PayloadFor<T> = T extends keyof BusTopics ? BusTopics[T] : unknown

export interface BusObserverError {
  topic: string
  subscriptionId: string
  phase: 'on' | 'poll' | 'poll.reduce' | 'poll.init'
  error: unknown
}

export interface BusOptions {
  /** Reports observer failures (sync or async), never input acceptance. May be async. */
  onError?: (failure: BusObserverError) => void
}

interface ConsumeWaiter {
  resolve: (payload: any) => void
  reject: (reason: unknown) => void
}

// ── Internal handler types ────────────────────────────────────────────

interface OnHandler {
  id: string
  topic: string
  handler: (payload: any) => void
}

/** When `agg` is present the handler uses fold semantics; otherwise it buffers. */
interface PollHandler {
  id: string
  topic: string
  handler: (data: any) => void
  timer: ReturnType<typeof setInterval>

  // Buffer mode (default) — mutually exclusive with agg
  buffer: any[] | null

  // Aggregate mode — present when caller supplies init/reduce
  agg: {
    acc: any
    dirty: boolean
    init: () => any
    reduce: (acc: any, event: any) => any
  } | null
}

// ── Bus ───────────────────────────────────────────────────────────────

export class Bus {
  private onHandlers = new Map<string, OnHandler>()
  private pollHandlers = new Map<string, PollHandler>()
  private consumeWaiters = new Map<string, ConsumeWaiter[]>()
  private consumeBuffers = new Map<string, any[]>()
  private readonly onError: NonNullable<BusOptions['onError']>

  constructor(options: BusOptions = {}) {
    this.onError = options.onError ?? ((failure) => {
      console.error(`[bus] ${failure.phase} observer error (${failure.topic}):`, failure.error)
    })
  }

  private reportError(failure: BusObserverError): void {
    const fallback = (error: unknown) => {
      console.error('[bus] Error reporter failed:', error, 'Original observer failure:', failure)
    }
    try {
      Promise.resolve(this.onError(failure)).catch(fallback)
    } catch (error) {
      fallback(error)
    }
  }

  private observe(
    subscription: { id: string; topic: string },
    phase: BusObserverError['phase'],
    callback: () => unknown,
  ): void {
    const report = (error: unknown) => {
      this.reportError({ topic: subscription.topic, subscriptionId: subscription.id, phase, error })
    }
    try {
      const result = callback()
      if (result !== undefined) Promise.resolve(result).catch(report)
    } catch (error) {
      report(error)
    }
  }

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
        let reset = false
        this.observe(entry, 'poll.init', () => {
          entry.agg!.acc = entry.agg!.init()
          entry.agg!.dirty = false
          reset = true
        })
        if (reset) this.observe(entry, 'poll', () => handler(snapshot))
      } else {
        const buf = entry.buffer!
        if (buf.length === 0) return
        const events = buf.splice(0)
        this.observe(entry, 'poll', () => handler(events))
      }
    }, opts.intervalMs)

    this.pollHandlers.set(id, entry)
    return id
  }

  // ── Queue-based consumption ─────────────────────────────────────────

  /**
   * Declare a work queue before publishing to it. Repeated declarations are safe.
   * Queues retain every event in memory until consumed, even across stopAll().
   * Unlike polling buffers, work queues never discard pending events.
   */
  declareQueue<T extends TopicKey>(topic: T): void {
    if (!this.consumeBuffers.has(topic)) this.consumeBuffers.set(topic, [])
  }

  /** Whether buffered work remains; excludes events already handed to a consumer. */
  hasQueued<T extends TopicKey>(topic: T): boolean {
    return (this.consumeBuffers.get(topic)?.length ?? 0) > 0
  }

  /**
   * Consume the next event for a topic, waiting if none available.
   * Rejects undeclared topics. Waiting consumers and buffered events are FIFO.
   * Aborting a wait or calling stopAll() rejects it without consuming an event.
   */
  consume<T extends TopicKey>(
    topic: T,
    options: { signal?: AbortSignal } = {},
  ): Promise<PayloadFor<T>> {
    const buf = this.consumeBuffers.get(topic)
    if (!buf) {
      return Promise.reject(new Error(
        `[bus] Cannot consume undeclared queue "${topic}"; call declareQueue(topic) before publishing.`,
      ))
    }
    const { signal } = options
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (buf.length > 0) {
      return Promise.resolve(buf.shift()!)
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const waiter: ConsumeWaiter = {
        resolve: (payload) => {
          cleanup()
          resolve(payload)
        },
        reject: (reason) => {
          cleanup()
          reject(reason)
        },
      }
      const abort = () => {
        const waiters = this.consumeWaiters.get(topic)
        const index = waiters?.indexOf(waiter) ?? -1
        if (index < 0) return
        waiters!.splice(index, 1)
        if (waiters!.length === 0) this.consumeWaiters.delete(topic)
        waiter.reject(signal!.reason)
      }
      let waiters = this.consumeWaiters.get(topic)
      if (!waiters) {
        waiters = []
        this.consumeWaiters.set(topic, waiters)
      }
      waiters.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  // ── Publish ─────────────────────────────────────────────────────────

  /**
   * Notify matching observers and enqueue only explicitly declared work topics.
   * Returns no delivery/acceptance result; observer failures go to onError.
   */
  emit<T extends TopicKey>(topic: T, payload: PayloadFor<T>): void {
    // Enqueue first so a reentrant observer cannot reorder work-queue messages.
    const buf = this.consumeBuffers.get(topic)
    if (buf) {
      const waiters = this.consumeWaiters.get(topic)
      const waiter = waiters?.shift()
      if (waiters?.length === 0) this.consumeWaiters.delete(topic)
      if (waiter) waiter.resolve(payload)
      else buf.push(payload)
    }

    // 1. Fire on() handlers immediately
    for (const h of this.onHandlers.values()) {
      if (h.topic !== topic) continue
      this.observe(h, 'on', () => h.handler(payload))
    }

    // 2. Feed poll() handlers (buffer or fold)
    for (const p of this.pollHandlers.values()) {
      if (p.topic !== topic) continue
      if (p.agg) {
        this.observe(p, 'poll.reduce', () => {
          p.agg!.acc = p.agg!.reduce(p.agg!.acc, payload)
          p.agg!.dirty = true
        })
      } else {
        p.buffer!.push(payload)
        if (p.buffer!.length > MAX_BUFFER_SIZE) {
          p.buffer!.splice(0, p.buffer!.length - MAX_BUFFER_SIZE)
        }
      }
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

  /**
   * Stop/remove poll subscriptions and reject pending consume waits (AbortError).
   * Keep on() subscriptions, queue declarations, and pending messages intact;
   * callers may resume consuming after stopAll(). This is not a queue purge.
   */
  stopAll(): void {
    for (const poll of this.pollHandlers.values()) {
      clearInterval(poll.timer)
    }
    this.pollHandlers.clear()
    const pending = [...this.consumeWaiters.values()]
    this.consumeWaiters.clear()
    for (const waiters of pending) {
      for (const waiter of waiters) {
        waiter.reject(new DOMException('Bus consumer stopped', 'AbortError'))
      }
    }
  }
}
