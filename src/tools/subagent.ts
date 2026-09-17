import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { errMsg } from '../utils/truncate.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import { isExecutionMode } from '../sessions/execution-mode.ts'
import { channelAddressFromSessionId, channelSessionId } from '../bus/events.ts'
import { parseInitiativeId } from '../sessions/initiative-metadata.ts'

/** Role restrictions intersect execution mode and structural delegation scope. */
export class SubagentTool implements Tool {
  readonly name = 'subagent'
  readonly description = 'Create an asynchronous session/task, or invoke a blocking bounded leaf call. Available modes depend on this session’s execution mode and structural ownership. Blocking calls must use this tool directly, not an exec/invoke bridge.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      mode: {
        type: 'string', enum: ['session', 'task', 'call'],
        description: 'Session/task return an accepted ID immediately. Call waits for its final result and cannot coordinate, yield, or delegate. Mode is required outside root sessions; at root, omission uses the selected role’s defaultMode only when allowed.',
      },
      task: { type: 'string', description: 'Initial work. Required for task/call; optional for session.' },
      description: {
        type: 'string',
        description: 'Short description of the sub-agent session\'s purpose.',
      },
      initiative_id: {
        type: 'string',
        description: 'Existing Initiative ID in this Project. The child receives its shared SQL work context; omission inherits the parent association.',
      },
      agent_type: {
        type: 'string',
        description:
          'Agent role. Defaults to "sub"; explicit call mode inherits the caller role when omitted. ' +
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
    const denied = ctx.tools?.executionDenial?.('subagent', args)
    if (denied) return denied
    const description = args.description != null ? String(args.description) : ''
    if (!description) return 'Error: description is required'

    if (args.mode !== undefined && !isExecutionMode(args.mode)) return 'Error: mode must be session, task, or call.'
    const allowedModes = this.sessions.getAllowedSubagentModes(ctx.sessionId)
    if (args.mode === undefined && !allowedModes.includes('session')) {
      return `Error: mode is required in this scope; choose ${allowedModes.join(', ') || 'nothing'}.`
    }
    const parentState = this.sessions.getSessionState(ctx.sessionId)
    const initiativeId = parseInitiativeId({
      initiativeId: args.initiative_id,
      initiativeName: args.initiative_name,
      projectName: args.project_name,
    }) ?? parentState?.initiativeId
    if (initiativeId) this.sessions.assertInitiativeAccess(initiativeId)
    const typeName = args.agent_type != null ? String(args.agent_type) : args.mode === 'call' ? parentState?.agentType ?? 'general' : 'sub'
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
    const mode = args.mode ?? agentType.defaultMode ?? 'session'
    if (mode === 'call' && reportTo !== undefined) return 'Error: call mode cannot use report_to.'
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (mode !== 'session' && !task) return `Error: task is required for mode="${mode}".`
    if (reportTo !== undefined && !/^[^:]+:.+$/.test(reportTo)) return 'Error: report_to must be a session ID in channel:chatId format.'
    const executionKey = ctx.toolCallId && ctx.toolCallName === 'subagent'
      ? `${ctx.physicalSessionId}:${ctx.messageId}:${ctx.toolCallId}` : crypto.randomUUID()
    return this.sessions.executeOnce(executionKey, async () => {
    this.sessions.assertCanCreateChild(ctx.sessionId, mode)
    if (mode === 'call' && ctx.toolCallName && ctx.toolCallName !== 'subagent') {
      throw new Error('Blocking calls require native subagent invocation; a script bridge cannot guarantee the caller remains attached.')
    }

    const originChannel = ctx.channel ?? 'system'
    const originChatId = ctx.chatId ?? 'direct'
    const originAddress = ctx.channelAddress ?? channelAddressFromSessionId(ctx.sessionId)
    if (originAddress && (originAddress.platform !== originChannel || originAddress.conversationId !== originChatId
      || (ctx.projectId !== undefined && originAddress.projectId !== ctx.projectId))) {
      throw new Error('Subagent source bot address does not match its session context')
    }

    console.info(`[subagent] Spawning ${typeName} subagent: ${description.slice(0, 100)}`)

    // 1. Determine chatId and channel.
    const createThread = this.channels.createThread.bind(this.channels)
    const threadName = `Subagent: ${description.slice(0, 80)}`
    const threadId = mode !== 'session' ? null : await createThread(originChannel, originChatId, threadName, originAddress).catch((err) => {
      if (originAddress) throw err
      console.warn('[subagent] Thread creation failed, using synthetic chatId', errMsg(err))
      return null
    })

    const isThread = !!threadId
    const chatId = threadId ?? `${typeName}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
    const channel = isThread || (mode === 'session' && originChannel === 'web') ? originChannel : 'virtual'
    const sessionId = isThread && originAddress
      ? channelSessionId({ ...originAddress, conversationId: chatId }) : `${channel}:${chatId}`

    const parentSessionId = ctx.sessionId

    // 2. Resolve parent lineage and create session prototype.
    const parentPhysicalId = parentState ? newPhysicalSessionId(parentState.sessionId, parentState.segmentIndex) : undefined
    // Share the spawner's working directory: inherit its workspaceRoot if it is
    // itself a subagent, otherwise the spawner owns the folder (use its id).
    const workspaceRoot = parentState?.workspaceRoot ?? parentSessionId
    await this.sessions.buildSession(
      sessionId,
      parentPhysicalId ? { id: parentSessionId, physicalId: parentPhysicalId } : undefined,
      {
        agentType: typeName,
        mode,
        executionKey,
        parentToolCallId: ctx.toolCallName === 'subagent' ? ctx.toolCallId : undefined,
        parentSessionId,
        reportTo: mode === 'call' ? undefined : reportTo ?? parentSessionId,
        config: mode === 'call' ? {
          ...structuredClone(parentState?.config ?? {}),
          ...(ctx.model !== undefined ? { model: ctx.model } : {}),
          ...(ctx.temperature !== undefined ? { temperature: ctx.temperature } : {}),
          ...(ctx.maxTokens !== undefined ? { maxTokens: ctx.maxTokens } : {}),
          ...(ctx.thinking !== undefined ? { thinking: structuredClone(ctx.thinking) } : {}),
          ...(ctx.reasoningEffort !== undefined ? { reasoningEffort: ctx.reasoningEffort } : {}),
        } : undefined,
        originUser: ctx.senderName,
        description,
        preloadTools,
        workspaceRoot,
        workdir: parentState?.workdir,
        folderId: parentState?.folderId,
        initiativeId,
      },
    )

    // 3. Only reusable children belong to the managed child list.
    if (mode === 'session') {
      await this.sessions.addChild(parentSessionId, sessionId)
    }
    if (mode === 'call') return this.sessions.startCall(sessionId, task, ctx)
    if (task) {
      try {
        await this.sessions.startChild(sessionId, task, ctx)
      } catch (error) {
        await this.sessions.deleteSession(sessionId)
        throw error
      }
    }

    const locator = isThread
      ? `Thread created in ${channel}:${originChatId}`
      : `Virtual session (no thread)`
    return JSON.stringify({
      sessionId, executionId: mode === 'task' ? sessionId : undefined, mode, agentType: typeName,
      status: task ? 'running' : 'pending',
      message: mode === 'session'
        ? `Subagent created. ${locator}. Use message for subsequent tasks.`
        : 'Task started. The final result will be reported asynchronously.',
    })
    })
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🤖 ${args.agent_type ? `(${args.agent_type}) ` : ''}${String(args.description ?? '').slice(0, 80)}`
  }
}
