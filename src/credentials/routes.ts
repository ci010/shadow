import { z } from 'zod'
import type { Hono } from 'hono'
import type { CredentialStore } from './store.ts'
import { CredentialRequests, CredentialRequestError } from './requests.ts'

export function credentialsPlugin(
  credentials: CredentialStore,
  authorize: (request: Request) => boolean | Promise<boolean>,
  requests?: CredentialRequests,
) {
  const failureStatus = (error: unknown): 400 | 500 => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return 400
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
    console.error('[credentials] Credential persistence failed:', code)
    return 500
  }
  return (app: Hono) => {
    for (const path of ['/api/credential-requests*', '/api/credentials*']) app.use(path, async (context, next) => {
      context.header('Cache-Control', 'no-store')
      await next()
    })
    app.get('/api/credential-requests', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      if (!requests) return context.json({ error: 'Private credential entry is unavailable' }, 503)
      return context.json({ request: requests.pending() })
    })
    app.post('/api/credential-requests/:id', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      if (!requests) return context.json({ error: 'Private credential entry is unavailable' }, 503)
      try {
        const body = await context.req.text()
        if (body.length > 20_000) return context.json({ error: 'Credential request is too large' }, 413)
        const { value } = z.object({ value: z.string() }).strict().parse(JSON.parse(body))
        return context.json({ result: requests.submit(context.req.param('id'), value) })
      } catch (error) {
        if (error instanceof CredentialRequestError) return context.json({ error: error.code, message: error.message }, error.status)
        return context.json({ error: 'Credential could not be stored. Check the value and credential-store availability.' }, failureStatus(error))
      }
    })
    app.delete('/api/credential-requests/:id', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      if (!requests) return context.json({ error: 'Private credential entry is unavailable' }, 503)
      try { return context.json({ result: requests.cancel(context.req.param('id')) }) }
      catch (error) {
        if (error instanceof CredentialRequestError) return context.json({ error: error.code, message: error.message }, error.status)
        return context.json({ error: 'Credential request could not be cancelled.' }, failureStatus(error))
      }
    })
    app.get('/api/credentials', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      return context.json({ names: credentials.names() })
    })
    app.put('/api/credentials/:name', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        const body = await context.req.text()
        if (body.length > 20_000) return context.json({ error: 'Credential request is too large' }, 413)
        const { value } = z.object({ value: z.string() }).strict().parse(JSON.parse(body))
        credentials.put(context.req.param('name'), value)
        return context.json({ stored: true })
      } catch (error) {
        return context.json({ error: 'Credential could not be stored. Check its name, value and credential-store availability.' }, failureStatus(error))
      }
    })
    app.delete('/api/credentials/:name', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        credentials.delete(context.req.param('name'))
        return context.json({ deleted: true })
      } catch (error) { return context.json({ error: 'Credential could not be removed.' }, failureStatus(error)) }
    })
  }
}
