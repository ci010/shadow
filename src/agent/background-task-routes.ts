import type { BackgroundTaskManager } from './background-task.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

export function backgroundTasksPlugin(
  tasks: Pick<BackgroundTaskManager, 'listTasks'>,
  sessionExists: (sessionId: string) => boolean | Promise<boolean>,
): GatewayPlugin {
  return app => {
    app.get('/api/sessions/:key/background-tasks', async c => {
      c.header('Cache-Control', 'no-store')
      const sessionId = c.req.param('key')
      if (!sessionId.trim() || !await sessionExists(sessionId)) return c.json({ error: 'session_not_found' }, 404)
      const active = tasks.listTasks(sessionId).filter(task => task.status === 'running' || task.status === 'cancelling')
      return c.json({
        sessionId, total: active.length,
        tasks: active.slice(0, 100).map(task => ({
          id: task.id, sessionId, kind: task.kind, title: task.title.slice(0, 512),
          status: task.status, createdAt: task.createdAt,
        })),
      })
    })
  }
}
