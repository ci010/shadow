import type { ProjectionTopic, ProjectionSnapshot } from './projection-wire.ts'
import { isRealtimeTopic, realtimeTopicKey, REALTIME_MAX_TOPICS, REALTIME_MAX_TOPICS_BYTES, type RealtimeEnvelope, type RealtimeTopic } from './protocol.ts'

export const REALTIME_SUBSCRIBE_BYTES = REALTIME_MAX_TOPICS_BYTES * 2
export type RealtimeSubscription = { topic: RealtimeTopic; cursor?: string; conversation?: true; snapshot?: true }
export type RealtimeSubscriptionCommand = { type: 'subscribe'; id: number; subscriptions: RealtimeSubscription[] }
export function parseRealtimeSocketCommand(text: string) {
  if (Buffer.byteLength(text) > REALTIME_SUBSCRIBE_BYTES) throw new TypeError('Subscription frame too large')
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.type !== 'openConversation') return parseRealtimeSubscription(text)
  const command = parseRealtimeSubscription(JSON.stringify({ ...value, type: 'subscribe' }))
  const selected = new Set(command.subscriptions.map(entry => realtimeTopicKey(entry.topic)))
  if (!Array.isArray(value.conversations) || !value.conversations.length || value.conversations.length > selected.size ||
    !value.conversations.every(topic => isRealtimeTopic(topic) && topic.kind === 'chat' && selected.has(realtimeTopicKey(topic)))) {
    throw new TypeError('Invalid openConversation topics')
  }
  const conversations = value.conversations as Extract<RealtimeTopic, { kind: 'chat' }>[]
  if (new Set(conversations.map(realtimeTopicKey)).size !== conversations.length) throw new TypeError('Duplicate conversation')
  return { ...command, conversations }
}

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
  projectionSnapshots?: true
  projections?: Array<{ topic: ProjectionTopic; snapshot?: ProjectionSnapshot; error?: string }>
  conversationOpen?: true
  socketPresence?: true
  conversations?: Array<{ topic: RealtimeTopic; data?: unknown; error?: string }>
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
      (entry.snapshot !== undefined && entry.snapshot !== true) ||
      (entry.conversation !== undefined && (entry.conversation !== true || entry.topic.kind !== 'chat')) ||
      (entry.cursor !== undefined && (typeof entry.cursor !== 'string' || entry.cursor.length > 128))) {
      throw new TypeError('Invalid subscription')
    }
    const key = realtimeTopicKey(entry.topic)
    if (keys.has(key)) throw new TypeError('Duplicate subscription topic')
    keys.add(key)
    subscriptions.push({ topic: entry.topic, cursor: entry.cursor, ...(entry.conversation ? { conversation: true } : {}), ...(entry.snapshot ? { snapshot: true } : {}) })
  }
  if (Buffer.byteLength(JSON.stringify(subscriptions.map(entry => entry.topic))) > REALTIME_MAX_TOPICS_BYTES) {
    throw new TypeError('Subscription topic set too large')
  }
  return { id: value.id, subscriptions }
}
