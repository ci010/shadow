import { ConversationContextsBusyError } from '../sessions/session-manager.ts'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import type { GatewayPlugin } from '../gateway/types.ts'
import type { ChannelManager } from './manager.ts'
import type { BotInstanceStore } from './bot-store.ts'
import { CHANNEL_IDS } from './setup-contract.ts'
import { ChannelSetupError } from './setup.ts'

const displayName = z.string().trim().min(1).max(100)
const createSchema = z.object({
  purpose: z.enum(['personal', 'service']), platform: z.enum(CHANNEL_IDS), displayName, config: z.record(z.unknown()).default({}),
}).strict()
const patchSchema = z.object({
  purpose: z.enum(['personal', 'service']).optional(), displayName: displayName.optional(), config: z.record(z.unknown()).optional(),
}).strict()

/**
 * Mount on an project-local Hono app, never select project from request bodies.
 * GET /api/channels -> { channels: BotInstanceStatus[] }
 * POST /api/channels { platform, displayName, config } -> 201 { channel }
 * PATCH /api/channels/:instanceId { displayName?, config? } -> { channel }
 * DELETE /api/channels/:instanceId -> { deleted: true }
 * Secret fields are omitted from status config; secrets contains presence booleans.
 */
export function botSetupPlugin(options: {
  store: BotInstanceStore
  runtime: ChannelManager
  authorize: (request: Request) => boolean | Promise<boolean>
}): GatewayPlugin {
  return app => {
    if (options.store.projectId !== options.runtime.projectId) throw new TypeError('Bot runtime ownership mismatch')
    app.use('/api/channels/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
    app.use('/api/channels/*', bodyLimit({
      maxSize: 256 * 1024, onError: c => c.json({ error: 'channel_config_too_large' }, 413),
    }))
    app.get('/api/channels/:id/pending-groups', c => c.json({ groups: options.runtime.pendingServiceGroups(c.req.param('id')) }))
    app.get('/api/channels/:id/owner-candidate', c => c.json(options.runtime.ownerCandidate(c.req.param('id'))))
    app.post('/api/channels/:id/owner-challenge', c => {
      try { return c.json(options.runtime.createOwnerChallenge(c.req.param('id'))) }
      catch { return c.json({ error: 'owner_pairing_unavailable' }, 400) }
    })
    app.post('/api/channels/:id/owner-confirm', async c => {
      try {
        const body = z.object({ challenge: z.string() }).strict().parse(await c.req.json())
        await options.runtime.confirmOwner(c.req.param('id'), body.challenge)
        return c.json({ confirmed: true })
      } catch (error) { return c.json({ error: error instanceof ConversationContextsBusyError ? 'bot_context_busy' : 'owner_confirmation_failed' }, error instanceof ConversationContextsBusyError ? 409 : 400) }
    })
    app.delete('/api/channels/:id/owner', async c => {
      try { await options.runtime.revokeOwner(c.req.param('id')); return c.json({ revoked: true }) }
      catch (error) { return c.json({ error: error instanceof ConversationContextsBusyError ? 'bot_context_busy' : 'owner_revocation_failed' }, error instanceof ConversationContextsBusyError ? 409 : 400) }
    })
    app.post('/api/channels/:id/wechat/:operation', async c => {
      const operation = c.req.param('operation')
      if (operation !== 'login' && operation !== 'wait') return c.json({ error: 'unknown_operation' }, 404)
      try { return c.json(await options.runtime.wechatLogin(c.req.param('id'), operation === 'wait') as Record<string, unknown>) }
      catch (error) { return c.json({ error: error instanceof ChannelSetupError ? error.code : 'wechat_login_failed' }, 400) }
    })
    app.get('/api/channels', c => c.json({ channels: options.runtime.botStatuses() }))
    app.on(['POST', 'PATCH', 'DELETE'], ['/api/channels', '/api/channels/:id'], async c => {
      const id = c.req.param('id')
      try {
        if (c.req.method === 'DELETE' && id) {
          await options.runtime.deleteBot(id, c.req.raw.signal)
          return c.json({ deleted: true })
        }
        let body: unknown
        try { body = await c.req.json() } catch { return c.json({ error: 'invalid_json' }, 400) }
        if (c.req.method === 'POST' && !id) {
          const input = createSchema.safeParse(body)
          if (!input.success) return c.json({ error: 'invalid_bot_config' }, 400)
          const channel = await options.runtime.createBot(input.data, c.req.raw.signal)
          return c.json({ channel }, 201)
        }
        if (c.req.method === 'PATCH' && id) {
          const input = patchSchema.safeParse(body)
          if (!input.success) return c.json({ error: 'invalid_bot_config' }, 400)
          return c.json({ channel: await options.runtime.updateBot(id, input.data, c.req.raw.signal) })
        }
        return c.json({ error: 'unsupported_bot_operation' }, 405)
      } catch (error) {
        if (error instanceof ConversationContextsBusyError) return c.json({ error: 'bot_context_busy' }, 409)
        if (error instanceof ChannelSetupError) return c.json({ error: error.code }, error.code === 'unknown_bot' ? 404 : error.status)
        console.error('[bot-setup] Bot configuration operation failed')
        return c.json({ error: 'bot_save_failed' }, 500)
      }
    })
  }
}
