import { parseSessionName } from './session-name.ts'

export class TopicMetadataError extends TypeError {}

/** Read compatibility only; new sessions still cannot request the retired role. */
export function normalizeStoredTopicSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  if (record.sessionKind !== 'orchestrator') return record
  const normalized = { ...record }
  delete normalized.sessionKind
  if (normalized.agentType === 'orchestrator') normalized.agentType = 'general'
  return normalized
}

export function parseTopicSessionFields(value: {
  sessionKind?: unknown; topic?: unknown; createdBySessionId?: unknown; topicRequestHash?: unknown
}): { sessionKind?: 'topic'; topic?: string; createdBySessionId?: string; topicRequestHash?: string } {
  if (value.sessionKind !== undefined && value.sessionKind !== 'topic') {
    throw new TopicMetadataError('Invalid session kind')
  }
  if (value.createdBySessionId !== undefined && (typeof value.createdBySessionId !== 'string'
    || !value.createdBySessionId.trim() || value.createdBySessionId.length > 1024)) {
    throw new TopicMetadataError('Invalid topic creator session ID')
  }
  if (value.topicRequestHash !== undefined && (typeof value.topicRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.topicRequestHash))) {
    throw new TopicMetadataError('Invalid topic request hash')
  }
  return {
    ...(value.sessionKind === undefined ? {} : { sessionKind: value.sessionKind }),
    ...(value.topic === undefined ? {} : { topic: parseSessionName(value.topic) }),
    ...(value.createdBySessionId === undefined ? {} : { createdBySessionId: value.createdBySessionId as string }),
    ...(value.topicRequestHash === undefined ? {} : { topicRequestHash: value.topicRequestHash as string }),
  }
}
