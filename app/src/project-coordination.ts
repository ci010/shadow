import { t } from './i18n.ts'

/** Canonical session topic is plain text, never an instructions object. */
export function parseConversationTopic(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(t('Cannot read topic metadata. Refresh conversations to retry.'))
  return value
}

export function isDirectConversation(sessionId: string, mode?: string): boolean {
  return sessionId.startsWith('web:chat-')
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
