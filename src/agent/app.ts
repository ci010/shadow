import type { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { deriveSessionId } from '../bus/events.ts'
import type { CommandDispatcher } from '../slash-commands/index.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { errDetail } from '../utils/truncate.ts'
import type { AgentTypesManager } from './types/manager.ts'
import type { LlmRuntimeConfig } from './llm-config.ts'
import type { McpManager } from '../mcp/manager.ts'
import type { SkillsManager } from '../skills/loader.ts'
import type { EventService } from '../events/service.ts'
import type { IdentityManager } from './identity.ts'
import { channelMessageInput, type DeliveryReceipt } from '../sessions/input.ts'

export interface AgentOptions {
  identity?: IdentityManager
  bus: Bus
  // ── Pre-built services ──────────────────────────────────────────────
  sessions: SessionManager
  skills: SkillsManager
  mcpManager: McpManager
  commandDispatcher: CommandDispatcher
  agentTypes: AgentTypesManager
  getLlmRuntimeConfig: () => LlmRuntimeConfig
  events: EventService
}

/**
 * Core agent message router.
 *
 * Routes inbound messages to per-session {@link Session} instances managed
 * by {@link SessionManager}.  Handles cross-session concerns: slash commands,
 * sleep monitoring, and service lifecycle.
 */
export class AgentApp {
  private identity?: IdentityManager
  private bus: Bus
  readonly sessions: SessionManager
  readonly skills: SkillsManager
  private mcpManager: McpManager
  private agentTypes: AgentTypesManager
  private running = false
  private commandDispatcher: CommandDispatcher
  private getLlmRuntimeConfig: () => LlmRuntimeConfig
  private events: EventService

  constructor(opts: AgentOptions) {
    this.identity = opts.identity
    this.bus = opts.bus
    this.sessions = opts.sessions
    this.skills = opts.skills
    this.mcpManager = opts.mcpManager
    this.agentTypes = opts.agentTypes
    this.commandDispatcher = opts.commandDispatcher
    this.getLlmRuntimeConfig = opts.getLlmRuntimeConfig
    this.events = opts.events
  }

  async start(): Promise<void> {
    await this.mcpManager.ensureLoaded()
    await this.skills.load()
    await this.agentTypes.load()
    this.skills.startWatching()
    this.agentTypes.startWatching()
    this.mcpManager.startWatching()
    await this.sessions.start()
    this.running = true

    console.log('Agent loop started')
  }

  async shutdown(): Promise<void> {
    this.running = false
    await this.sessions.stop()
    console.log('Agent loop stopped')
    await this.skills.stopWatching()
    await this.agentTypes.stopWatching()
    await this.mcpManager.stopWatching()
  }

  /** Only channel adapters enter the slash-command boundary. */
  async receiveChannelMessage(msg: InboundMessage): Promise<DeliveryReceipt> {
    const release = this.sessions.acquireProjectAccess()
    try { return await this.receiveChannelMessageWithAccess(msg) }
    finally { release() }
  }

  private async receiveChannelMessageWithAccess(msg: InboundMessage): Promise<DeliveryReceipt> {
    if (!this.running) throw new Error('Agent is not accepting input')
    if (this.sessions.organizationId && msg.channelAddress &&
      msg.channelAddress.organizationId !== this.sessions.organizationId) {
      throw new Error('Channel input belongs to another organization')
    }
    const sessionId = deriveSessionId(msg)
    this.sessions.assertProjectAccess(sessionId)
    if (msg.senderId.trim()) {
      await this.identity?.observeInboundAccount(msg.channel, msg.senderId, msg.chatId, msg.senderName, msg.channelAddress)
    }
    const input = channelMessageInput(msg)
    const llm = this.getLlmRuntimeConfig()
    const output = input.kind === 'message' && input.policy === 'interactive'
      ? await this.commandDispatcher.dispatch(input.content, {
        sessionId,
        msg,
        admin: !!msg.admin,
        llm,
      })
      : null
    let receipt: DeliveryReceipt
    if (output !== null) {
      receipt = { status: 'accepted', sessionId, inputId: input.id }
      this.bus.emit('session.input.accepted', { sessionId, input })
      this.publishCommandResponse(msg, output)
    } else {
      receipt = await this.sessions.deliver(sessionId, input, llm)
    }

    // Fanout is a separate source publication; its failure cannot undo acceptance
    // of the original input or cause a client to retry an already accepted turn.
    if (input.kind === 'message') {
      void this.events.publishChannelMessage(msg).catch((error) => {
        console.error(`[agent] Channel subscription delivery failed (${sessionId}, ${input.id}):`, errDetail(error))
      })
    }
    return receipt
  }

  private publishCommandResponse(msg: InboundMessage, content: string): void {
    this.bus.emit('message.outbound', {
      event: 'response',
      channel: msg.channel,
      chatId: msg.chatId,
      ...(msg.channelAddress ? { channelAddress: msg.channelAddress } : {}),
      content,
      replyTo: msg.platformMessageId,
      done: true,
      metadata: {
        partType: 'text',
        command: true,
      },
    })
  }
}
