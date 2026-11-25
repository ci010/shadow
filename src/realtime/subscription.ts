import { isRealtimeTopic, realtimeTopicKey, REALTIME_MAX_TOPICS, REALTIME_MAX_TOPICS_BYTES, type RealtimeEnvelope, type RealtimeTopic } from './protocol.ts'

export const REALTIME_SUBSCRIBE_BYTES = REALTIME_MAX_TOPICS_BYTES * 2
export type RealtimeSubscription = { topic: RealtimeTopic; cursor?: string }
export type RealtimeSubscriptionCommand = { type: 'subscribe'; id: number; subscriptions: RealtimeSubscription[] }
export type RealtimeTopicReset = {
  type: 'topic-reset'; cursor: string; topics: RealtimeTopic[]
  reason: 'project-removed' | 'project-restored'; unavailable: RealtimeTopic[]
}
export type RealtimeSubscriptionAck = {
  type: 'subscribed'; id: number; cursor: string
  added: Array<{
    topic: RealtimeTopic
    reason?: Extract<RealtimeEnvelope, { type: 'reset' }>['reason']
    unavailable?: true
  }>
  removed: RealtimeTopic[]
  rejected: RealtimeTopic[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseRealtimeSubscription(text: string): { id: number; subscriptions: RealtimeSubscription[] } {
  if (Buffer.byteLength(text) > REALTIME_SUBSCRIBE_BYTES) throw new TypeError('Subscription frame too large')
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.type !== 'subscribe' || typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) || value.id < 0 || !Array.isArray(value.subscriptions) ||
    value.subscriptions.length > REALTIME_MAX_TOPICS) throw new TypeError('Invalid subscription frame')
  const subscriptions: RealtimeSubscription[] = []
  const keys = new Set<string>()
  for (const entry of value.subscriptions as unknown[]) {
    if (!record(entry) || !isRealtimeTopic(entry.topic) ||
      (entry.cursor !== undefined && (typeof entry.cursor !== 'string' || entry.cursor.length > 128))) {
      throw new TypeError('Invalid subscription')
    }
    const key = realtimeTopicKey(entry.topic)
    if (keys.has(key)) throw new TypeError('Duplicate subscription topic')
    keys.add(key)
    subscriptions.push({ topic: entry.topic, cursor: entry.cursor })
  }
  if (Buffer.byteLength(JSON.stringify(subscriptions.map(entry => entry.topic))) > REALTIME_MAX_TOPICS_BYTES) {
    throw new TypeError('Subscription topic set too large')
  }
  return { id: value.id, subscriptions }
}
