import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'

/** Ephemeral invitation only. Credential values never pass through this broker. */
export class BotChatSetup {
  private pending = new Map<string, { id: string; sessionId: string; expiresAt: number; finish: (status: string) => void }>()
  constructor(readonly projectId: string) {}
  request(sessionId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.pending.has(sessionId)) throw new Error('Bot setup is already open in this chat.')
    return new Promise(resolve => {
      const id = randomUUID()
      const finish = (status: string) => {
        if (this.pending.get(sessionId)?.id !== id) return
        this.pending.delete(sessionId)
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve(JSON.stringify({ status }))
      }
      const abort = () => finish('cancelled')
      const timer = setTimeout(() => finish('expired'), 10 * 60_000)
      timer.unref()
      this.pending.set(sessionId, { id, sessionId, expiresAt: Date.now() + 10 * 60_000, finish })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  get(sessionId: string) {
    const request = this.pending.get(sessionId)
    return request ? { id: request.id, sessionId, projectId: this.projectId, expiresAt: request.expiresAt } : null
  }
  finish(sessionId: string, id: string, status: 'closed' | 'cancelled') {
    const request = this.pending.get(sessionId)
    if (!request || request.id !== id) throw new Error('Stale setup request')
    request.finish(status)
  }
  stop() { for (const request of this.pending.values()) request.finish('cancelled') }
}

export function botChatSetupPlugin(setup: BotChatSetup, authorize: (request: Request) => boolean | Promise<boolean>): GatewayPlugin {
  return app => {
    app.use('/api/bot-chat-setup/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
    app.use('/api/bot-chat-setup/*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'request_too_large' }, 413) }))
    app.get('/api/bot-chat-setup/request', c => c.json({ request: setup.get(c.req.query('sessionId') ?? '') }))
    app.post('/api/bot-chat-setup/request', async c => {
      const input = z.object({ sessionId: z.string().max(200), id: z.string().uuid(), status: z.enum(['closed', 'cancelled']) }).strict().safeParse(await c.req.json().catch(() => null))
      if (!input.success) return c.json({ error: 'invalid_request' }, 400)
      try { setup.finish(input.data.sessionId, input.data.id, input.data.status); return c.json({ closed: true }) }
      catch { return c.json({ error: 'stale_request' }, 409) }
    })
  }
}
