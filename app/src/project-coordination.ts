export const ORCHESTRATOR_SESSION_ID = 'web:orchestrator'

export interface TopicMetadata {
  title: string
  goal: string
  scope: string
  nonGoals?: string
}

export function parseTopicMetadata(value: unknown): TopicMetadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('title' in value) || typeof value.title !== 'string'
    || !('goal' in value) || typeof value.goal !== 'string'
    || !('scope' in value) || typeof value.scope !== 'string'
    || ('nonGoals' in value && value.nonGoals !== undefined && typeof value.nonGoals !== 'string')) {
    throw new Error('Cannot read topic metadata. Refresh conversations to retry.')
  }
  return { title: value.title, goal: value.goal, scope: value.scope,
    ...('nonGoals' in value && typeof value.nonGoals === 'string' ? { nonGoals: value.nonGoals } : {}) }
}

export function isDirectConversation(sessionId: string, mode?: string): boolean {
  return (sessionId.startsWith('web:chat-') || sessionId === ORCHESTRATOR_SESSION_ID)
    && mode !== 'task' && mode !== 'call'
}

/** Only explicit same-Project app paths are intercepted; external links stay external. */
export function conversationLinkSession(href: string, projectId: string): string | undefined {
  const match = /^(?:#)?\/projects\/([^/?#]+)\/chat\/([^/?#]+)$/.exec(href)
  if (!match) return undefined
  try {
    const id = decodeURIComponent(match[2]!)
    return decodeURIComponent(match[1]!) === projectId && id && !/[\/\\\u0000-\u001f]/.test(id) ? id : undefined
  } catch { return undefined }
}
