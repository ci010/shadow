import type { Bus } from '../bus/bus.ts'
import type { InboundMessage, MessageContext } from '../bus/events.ts'
import { deriveSessionId } from '../bus/events.ts'
import type { CommandDispatcher } from '../commands/index.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { errDetail } from '../utils/truncate.ts'
import type { AgentTypesManager } from './agent-types/manager.ts'
import type { LlmRuntimeConfig } from './llm-config.ts'
import type { ThinkingConfig } from './llm-config.ts'
import type { McpManager } from '../mcp/manager.ts'
import type { SkillsManager } from '../skills/loader.ts'
import type { SessionTools } from '../tools/registry.ts'
import type { ExecShell } from '../tools/shell.ts'
import type { Executor } from '../execution/executor.ts'

export interface ExecutionContext extends MessageContext {
  /** Logical session ID (e.g. "discord:1234567890") */
  sessionId: string
  /** Physical session ID — the actual persisted session log identifier */
  physicalSessionId: string
  /**
   * Resolved working directory: a managed session folder or registered project.
   * Filesystem/shell tools resolve relative paths here. Shared resources such as
   * memory/ and SOUL.md stay under Main; private uploads use explicit file references.
   * Falls back to the workspace root when unset.
   */
  cwd?: string
  /** Capability-backed remote workspace. Local-only tools must reject this context. */
  remoteWorkdir?: {
    nodeId: string
    capabilityId: string
    executor: Executor
  }
  /** Session-scoped tool overlay — provides filtered, session-aware tool access. */
  tools: SessionTools
  /** Abort signal for the current turn — tools should check this for early cancellation. */
  signal: AbortSignal
  /** Resolved default shell for exec in this context, after global/session overrides. */
  defaultExecShell?: ExecShell
  /** LLM model override for this session. */
  model?: string
  /** LLM temperature override for this session. */
  temperature?: number
  /** LLM max tokens override for this session. */
  maxTokens?: number
  /** DeepSeek thinking mode toggle */
  thinking?: ThinkingConfig
  /** DeepSeek reasoning effort level */
  reasoningEffort?: 'high' | 'max'
}

export interface AgentOptions {
  bus: Bus
  // ── Pre-built services ──────────────────────────────────────────────
  sessions: SessionManager
  skills: SkillsManager
  mcpManager: McpManager
  commandDispatcher: CommandDispatcher
  agentTypes: AgentTypesManager
  getLlmRuntimeConfig: () => LlmRuntimeConfig
}

/**
 * Core agent message router.
 *
 * Routes inbound messages to per-session {@link Session} instances managed
 * by {@link SessionManager}.  Handles cross-session concerns: slash commands,
 * sleep monitoring, and service lifecycle.
 */
export class AgentApp {
  private bus: Bus
  readonly sessions: SessionManager
  readonly skills: SkillsManager
  private mcpManager: McpManager
  private agentTypes: AgentTypesManager
  private running = false
  private commandDispatcher: CommandDispatcher
  private getLlmRuntimeConfig: () => LlmRuntimeConfig

  constructor(opts: AgentOptions) {
    this.bus = opts.bus
    this.sessions = opts.sessions
    this.skills = opts.skills
    this.mcpManager = opts.mcpManager
    this.agentTypes = opts.agentTypes
    this.commandDispatcher = opts.commandDispatcher
    this.getLlmRuntimeConfig = opts.getLlmRuntimeConfig
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

    this.bus.on('message.inbound', (msg) => {
      if (!this.running) return
      this.onInboundMessage(msg)
    })

    console.log('Agent loop started')
  }

  async shutdown(): Promise<void> {
    this.running = false
    this.sessions.stop()
    console.log('Agent loop stopped')
    await this.skills.stopWatching()
    await this.agentTypes.stopWatching()
    await this.mcpManager.stopWatching()
  }

  private async onInboundMessage(msg: InboundMessage): Promise<void> {
    try {
      const llm = this.getLlmRuntimeConfig()
      const output = await this.commandDispatcher.dispatch(msg.content, {
        sessionId: deriveSessionId(msg),
        msg,
        admin: !!msg.admin,
        llm,
      })
      if (output !== null) {
        this.publishCommandResponse(msg, output)
        return
      }

      await this.sessions.dispatch(msg, llm)
    } catch (err) {
      console.error(errDetail(err), 'Error in routing handler')
    }
  }

  private publishCommandResponse(msg: InboundMessage, content: string): void {
    const queryId = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    this.bus.emit('message.outbound', {
      event: 'response',
      channel: msg.channel,
      chatId: msg.chatId,
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
