import { apiUrl } from './api-url.ts'
import { isDirectConversation } from './project-coordination.ts'

export function chatIdForMediaSession(sessionId: string): string | null {
  if (!isDirectConversation(sessionId)) return null
  return sessionId.slice('web:'.length)
}

export function buildMediaUrl(
  apiBase: string,
  sessionId: string,
  path: string,
): string | null {
  if (
    path.startsWith('http://') || path.startsWith('https://') ||
    /^data:image\//i.test(path)
  ) return path
  if (path.startsWith('data:')) return null

  const chatId = chatIdForMediaSession(sessionId)
  if (!chatId) return null

  const url = apiUrl(apiBase, '/api/media')
  url.searchParams.set('chatId', chatId)
  url.searchParams.set('path', path)
  return url.toString()
}