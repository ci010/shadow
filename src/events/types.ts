import type { InputOrigin } from '../sessions/input.ts'

/**
 * How urgently an event should reach the target session's agent loop.
 *
 * - `steering` — inject at an active turn's steering checkpoint without
 *   reclassifying the event as a human interrupt.
 * - `queue` — never interrupt an active turn; wait in the inbox and get
 *   handled after the current turn finishes. The default.
 * - `debounce` — coalesce bursts: buffer events sharing a `coalesceKey` and
 *   deliver a single queued wake once the source goes quiet for `debounceMs`.
 * - `silent` — record into session history without invoking the model.
 */
export type EventUrgency = 'steering' | 'queue' | 'debounce' | 'silent'

export interface EventDelivery {
  urgency: EventUrgency
  /**
   * Grouping key for `debounce` coalescing. Defaults to `${type}:${source}`.
   * Events with the same key in the same session collapse into one wake.
   */
  coalesceKey?: string
  /** Trailing debounce window in ms (default 30000). Only used for `debounce`. */
  debounceMs?: number
}

export interface SystemEvent {
  id: string
  type: string
  source: string
  timestamp: string
  content?: string
  media?: string[]
  meta?: Record<string, unknown>
  channel?: string
  chatId?: string
  senderId?: string
  senderName?: string
  isGroup?: boolean
  /** Typed cause of this event; display metadata cannot replace provenance. */
  origin?: InputOrigin
  targetSessionId?: string
  /** Legacy record-only override; wins over any declared delivery policy. */
  silent?: boolean
  /**
   * Delivery policy for this specific event. Takes precedence over the
   * matching subscription's and the source's default policy.
   */
  delivery?: EventDelivery
}

export interface EventSubscription {
  id: string
  sessionId: string
  event: string
  source?: string
  channel?: string
  chatId?: string
  cronJobId?: string
  createdAt: string
  /**
   * Delivery policy applied to events matched by this subscription, unless the
   * event declares its own. Overrides the source's default policy.
   */
  delivery?: EventDelivery
}

export interface CreateEventSubscription {
  sessionId: string
  event: string
  source?: string
  channel?: string
  chatId?: string
  cronJobId?: string
  delivery?: EventDelivery
}

/**
 * A first-class, named producer of events. Sources are discoverable (via
 * `v:events/sources`) and can carry a default {@link EventDelivery} policy so
 * urgency can be declared once per source instead of on every event.
 */
export interface EventSourceDescriptor {
  /** Unique source tag matching {@link SystemEvent.source} (e.g. "cron", "channel:web", "custom:github"). */
  source: string
  /** Category of producer. */
  kind: 'channel' | 'cron' | 'agent' | 'system' | 'custom'
  /** Human-readable description of what this source emits. */
  description?: string
  /** Default delivery policy for events from this source. */
  delivery?: EventDelivery
  /** Session that registered this source (for agent-created sources). */
  ownerSessionId?: string
  createdAt: string
}
