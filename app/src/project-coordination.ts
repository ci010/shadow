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

/** Keep app review links inside the authenticated workbench, including native/hash hosts. */
export function conversationMicroAppLink(href: string, projectId: string): { path: string; query: { microApp: string } } | undefined {
  const match = /^(#?)(\/projects\/[^?#]+)\?([^#]+)$/.exec(href)
  if (!match || !conversationLinkSession(match[2]!, projectId)) return undefined
  const query = new URLSearchParams(match[3])
  const ids = query.getAll('microApp')
  if (ids.length !== 1 || !ids[0] || !/^[a-zA-Z0-9_-]+$/.test(ids[0])) return undefined
  return { path: match[2]!, query: { microApp: ids[0] } }
}
