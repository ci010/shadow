import type { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { deriveSessionId } from '../bus/events.ts'
import type { CommandDispatcher } from '../slash-commands/index.ts'
import type { CommandReceipt } from '../slash-commands/receipt.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { errDetail } from '../utils/truncate.ts'
import type { AgentTypesManager } from './types/manager.ts'
import type { LlmRuntimeConfig } from './llm-config.ts'
import type { McpManager } from '../mcp/manager.ts'
import type { SkillsManager } from '../skills/loader.ts'
import type { EventService } from '../events/service.ts'
import type { IdentityManager } from './identity.ts'
import { channelMessageInput, type DeliveryReceipt } from '../sessions/input.ts'
import { StartupTimings } from '../runtime/startup-timings.ts'

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

  async start(startup = new StartupTimings('project')): Promise<void> {
    await startup.measure('agent-mcp', () => this.mcpManager.ensureLoaded())
    await startup.measure('agent-skills', () => this.skills.load())
    await startup.measure('agent-types', () => this.agentTypes.load())
    await startup.measure('agent-watchers', () => {
      this.skills.startWatching()
      this.agentTypes.startWatching()
    })
    await startup.measure('agent-sessions', () => this.sessions.start(startup))
    this.running = true

    console.log('Agent loop started')
  }

  async shutdown(): Promise<void> {
    this.running = false
    await this.sessions.stop()
    console.log('Agent loop stopped')
    await this.skills.stopWatching()
    await this.agentTypes.stopWatching()
    await this.mcpManager.stop()
  }

  /** Only channel adapters enter the slash-command boundary. */
  async receiveChannelMessage(msg: InboundMessage): Promise<DeliveryReceipt> {
    const release = this.sessions.acquireFolderAccess()
    try { return await this.receiveChannelMessageWithAccess(msg) }
    finally { release() }
  }

  private async receiveChannelMessageWithAccess(msg: InboundMessage): Promise<DeliveryReceipt> {
    if (!this.running) throw new Error('Agent is not accepting input')
    if (this.sessions.projectId && msg.channelAddress &&
      msg.channelAddress.projectId !== this.sessions.projectId) {
      throw new Error('Channel input belongs to another project')
    }
    const sessionId = deriveSessionId(msg)
    this.sessions.assertFolderAccess(sessionId)
    const input = channelMessageInput(msg)
    this.sessions.authorizeConversationInput(sessionId, input)
    if (msg.senderId.trim() && !msg.channelAdmissionId) {
      await this.identity?.observeInboundAccount(msg.channel, msg.senderId, msg.chatId, msg.senderName, msg.channelAddress)
    }
    const llm = this.getLlmRuntimeConfig()
    let output: string | null = null
    let failed = false
    if (input.kind === 'message' && input.policy === 'interactive'
      && !this.sessions.isManagedConversation(sessionId) && input.content.trimStart().startsWith('/')) {
      await this.sessions.prepareCommandSession(sessionId, msg)
      try {
        output = await this.commandDispatcher.dispatch(input.content, {
          sessionId, msg, admin: !!msg.admin, llm,
        })
        failed = output !== null && /^(?:Error:|Permission denied:)/.test(output)
      } catch (error) {
        console.error(`[agent] Command failed (${sessionId}, ${input.id}):`, errDetail(error))
        output = 'Error: Command execution failed. Check the server logs for details.'
        failed = true
      }
    }
    let receipt: DeliveryReceipt
    if (output !== null) {
      const commandReceipt: CommandReceipt = {
        id: input.id, command: msg.content.trim(), output, failed,
        timestamp: new Date().toISOString(),
      }
      await this.sessions.recordCommandResult(sessionId, commandReceipt)
      receipt = { status: 'accepted', sessionId, inputId: input.id, commandReceipt }
      this.bus.emit('session.input.accepted', { sessionId, input })
      this.publishCommandResponse(msg, commandReceipt)
    } else {
      receipt = await this.sessions.deliver(sessionId, input, llm)
    }

    // Fanout is a separate source publication; its failure cannot undo acceptance
    // of the original input or cause a client to retry an already accepted turn.
    if (input.kind === 'message' && output === null && !msg.channelAdmissionId) {
      void this.events.publishChannelMessage(msg).catch((error) => {
        console.error(`[agent] Channel subscription delivery failed (${sessionId}, ${input.id}):`, errDetail(error))
      })
    }
    return receipt
  }

  private publishCommandResponse(msg: InboundMessage, receipt: CommandReceipt): void {
    this.bus.emit('message.outbound', {
      event: 'response',
      channel: msg.channel,
      chatId: msg.chatId,
      ...(msg.channelAddress ? { channelAddress: msg.channelAddress } : {}),
      content: receipt.output,
      replyTo: msg.platformMessageId,
      done: true,
      metadata: {
        partType: 'text',
        command: true,
        commandReceipt: receipt,
      },
    })
  }
}
