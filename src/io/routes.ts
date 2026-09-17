import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { IO_MAX_BUFFER_BYTES, IoError } from './contracts.ts'
import type { IoBroker } from './broker.ts'
import { IO_EVENT_MAX_BYTES } from './relay.ts'

const identity = z.object({
  clientId: z.string().uuid(),
  clientToken: z.string().uuid(),
  leaseToken: z.string().uuid(),
}).strict()
const prepare = identity.omit({ leaseToken: true }).extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
const start = identity.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
const stop = z.object({
  status: z.enum(['completed', 'cancelled', 'failed', 'denied']),
  error: z.string().max(2000).optional(),
}).strict()

export function registerIoRoutes(parent: Hono, broker: IoBroker, authorize: (request: Request) => boolean | Promise<boolean>): void {
  const app = new Hono()
  let uploads = 0
  app.onError((error, c) => {
    if (error instanceof IoError) return c.json({ error: error.code, message: error.message }, error.status)
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError) {
      return c.json({ error: 'invalid_io_request', message: error.message.slice(0, 2000) }, 400)
    }
    console.error('[io] Request failed', error.message)
    return c.json({ error: 'io_request_failed', message: 'I/O operation failed; consult the project log.' }, 500)
  })
  app.use('/api/io/*', async (c, next) => {
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
    c.header('Cache-Control', 'no-store')
    return next()
  })
  app.get('/api/io/capabilities', c => c.json(broker.capabilities()))
  app.post('/api/io/clients', async c => c.json(broker.registerClient(await limitedJson(c.req.raw)), 201))
  app.post('/api/io/clients/:id/heartbeat', async c => {
    const body = z.object({ clientToken: z.string().uuid() }).strict().parse(await limitedJson(c.req.raw))
    broker.heartbeatClient(c.req.param('id'), body.clientToken)
    return c.json({ ok: true })
  })
  app.get('/api/io/runs', c => c.json({ runs: broker.list(c.req.query('sessionId')) }))
  app.get('/api/io/runs/:id', c => c.json(broker.get(c.req.param('id'), c.req.query('sessionId'))))
  app.get('/api/io/runs/:id/updates', c => {
    const after = c.req.query('after') ?? '0'
    if (!/^(0|[1-9][0-9]*)$/.test(after)) throw new IoError('invalid_cursor', 'Use a non-negative update cursor')
    return c.json(broker.updates(c.req.param('id'), Number(after)))
  })
  app.post('/api/io/runs', async c => {
    const body = z.object({ sessionId: z.string().min(1).max(512), definition: z.unknown() }).strict().parse(await limitedJson(c.req.raw))
    return c.json(await broker.create(body.sessionId, body.definition), 201)
  })
  app.post('/api/io/runs/:id/prepare', async c => {
    const body = prepare.parse(await limitedJson(c.req.raw))
    return c.json(await broker.prepare(c.req.param('id'), body.clientId, body.clientToken, body.revision))
  })
  app.post('/api/io/runs/:id/start', async c => {
    const body = start.parse(await limitedJson(c.req.raw))
    return c.json({ run: await broker.begin(c.req.param('id'), body.clientId, body.clientToken, body.leaseToken, body.revision) })
  })
  app.post('/api/io/runs/:id/heartbeat', async c => {
    const body = identity.parse(await limitedJson(c.req.raw))
    broker.heartbeat(c.req.param('id'), body.clientId, body.clientToken, body.leaseToken)
    return c.json({ ok: true })
  })
  app.post('/api/io/runs/:id/stop', async c => {
    const body = stop.parse(await limitedJson(c.req.raw))
    return c.json({ run: await broker.stop(c.req.param('id'), body.status, body.error) })
  })
  app.post('/api/io/runs/:id/events', async c => {
    if (uploads >= IO_MAX_BUFFER_BYTES / IO_EVENT_MAX_BYTES) throw new IoError('upload_busy', 'The I/O event buffer is full', 429)
    uploads++
    try {
      const body = identity.extend({ event: z.unknown() }).parse(await limitedJson(c.req.raw, IO_EVENT_MAX_BYTES))
      return c.json(await broker.dispatch(c.req.param('id'), body, body.event))
    } finally { uploads-- }
  })
  app.get('/api/io/runs/:id/artifacts/:artifactId', async c => {
    const { path, artifact } = await broker.artifactPath(c.req.param('id'), c.req.param('artifactId'))
    c.header('Content-Type', artifact.mime)
    c.header('Content-Length', String(artifact.size))
    c.header('X-Content-Type-Options', 'nosniff')
    // Media is data, never an application-origin document.
    c.header('Content-Security-Policy', "default-src 'none'; sandbox")
    const fallback = artifact.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
    c.header('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`)
    const stream = createReadStream(path)
    const onAbort = () => { stream.destroy() }
    c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
    stream.once('close', () => c.req.raw.signal.removeEventListener('abort', onAbort))
    if (c.req.raw.signal.aborted) onAbort()
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: c.res.headers })
  })
  parent.route('/', app)
}

async function limitedJson(request: Request, limit = 256 * 1024): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await limitedBytes(request, limit)))
}

async function limitedBytes(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > limit) throw new IoError('body_too_large', 'I/O request exceeds the byte limit', 413)
  if (!request.body) throw new IoError('missing_body', 'Request body is required')
  const reader = request.body.getReader()
  const result = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      if (size + item.value.byteLength > limit) {
        await reader.cancel()
        throw new IoError('body_too_large', 'I/O request exceeds the byte limit', 413)
      }
      result.set(item.value, size)
      size += item.value.byteLength
    }
  } finally { reader.releaseLock() }
  return result.subarray(0, size)
}
