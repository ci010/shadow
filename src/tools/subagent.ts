import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/agent-types/manager.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { errMsg } from '../utils/truncate.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'

/**
 * Tool for spawning sub-agent sessions.
 *
 * Creates a session with the specified agent type, optionally in a
 * platform thread. Does NOT send a task message — the parent must
 * use the `message` tool to communicate with the subagent after creation.
 *
 * Completion routing (report_to) is handled persistently by
 * SessionManager's bus listener.
 */
export class SubagentTool implements Tool {
  readonly name = 'subagent'
  readonly description = 'Spawn a sub-agent session. Use the message tool to send tasks to it.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short description of the sub-agent session\'s purpose.',
      },
      agent_type: {
        type: 'string',
        description:
          'Agent type to use. Defaults to "sub". ' +
          'Available types are listed in the Runtime section of the system prompt.',
      },
      report_to: {
        type: 'string',
        description:
          'Session ID to route every completed turn to instead of this session. ' +
          'Format: "channel:chatId". Enables agent chains (e.g., coder → verifier).',
      },
      preload_tools: {
        type: 'object',
        description:
          'Tools to preload before the subagent starts. ' +
          'Map of tool name → extra args array. Example: { "chrome-devtools": ["--remote-debugging-port=9223"] }. ' +
          'Use empty array for no extra args: { "cron": [] }.',
      },
    },
    required: ['description'],
  }

  constructor(
    private bus: Bus,
    private sessions: SessionManager,
    private agentTypes: AgentTypesManager,
    private channels: ChannelManager,
  ) { }

  async execute(
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<string> {
    const description = args.description != null ? String(args.description) : ''
    if (!description) return 'Error: description is required'

    const typeName = args.agent_type != null ? String(args.agent_type) : 'sub'
    const reportTo = args.report_to != null ? String(args.report_to) : undefined
    const preloadTools = args.preload_tools && typeof args.preload_tools === 'object' && !Array.isArray(args.preload_tools)
      ? Object.fromEntries(
        Object.entries(args.preload_tools as Record<string, unknown>).map(
          ([k, v]) => [k, Array.isArray(v) ? v.map(String) : []],
        ),
      )
      : undefined

    // Resolve agent type
    const agentType = this.agentTypes.resolve(typeName)
    if (!agentType) {
      return `Error: unknown agent type "${typeName}". Available: ${this.agentTypes.allNames().join(', ')}`
    }

    const originChannel = ctx.channel ?? 'system'
    const originChatId = ctx.chatId ?? 'direct'

    console.info(`[subagent] Spawning ${typeName} subagent: ${description.slice(0, 100)}`)

    // 1. Determine chatId and channel.
    const createThread = this.channels.createThread.bind(this.channels)
    const threadName = agentType.ephemeral
      ? `[${typeName}] ${description.slice(0, 80)}`
      : `Subagent: ${description.slice(0, 80)}`
    const threadId = await createThread?.(originChannel, originChatId, threadName).catch((err) => {
      console.warn('[subagent] Thread creation failed, using synthetic chatId', errMsg(err))
      return null
    })

    const isThread = !!threadId
    const chatId = threadId ?? `${typeName}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const channel = (isThread || !agentType.ephemeral) ? originChannel : 'virtual'
    const sessionId = `${channel}:${chatId}`

    // Resolve callback target: report_to overrides the default (parent session)
    let callbackChannel = originChannel
    let callbackChatId = originChatId
    if (reportTo) {
      const colonIdx = reportTo.indexOf(':')
      if (colonIdx > 0) {
        callbackChannel = reportTo.slice(0, colonIdx)
        callbackChatId = reportTo.slice(colonIdx + 1)
      }
    }

    const parentSessionId = `${originChannel}:${originChatId}`

    // 2. Resolve parent lineage and create session prototype.
    const parentState = this.sessions.getSessionState(parentSessionId)
    const parentPhysicalId = parentState ? newPhysicalSessionId(parentState.sessionId, parentState.segmentIndex) : undefined
    // Share the spawner's working directory: inherit its workspaceRoot if it is
    // itself a subagent, otherwise the spawner owns the folder (use its id).
    const workspaceRoot = parentState?.workspaceRoot ?? parentSessionId
    await this.sessions.buildSession(
      sessionId,
      parentPhysicalId ? { id: parentSessionId, physicalId: parentPhysicalId } : undefined,
      {
        agentType: typeName,
        reportTo: `${callbackChannel}:${callbackChatId}`,
        originUser: ctx.senderName,
        description,
        preloadTools,
        workspaceRoot,
        workdir: parentState?.workdir,
        projectId: parentState?.projectId,
      },
    )

    // 3. Persist child sessionId on parent state (non-ephemeral parents only).
    if (!agentType.ephemeral) {
      const parentIsEphemeral = await this.sessions.isEphemeralSession(parentSessionId)
      if (!parentIsEphemeral) {
        await this.sessions.addChild(parentSessionId, sessionId)
      }
    }

    const locator = isThread
      ? `Thread created in ${channel}:${originChatId}`
      : `Virtual session (no thread)`
    return `Subagent (${typeName}) created. ${locator}. Session ID: "${sessionId}". Use the message tool to send tasks to it.`
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🤖 ${args.agent_type ? `(${args.agent_type}) ` : ''}${String(args.description ?? '').slice(0, 80)}`
  }
}
