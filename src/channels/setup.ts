import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import type { Config } from '../config/schema.ts'
import { ConfigStore, REDACTED_SECRET } from '../config/store.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { CHANNEL_IDS, type ChannelId, type ChannelSetupStatus, type ChannelState } from './setup-contract.ts'

const labels: Record<ChannelId, string> = { qq: 'QQ', feishu: 'Feishu', discord: 'Discord' }
export const secretFields: Record<ChannelId, readonly string[]> = {
  qq: ['secret', 'token'],
  feishu: ['appSecret', 'encryptKey', 'verificationToken'],
  discord: ['token'],
}
const publicFields: Record<ChannelId, readonly string[]> = {
  qq: ['appId', 'sandbox', 'intents', 'markdown', 'triggerMode', 'allowFrom', 'adminChats', 'trustedChats'],
  feishu: ['appId', 'allowFrom', 'adminChats', 'trustedChats'],
  discord: ['triggerMode', 'reactionEmoji', 'memberIntent', 'allowFrom', 'adminChats', 'trustedChats'],
}
const text = z.string().max(16_384).refine((value) => !/[\x00-\x1f]/.test(value))
const secret = text.refine((value) => value.trim().length > 0 && value !== REDACTED_SECRET)
const common = {
  enabled: z.boolean().optional(),
  allowFrom: z.array(text.refine((value) => value.trim().length > 0)).max(1000).optional(),
  adminChats: z.array(text.refine((value) => value.trim().length > 0)).max(1000).optional(),
  trustedChats: z.array(text.transform(value => value.trim()).pipe(z.string().min(1))).max(1000).optional(),
}
export const channelPatchSchemas = {
  qq: z.object({
    ...common, appId: text.optional(), secret: secret.optional(), token: secret.optional(),
    sandbox: z.boolean().optional(), intents: z.number().int().min(0).max(0xffffffff).optional(),
    markdown: z.boolean().optional(), triggerMode: z.enum(['all', 'mention']).optional(),
  }).strict(),
  feishu: z.object({
    ...common, appId: text.optional(), appSecret: secret.optional(),
    encryptKey: secret.optional(), verificationToken: secret.optional(),
  }).strict(),
  discord: z.object({
    ...common, token: secret.optional(), triggerMode: z.enum(['all', 'mention']).optional(),
    reactionEmoji: text.refine((value) => value.length <= 100).optional(),
    memberIntent: z.boolean().optional(),
  }).strict(),
}
const envelope = z.object({ config: z.record(z.unknown()) }).strict()

export function isChannelId(value: string): value is ChannelId {
  return CHANNEL_IDS.some((id) => id === value)
}

export function channelConfigured(id: ChannelId, config: Config['channels']): boolean {
  const entry = config[id]
  if (!entry) return false
  if (id === 'qq') return !!config.qq?.appId?.trim() && !!config.qq?.secret?.trim()
  if (id === 'feishu') return !!config.feishu?.appId?.trim() && !!config.feishu?.appSecret?.trim()
  return !!config.discord?.token?.trim()
}

export function channelSetupStatus(
  id: ChannelId,
  channels: Config['channels'],
  health?: { state: ChannelState; message?: string },
): ChannelSetupStatus {
  const entry: Record<string, unknown> = channels[id] ?? {}
  const config: ChannelSetupStatus['config'] = {}
  for (const field of publicFields[id]) {
    const value = entry[field]
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      config[field] = value
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      config[field] = [...value]
    }
  }
  const enabled = entry.enabled === true
  const configured = channelConfigured(id, channels)
  return {
    id, label: labels[id], enabled, configured,
    state: health?.state === 'restart-required' ? health.state
      : !enabled ? 'disabled' : !configured ? 'unconfigured' : health?.state ?? 'disconnected',
    ...(health?.message ? { message: health.message } : {}),
    config,
    secrets: Object.fromEntries(secretFields[id].map((field) => [field,
      typeof entry[field] === 'string' && entry[field].trim().length > 0])),
  }
}

export class ChannelSetupError extends Error {
  constructor(readonly code: string, readonly status: 400 | 503 = 400) {
    super(code)
  }
}

export interface ChannelSetupRuntime {
  status(id: ChannelId): ChannelSetupStatus
  updateChannel(id: ChannelId, persist: (active: Config) => Promise<Config>): Promise<ChannelSetupStatus>
}

export function channelSetupPlugin(options: {
  store: ConfigStore
  runtime: ChannelSetupRuntime
  authorize: (request: Request) => boolean | Promise<boolean>
}): GatewayPlugin {
  return (app) => {
    app.use('/api/channels/*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      if (!await options.authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401)
      await next()
    })
    app.use('/api/channels/*', bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'channel_config_too_large' }, 413),
    }))
    app.get('/api/channels', (c) =>
      c.json({ channels: CHANNEL_IDS.map((id) => options.runtime.status(id)) }))
    app.patch('/api/channels/:id', async (c) => {
      const id = c.req.param('id')
      if (!isChannelId(id)) return c.json({ error: 'unknown_channel' }, 404)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }
      const input = envelope.safeParse(body)
      const patch = input.success ? channelPatchSchemas[id].safeParse(input.data.config) : undefined
      if (!patch?.success) return c.json({ error: 'invalid_channel_config' }, 400)
      try {
        const channel = await options.runtime.updateChannel(id, (active) => options.store.update((raw) => {
          const channels = z.record(z.unknown()).parse(raw.channels ?? {})
          const previous = z.record(z.unknown()).parse(channels[id] ?? {})
          const updated: Record<string, unknown> = { ...previous, ...patch.data }
          const effective: Record<string, unknown> = { ...active.channels[id], ...updated }
          if (effective.enabled) {
            const required = id === 'discord' ? ['token']
              : id === 'qq' ? ['appId', 'secret'] : ['appId', 'appSecret']
            if (required.some((field) => typeof effective[field] !== 'string' || !effective[field].trim())) {
              throw new ChannelSetupError('channel_credentials_required')
            }
          }
          return { ...raw, channels: { ...channels, [id]: updated } }
        }, c.req.raw.signal))
        return c.json({ channel })
      } catch (error) {
        if (error instanceof ChannelSetupError) return c.json({ error: error.code }, error.status)
        return c.json({ error: 'channel_save_failed' }, 500)
      }
    })
  }
}
