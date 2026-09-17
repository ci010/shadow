export interface TopicMetadata {
  title: string
  goal: string
  scope: string
  nonGoals?: string
}

export class TopicMetadataError extends TypeError {}

export function parseTopicMetadata(value: unknown): TopicMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TopicMetadataError('Topic metadata must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['title', 'goal', 'scope', 'nonGoals'].includes(key))) {
    throw new TopicMetadataError('Unknown topic metadata field')
  }
  const text = (key: string, limit: number, nonblank = false): string => {
    const field = record[key]
    if (typeof field !== 'string' || field.length > limit || (nonblank && !field.trim())) {
      throw new TopicMetadataError(`Topic ${key} must be ${nonblank ? 'nonblank ' : ''}text of at most ${limit} characters`)
    }
    return field
  }
  return {
    title: text('title', 160, true),
    goal: text('goal', 4000, true),
    scope: text('scope', 4000),
    ...(record.nonGoals === undefined ? {} : { nonGoals: text('nonGoals', 4000) }),
  }
}

export function parseTopicSessionFields(value: {
  sessionKind?: unknown; topic?: unknown; createdBySessionId?: unknown; topicRequestHash?: unknown
}): { sessionKind?: 'topic' | 'orchestrator'; topic?: TopicMetadata; createdBySessionId?: string; topicRequestHash?: string } {
  if (value.sessionKind !== undefined && value.sessionKind !== 'topic' && value.sessionKind !== 'orchestrator') {
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
    ...(value.topic === undefined ? {} : { topic: parseTopicMetadata(value.topic) }),
    ...(value.createdBySessionId === undefined ? {} : { createdBySessionId: value.createdBySessionId as string }),
    ...(value.topicRequestHash === undefined ? {} : { topicRequestHash: value.topicRequestHash as string }),
  }
}
