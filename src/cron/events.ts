import type { EventDelivery } from '../events/types.ts'

export interface CronEventTarget {
  sessionId: string
}

export interface CronEventPayload {
  type: string
  source?: string
  content?: string
  meta?: Record<string, unknown>
  /** Delivery/urgency policy applied to the emitted event. */
  delivery?: EventDelivery
}

export function isCronEventTarget(value: unknown): value is CronEventTarget {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.sessionId === 'string' && v.sessionId.trim().length > 0
}

export function isCronEventPayload(value: unknown): value is CronEventPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.type !== 'string' || !v.type.trim()) return false
  if (v.source !== undefined && typeof v.source !== 'string') return false
  if (v.content !== undefined && typeof v.content !== 'string') return false
  if (v.meta !== undefined) {
    if (typeof v.meta !== 'object' || v.meta === null || Array.isArray(v.meta)) {
      return false
    }
  }
  return true
}
