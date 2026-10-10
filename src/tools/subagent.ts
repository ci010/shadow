import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { isExecutionMode } from '../sessions/execution-mode.ts'
import { channelAddressFromSessionId } from '../bus/events.ts'
import { parseInitiativeId } from '../sessions/initiative-metadata.ts'
import type { A2aSessions } from '../a2a/sessions.ts'
import { workBindingSchema } from '../sessions/work-policy.ts'

/** Role restrictions intersect execution mode and structural delegation scope. */
export class SubagentTool implements Tool {
  readonly name = 'subagent'
  readonly description = 'Create a temporary asynchronous task, or invoke a blocking bounded leaf call. Use session creation for independent long-lived conversations. These are executions, not work items. Blocking calls must use this tool directly, not an exec/invoke bridge.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      mode: {
        type: 'string', enum: ['task', 'call'],
        description: 'Task returns an executionId immediately; inspect v:bg without polling. Call waits for its final result and cannot coordinate, ask, or delegate. Omission defaults to task in a long-lived session; tasks must explicitly choose call.',
      },
      task: { type: 'string', description: 'Initial work. Required for task/call.' },
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
          'Agent role. Defaults to "general"; explicit call mode inherits the caller role when omitted. ' +
          'Discover local roles and configured a2a:<agent> targets with read("v:agents"). Remote targets support task mode only and inherit no local resources.',
      },
      report_to: {
        type: 'string',
        description:
          'Session ID to route the final task result to instead of this session. ' +
          'Format: "channel:chatId". Enables agent chains (e.g., coder → verifier).',
      },
      preload_tools: {
        type: 'object',
        description:
          'Tools to preload before the subagent starts. ' +
          'Map of tool name → extra args array. Example: { "chrome-devtools": ["--remote-debugging-port=9223"] }. ' +
          'Use empty array for no extra args: { "cron": [] }.',
      },
      work: { type: 'object', description: 'Optional {key:string}: shared note assigned to the durable owner. Links this execution and its questions to that goal; does not require adoption or constrain tools. Omission inherits an unambiguous parent focus.' },
    },
    required: ['description', 'task'],
  }

  constructor(
    private bus: Bus,
    private sessions: SessionManager,
    private agentTypes: AgentTypesManager,
    private channels: ChannelManager,
    private remote?: Pick<A2aSessions, 'start'>,
  ) { }

  async execute(
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<string> {
    if (args.mode === 'session') return 'Error: mode=session is no longer supported by subagent. Use session creation for an independent long-lived conversation.'
    const denied = ctx.tools?.executionDenial?.('subagent', args)
    if (denied) return denied
    const description = args.description != null ? String(args.description) : ''
    if (!description) return 'Error: description is required'

    if (args.mode !== undefined && !isExecutionMode(args.mode)) return 'Error: mode must be task or call.'
    const allowedModes = this.sessions.getAllowedSubagentModes(ctx.sessionId)
    if (args.mode === undefined && !allowedModes.includes('task')) {
      return `Error: mode is required in this scope; choose ${allowedModes.join(', ') || 'nothing'}.`
    }
    if (typeof args.agent_type === 'string' && args.agent_type.startsWith('a2a:')) {
      if (this.sessions.alignment?.required(ctx.sessionId)) throw new Error('Remote A2A execution does not enforce local Work bindings; managed delegation is unavailable.')
      if (!this.remote) throw new Error('A2A is not configured in this Project.')
      if (args.mode !== undefined && args.mode !== 'task') throw new Error('Remote agents support asynchronous task mode only.')
      if (Object.keys(args).some(key => !['agent_type', 'task', 'description', 'mode'].includes(key))) {
        throw new Error('Remote delegation accepts only agent_type, task, description and task mode; local work context, report_to and preload_tools are not forwarded.')
      }
      if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('Remote delegation requires task text.')
      this.sessions.assertCanCreateChild(ctx.sessionId, 'task')
      return this.remote.start(args.agent_type, args.task, ctx)
    }
    const parentState = this.sessions.getSessionState(ctx.sessionId)
    const work = args.work === undefined ? undefined : workBindingSchema.parse(args.work)
    if (work && !this.sessions.alignment) throw new Error('Work policy service is unavailable.')
    const initiativeId = parseInitiativeId({
      initiativeId: args.initiative_id,
      initiativeName: args.initiative_name,
      projectName: args.project_name,
    }) ?? parentState?.initiativeId
    if (initiativeId) this.sessions.assertInitiativeAccess(initiativeId)
    const inheritedRole = parentState?.agentType === 'orchestrator' ? 'general' : parentState?.agentType ?? 'general'
    const typeName = args.agent_type != null ? String(args.agent_type) : args.mode === 'call' ? inheritedRole : 'general'
    if (typeName === 'orchestrator') return 'Error: the Project orchestrator cannot be used as a subagent role.'
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
    const mode = args.mode ?? 'task'
    if (mode === 'call' && reportTo !== undefined) return 'Error: call mode cannot use report_to.'
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) return `Error: task is required for mode="${mode}".`
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

    const workPolicy = this.sessions.alignment?.prepareDelegation(ctx.sessionId, work, mode)
    console.info(`[subagent] Spawning ${typeName} subagent: ${description.slice(0, 100)}`)

    const sessionId = `virtual:${typeName}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`

    const parentSessionId = ctx.sessionId

    // 2. Resolve parent lineage and create session prototype.
    const parentPhysicalId = parentState ? physicalSessionId(parentState) : undefined
    // Share the spawner's working directory: inherit its workspaceRoot if it is
    // itself a subagent, otherwise the spawner owns the folder (use its id).
    const workspaceRoot = parentState?.workspaceRoot ?? parentSessionId
    await this.sessions.buildSession(
      sessionId,
      parentPhysicalId ? { id: parentSessionId, physicalId: parentPhysicalId } : undefined,
      {
        agentType: typeName,
        mode,
        workPolicy,
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

    this.sessions.alignment?.linkExecution(sessionId, parentSessionId, work)
    if (mode === 'call') return this.sessions.startCall(sessionId, task, ctx)
    if (task) {
      try {
        await this.sessions.startChild(sessionId, task, ctx)
      } catch (error) {
        await this.sessions.deleteSession(sessionId)
        throw error
      }
    }

    return JSON.stringify({
      sessionId, executionId: mode === 'task' ? sessionId : undefined, mode, agentType: typeName,
      status: task ? 'running' : 'pending',
      message: 'Task started. The final result will be reported asynchronously.',
    })
    })
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🤖 ${args.agent_type ? `(${args.agent_type}) ` : ''}${String(args.description ?? '').slice(0, 80)}`
  }
}
