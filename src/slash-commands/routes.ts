import type { Hono } from 'hono'
import type { CommandDispatcher } from './index.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { FolderError } from '../folders/registry.ts'

export function slashCommandsPlugin(
  dispatcher: CommandDispatcher,
  sessions: Pick<SessionManager, 'assertFolderAccess' | 'isManagedConversation'>,
  authorize: (request: Request) => boolean | Promise<boolean>,
) {
  return (app: Hono) => {
    app.get('/api/chat/commands', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      const sessionId = context.req.query('sessionId') ?? ''
      if (sessionId && (!sessionId.startsWith('web:') || sessionId.length <= 4 || sessionId.length > 512 || /[\s\u0000-\u001f\u007f]/.test(sessionId))) {
        return context.json({ error: 'Expected a web conversation session ID.' }, 400)
      }
      try { if (sessionId) sessions.assertFolderAccess(sessionId) }
      catch (error) {
        if (error instanceof FolderError) return context.json({ error: error.code, message: error.message }, error.status)
        throw error
      }
      context.header('Cache-Control', 'no-store')
      const handlers = sessionId && sessions.isManagedConversation(sessionId)
        ? [] : dispatcher.getHandlers({ admin: true, sessionId })
      return context.json({ commands: handlers.map(({ name, description }) => ({ name, description })) })
    })
  }
}
