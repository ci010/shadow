const DIRECT_WEB_SESSION_PREFIX = 'web:chat-'

export function chatIdForMediaSession(sessionId: string): string | null {
  if (!sessionId.startsWith(DIRECT_WEB_SESSION_PREFIX)) return null
  return sessionId.slice('web:'.length)
}

export function buildMediaUrl(
  apiBase: string,
  sessionId: string,
  path: string,
): string | null {
  if (path.startsWith('http://') || path.startsWith('https://')) return path

  const chatId = chatIdForMediaSession(sessionId)
  if (!chatId) return null

  const url = new URL('/api/media', apiBase)
  url.searchParams.set('chatId', chatId)
  url.searchParams.set('path', path)
  return url.toString()
}