import { createHash, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { AgentCard, formatSSEEvent, formatSSEErrorEvent, SSE_HEADERS } from '@a2a-js/sdk'
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server'
import { A2AError, RequestMalformedError, toJsonRpcError } from '@a2a-js/sdk/errors'
import { A2aService } from './service.ts'
import { resolveA2aSecret } from './config.ts'

const identifier = z.string().max(512)
const historyLength = z.number().int().min(0).max(1000).optional()
const envelope = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1).max(100), params: z.record(z.unknown()).optional(),
}).strict()
const send = z.object({
  tenant: identifier.optional(),
  message: z.object({
    messageId: z.string().min(1).max(256), role: z.union([z.literal('ROLE_USER'), z.literal(1)]),
    contextId: identifier.optional(), taskId: identifier.optional(),
    parts: z.array(z.object({ text: z.string(), mediaType: z.literal('text/plain').optional() }).strict()).min(1).max(32),
    extensions: z.array(z.string()).max(0).optional(), referenceTaskIds: z.array(z.string()).max(0).optional(),
  }).strict(),
  configuration: z.object({
    returnImmediately: z.boolean().optional(), historyLength,
    acceptedOutputModes: z.array(z.string().max(100)).max(32).optional(),
    taskPushNotificationConfig: z.record(z.unknown()).optional(),
  }).strict().optional(),
}).strict()

function validateWireParams(method: string, params: unknown): void {
  if (method === 'SendMessage' || method === 'SendStreamingMessage') { send.parse(params); return }
  if (['GetTask', 'CancelTask', 'SubscribeToTask'].includes(method)) {
    z.object({ id: identifier.min(1), tenant: identifier.optional(), historyLength }).strict().parse(params)
  } else if (method === 'ListTasks') {
    z.object({
      tenant: identifier.optional(), contextId: identifier.optional(), status: z.string().max(100).optional(),
      pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().max(100).optional(),
      historyLength, statusTimestampAfter: z.string().datetime().optional(), includeArtifacts: z.boolean().optional(),
    }).strict().parse(params)
  }
}

export function a2aAuthenticator(callers: Record<string, string>, environment: NodeJS.ProcessEnv = process.env) {
  const credentials = Object.entries(callers).map(([owner, name]) => ({
    owner, digest: createHash('sha256').update(resolveA2aSecret(name, environment)).digest(),
  }))
  if (new Set(credentials.map(value => value.digest.toString('hex'))).size !== credentials.length) {
    throw new Error('A2A callers must use distinct credentials.')
  }
  return (request: Request): string | undefined => {
    const authorization = request.headers.get('authorization') ?? ''
    if (!authorization.startsWith('Bearer ') || authorization.length > 4103) return
    const digest = createHash('sha256').update(authorization.slice(7)).digest()
    return credentials.find(value => timingSafeEqual(value.digest, digest))?.owner
  }
}

export function registerA2aRoutes(app: Hono, service: A2aService | undefined, authenticate: (request: Request) => string | undefined): void {
  const path = '/a2a'
  const cardPath = `${path}/.well-known/agent-card.json`
  for (const route of [path, cardPath]) {
    app.use(route, async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!service) return c.notFound()
      if (!authenticate(c.req.raw)) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' })
      return next()
    })
  }
  app.get(cardPath, async c => c.json(AgentCard.toJSON(await service!.getAgentCard())))
  app.post(path, bodyLimit({ maxSize: 96 * 1024, onError: c => c.json({ error: 'body_too_large' }, 413) }), async c => {
    if (c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json') {
      return c.json({ error: 'content_type_not_supported' }, 415)
    }
    const version = c.req.header('A2A-Version') ?? '0.3'
    try { validateVersion(version, await service!.getAgentCard(), 'JSONRPC') }
    catch (error) { return c.json({ jsonrpc: '2.0', id: null, error: toJsonRpcError(error) }, 400) }
    if (c.req.header('A2A-Extensions')) {
      return c.json({ error: 'extensions_not_supported' }, 400)
    }
    c.header('A2A-Version', '1.0')
    const controller = new AbortController()
    const context = new ServerCallContext({
      user: { isAuthenticated: true, userName: authenticate(c.req.raw)! },
      requestedVersion: version,
      state: new Map([['signal', AbortSignal.any([c.req.raw.signal, controller.signal])]]),
    })
    let body: z.infer<typeof envelope>
    let requestId: string | number | null = null
    try {
      body = envelope.parse(JSON.parse(await c.req.text()))
      requestId = body.id ?? null
      validateWireParams(body.method, body.params)
    } catch {
      return c.json({ jsonrpc: '2.0', id: requestId, error: toJsonRpcError(new RequestMalformedError('Invalid A2A request.')) })
    }
    const handler = new JsonRpcTransportHandler(service!)
    const result = await handler.handle(body, context)
    if (!(Symbol.asyncIterator in result)) return c.json(result)
    for (const [key, value] of Object.entries(SSE_HEADERS)) c.header(key, value)
    return stream(c, async output => {
      output.onAbort(() => controller.abort())
      try {
        for await (const event of result) await output.write(formatSSEEvent(event))
      } catch (error) {
        if (!controller.signal.aborted && !c.req.raw.signal.aborted) {
          if (!(error instanceof A2AError)) console.error('[a2a] Stream failed', error)
          await output.write(formatSSEErrorEvent({ jsonrpc: '2.0', id: null, error: toJsonRpcError(
            error instanceof A2AError ? error : new Error('A2A stream failed.'),
          ) }))
        }
      } finally { controller.abort() }
    })
  })
}
