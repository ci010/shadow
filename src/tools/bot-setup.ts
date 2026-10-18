import { z } from 'zod'
import type { BotChatSetup } from '../channels/chat-setup.ts'
import type { ChannelManager } from '../channels/manager.ts'
import { CHANNEL_IDS } from '../channels/setup-contract.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('create'), purpose: z.enum(['personal', 'service']), platform: z.enum(CHANNEL_IDS), displayName: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('connection'), id: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
])

export class BotSetupTool implements Tool {
  readonly name = 'bot_setup'
  readonly supportsRemoteWorkdir = false
  readonly description = 'Manage current Project Bots from an authorized Web admin chat. Read v:skills/bot-setup first. open waits while the human uses the inline private setup card; no secret arguments, results or owner-confirm action exist. status returns redacted status. create adds a disconnected Bot; connection enables/disables an existing configured Bot.'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'status', 'create', 'connection'] },
    purpose: { type: 'string', enum: ['personal', 'service'] }, platform: { type: 'string', enum: [...CHANNEL_IDS] },
    displayName: { type: 'string' }, id: { type: 'string' }, enabled: { type: 'boolean' },
  }, required: ['action'], additionalProperties: false }
  constructor(private setup: BotChatSetup, private channels: ChannelManager, private assertSession: (sessionId: string) => void) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.setup.projectId || this.channels.projectId !== this.setup.projectId ||
      context.admin !== true || context.isGroup || !context.sessionId.startsWith('web:') ||
      !['web', 'virtual'].includes(context.channel) || context.scriptInvocation || context.remoteWorkdir) {
      throw new Error('Bot management requires the owning Project authenticated Web administrator chat.')
    }
    this.assertSession(context.sessionId)
    const input = argsSchema.parse(args)
    if (input.action === 'open') return this.setup.request(context.sessionId, context.signal)
    if (input.action === 'status') return JSON.stringify({ bots: this.channels.botStatuses() })
    if (input.action === 'create') {
      if (input.platform === 'wechat' && input.purpose !== 'personal') throw new Error('WeChat requires a personal Bot.')
      return JSON.stringify({ bot: await this.channels.createBot({ ...input, config: { enabled: false } }, context.signal) })
    }
    return JSON.stringify({ bot: await this.channels.updateBot(input.id, { config: { enabled: input.enabled } }, context.signal) })
  }
}
