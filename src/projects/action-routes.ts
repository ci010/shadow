import { z } from 'zod'
import type { Context } from 'hono'
import type { GatewayPlugin } from '../gateway/types.ts'
import { FolderError } from '../folders/registry.ts'
import type { ProjectActions } from './actions.ts'

export function projectActionsPlugin(actions: ProjectActions, authorize: (request: Request) => boolean | Promise<boolean>): GatewayPlugin {
  const guarded = (handler: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store')
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 403)
    try { return await handler(c) } catch (error) {
      if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
      if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400)
      if (error instanceof z.ZodError) return c.json({ error: 'invalid_action' }, 400)
      console.error('[actions] Request failed', error)
      return c.json({ error: 'action_request_failed' }, 500)
    }
  }
  return app => {
    app.get('/api/actions', guarded(c => c.json({ actions: actions.list() })))
    app.post('/api/actions', guarded(async c => c.json({ action: await actions.create(await c.req.json()) }, 201)))
    app.get('/api/actions/scripts', guarded(async c => c.json(await actions.scripts(c.req.query('folderId') ?? ''))))
    app.get('/api/actions/runs', guarded(c => c.json({ runs: actions.runs() })))
    app.get('/api/actions/runs/:runId', guarded(c => c.json({ run: actions.getRun(c.req.param('runId')!) })))
    app.post('/api/actions/runs/:runId/stop', guarded(async c => c.json({ run: await actions.stop(c.req.param('runId')!) })))
    app.post('/api/actions/:id/run', guarded(async c => c.json({ run: await actions.run(c.req.param('id')!) }, 202)))
    app.patch('/api/actions/:id', guarded(async c => c.json({ action: await actions.patch(c.req.param('id')!, await c.req.json()) })))
    app.delete('/api/actions/:id', guarded(async c => { await actions.delete(c.req.param('id')!); return c.json({ deletedActionId: c.req.param('id')! }) }))
  }
}
