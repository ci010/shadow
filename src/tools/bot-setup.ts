import { z } from 'zod'
import { assertBotManagementAccess } from '../bots/access.ts'
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
  readonly description = 'Manage current Project Bots from an authorized Web admin chat. Read v:skills/bot-setup first. open waits while the human uses the inline private setup card; no secret arguments, results or owner-confirm action exist. Read v:bots/overview for read-only status first; status remains compatible. create adds a disconnected Bot; connection enables/disables an existing configured Bot.'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'status', 'create', 'connection'] },
    purpose: { type: 'string', enum: ['personal', 'service'] }, platform: { type: 'string', enum: [...CHANNEL_IDS] },
    displayName: { type: 'string' }, id: { type: 'string' }, enabled: { type: 'boolean' },
  }, required: ['action'], additionalProperties: false }
  constructor(private setup: BotChatSetup, private channels: ChannelManager, private assertSession: (sessionId: string) => void) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    assertBotManagementAccess(this.setup.projectId, context, this.assertSession)
    if (this.channels.projectId !== this.setup.projectId) throw new Error('Bot runtime ownership mismatch.')
    const input = argsSchema.parse(args)
    if (input.action === 'status') return JSON.stringify({ bots: this.channels.botStatuses() })
    // Continuations retain read authority, not a direct human management turn.
    if (context.inputSource !== 'user') throw new Error('Bot setup changes require a direct administrator human turn.')
    if (input.action === 'open') return this.setup.request(context.sessionId, context.signal)
    if (input.action === 'create') {
      if (input.platform === 'wechat' && input.purpose !== 'personal') throw new Error('WeChat requires a personal Bot.')
      return JSON.stringify({ bot: await this.channels.createBot({ ...input, config: { enabled: false } }, context.signal) })
    }
    return JSON.stringify({ bot: await this.channels.updateBot(input.id, { config: { enabled: input.enabled } }, context.signal) })
  }
}
