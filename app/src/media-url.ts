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
  download = false,
): string | null {
  if (
    path.startsWith('http://') || path.startsWith('https://') ||
    /^data:image\//i.test(path)
  ) return path
  if (/^data:/i.test(path)) return null

  const chatId = chatIdForMediaSession(sessionId)
  if (!sessionId || (!chatId && !sessionId.includes(':'))) return null

  const url = apiUrl(apiBase, '/api/media')
  url.searchParams.set(chatId ? 'chatId' : 'sessionId', chatId ?? sessionId)
  url.searchParams.set('path', path)
  if (download) url.searchParams.set('download', '1')
  return url.toString()
}