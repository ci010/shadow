/** Backend/renderer wire contract. New subscriptions require authoritative HTTP
 * snapshots even when the connection cursor can be replayed. Persisted history,
 * not token deltas, is authoritative after a reset or completed turn. */
export type RealtimeTopic =
  | { kind: 'projects'; projectId?: never }
  | { kind: 'chat'; projectId: string; sessionId: string }
  | { kind: 'sessions' | 'logs' | 'spans' | 'io' | 'integrations'; projectId: string }

export type RealtimeEnvelope =
  | { type: 'event'; cursor: string; topic: RealtimeTopic; payload: unknown; requestId?: string }
  | { type: 'ready' | 'heartbeat'; cursor: string }
  | { type: 'unavailable'; cursor: string; topics: RealtimeTopic[] }
  | { type: 'reset'; cursor: string; reason: 'initial' | 'expired' | 'epoch' | 'invalid' | 'project-removed' | 'project-restored' }

export const REALTIME_MAX_TOPICS = 128
export const REALTIME_MAX_TOPICS_BYTES = 32 * 1024

export interface RealtimeTurnFinishedPayload {
  event: 'turn_finished'
  done: true
  status: 'completed' | 'failed' | 'cancelled'
  turnId: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifier(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

export function isRealtimeTopic(value: unknown): value is RealtimeTopic {
  if (!record(value)) return false
  if (value.kind === 'projects') return Object.keys(value).every(key => key === 'kind')
  if (!identifier(value.projectId, 128)) return false
  if (value.kind === 'chat') return identifier(value.sessionId, 512) &&
    Object.keys(value).every(key => ['kind', 'projectId', 'sessionId'].includes(key))
  return ['sessions', 'logs', 'spans', 'io', 'integrations'].includes(value.kind as string) &&
    Object.keys(value).every(key => ['kind', 'projectId'].includes(key))
}

export function realtimeTopicKey(topic: RealtimeTopic): string {
  if (topic.kind === 'projects') return JSON.stringify(['projects'])
  return JSON.stringify([topic.projectId, topic.kind, topic.kind === 'chat' ? topic.sessionId : ''])
}

export function parseRealtimeTopics(input: string | undefined): RealtimeTopic[] {
  if (input === undefined || new TextEncoder().encode(input).byteLength > REALTIME_MAX_TOPICS_BYTES) {
    throw new TypeError('topics must be a JSON array of at most 32 KiB')
  }
  const value: unknown = JSON.parse(input)
  if (!Array.isArray(value) || value.length > REALTIME_MAX_TOPICS || !value.every(isRealtimeTopic)) {
    throw new TypeError('Invalid realtime topics (maximum 128)')
  }
  return [...new Map(value.map(topic => [realtimeTopicKey(topic), topic])).values()]
}

export function isRealtimeCursor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  const match = /^([A-Za-z0-9-]{1,64}):(0|[1-9]\d*)$/.exec(value)
  return !!match && Number.isSafeInteger(Number(match[2]))
}

export function isRealtimeEnvelope(value: unknown): value is RealtimeEnvelope {
  if (!record(value) || !isRealtimeCursor(value.cursor)) return false
  if (value.type === 'ready' || value.type === 'heartbeat') return true
  if (value.type === 'unavailable') return Array.isArray(value.topics) && value.topics.length <= REALTIME_MAX_TOPICS
    && value.topics.every(isRealtimeTopic) && new TextEncoder().encode(JSON.stringify(value.topics)).byteLength <= REALTIME_MAX_TOPICS_BYTES
  if (value.type === 'reset') return ['initial', 'expired', 'epoch', 'invalid', 'project-removed', 'project-restored'].includes(value.reason as string)
  return value.type === 'event' && isRealtimeTopic(value.topic) && 'payload' in value &&
    (value.requestId === undefined || identifier(value.requestId, 512))
}
