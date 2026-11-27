import { delegatedBuiltinSelection } from '../agent/types/versions.ts'
import type { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import { isSelectableAgentType } from '../agent/types/types.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { physicalSessionId } from '../sessions/session-identity.ts'
import { isExecutionMode, isNativeCallInvocation } from '../sessions/execution-mode.ts'
import { channelAddressFromSessionId } from '../bus/events.ts'
import { parseWorkRoot } from '../sessions/initiative-metadata.ts'
import type { A2aSessions } from '../a2a/sessions.ts'
import { workBindingSchema } from '../sessions/work-policy.ts'
import { REASONING_EFFORTS, inferenceSettings, type InferenceSettings } from '../agent/llm-config.ts'
import { z } from 'zod'
import { readAgentPromptDraft, type SubOverrideStore } from '../agent/context/sub-override.ts'
import { isToolAllowed } from '../utils/tool-allow.ts'
import { parseSessionName } from '../sessions/session-name.ts'

const callArgumentsSchema = z.object({ agent_type: z.never().optional() }).passthrough()

const reviewSchema = z.object({
  mode: z.enum(['parent', 'agent']).default('parent'),
  agent_type: z.string().min(1).optional(),
  max_rounds: z.number().int().min(1).max(10).default(3),
  criteria: z.string().max(16000).default(''),
}).strict()

// Keep the advertised nested contract covered alongside runtime validation in tests.
const reviewParameters = {
  type: 'object',
  description: 'Local task review policy. Omission defaults to parent review; agent creates an independent reviewer automatically. PASS alone delivers success; changes rerun the original worker. Calls and A2A do not accept review.',
  properties: {
    mode: { type: 'string', enum: ['parent', 'agent'], default: 'parent' },
    agent_type: { type: 'string', minLength: 1, description: 'Agent review only: configured local reviewer role; defaults to verify.' },
    max_rounds: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Maximum submissions including the first. Use max_rounds, not maxRounds.' },
    criteria: { type: 'string', maxLength: 16000, default: '' },
  },
  additionalProperties: false,
}

function reviewError(error: z.ZodError): string {
  const aliases: Record<string, string> = { maxRounds: 'max_rounds', agentType: 'agent_type' }
  const details = error.issues.flatMap(issue => {
    const path = ['review', ...issue.path].join('.')
    if (issue.code === 'unrecognized_keys') return issue.keys.map(key =>
      `${path}.${key}: unknown field.${Object.hasOwn(aliases, key) ? ` Use ${path}.${aliases[key]} instead.` : ''}`)
    return [`${path}: ${issue.message}`]
  })
  return `Error: invalid subagent review policy. ${details.join(' ')} Allowed fields: review.mode, review.agent_type, review.max_rounds, review.criteria. No subagent was started.`
}

/** Role restrictions intersect execution mode and structural delegation scope. */
export class SubagentTool implements Tool {
  readonly name = 'subagent'
  // Orchestration remains on Main; buildSession preserves the parent's opaque
  // workdir/folder binding and child tools dispatch through its remote executor.
  readonly supportsLayerFSWorkdir = true
  readonly supportsRemoteWorkdir = true
  readonly description = 'Start an asynchronous task. The result is an admitted ID, not completion. Local submissions require parent or independent agent review; only PASS delivers success. Remote A2A tasks are one-shot and do not support local review.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      prompt_revision: { type: 'string', description: 'Exact Project draft revision for the selected local role definition. Omission uses its normal prompt. Not supported for remote A2A.' },
      sub_revision: { type: 'string', description: 'Exact Project draft revision (built-in sub only). Missing explicit revisions fail closed; omission uses built-in behavior.' },
      task: { type: 'string', description: 'First assignment for the worker: outcome, scope, constraints and expected result.' },
      model: { type: 'string', description: 'Optional exact model ID from v:models; omission preserves role defaults.' },
      effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Optional reasoning effort supported by the selected model. Omission inherits existing defaults. Forbidden in call mode, which always inherits caller settings.' },
      title: { type: 'string', description: 'Parent-owned display title, max 120 characters.' },
      description: {
        type: 'string',
        description: 'Optional parent-owned discovery context, max 4000 characters. Put worker instructions in task instead.',
      },
      workRoot: {
        type: 'string',
        description: 'Optional root Work key in this Project. The child receives its shared context; omission inherits the parent association.',
      },
      agent_type: {
        type: 'string',
        description:
          'Agent role, defaults to "general". ' +
          'Built-in specialist roles use their configured default for new ordinary delegations; use role@version to pin one explicitly. ' +
          'Discover local roles and configured a2a:<agent> targets with read("v:agents"). Remote targets support task mode only and inherit no local resources.',
      },
      review: reviewParameters,
      report_to: {
        type: 'string',
        description:
          'Session ID to route the final task result to instead of this session. ' +
          'Format: "channel:chatId". Routing only: this does not grant reviewer or close authority.',
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
    required: ['title', 'task'],
  }

  constructor(
    private bus: Bus,
    private sessions: SessionManager,
    private agentTypes: AgentTypesManager,
    private channels: ChannelManager,
    private remote?: Pick<A2aSessions, 'start'>,
    private subOverrides?: SubOverrideStore,
    private projectId?: string,
  ) { }

  async execute(
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<string> {
    if (args.mode === 'session') return 'Error: mode=session is no longer supported by subagent. Use session creation for an independent long-lived conversation.'
    const denied = ctx.tools?.executionDenial?.('subagent', args)
    if (denied) return denied
    const description = args.description
    if (description !== undefined && typeof description !== 'string') return 'Error: description must be a string.'
    if (args.mode !== 'call' && description !== undefined && description.length > 4000) return 'Error: task description must be at most 4000 characters.'

    if (args.mode !== undefined && !isExecutionMode(args.mode)) return 'Error: mode must be task or call.'
    if (args.mode === 'call') {
      const validation = callArgumentsSchema.safeParse(args)
      if (!validation.success) return `Error: invalid arguments for "subagent": ${validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    }
    if (args.mode === 'call' && (Object.hasOwn(args, 'model') || Object.hasOwn(args, 'effort'))) {
      return 'Error: call mode cannot specify model or effort; it always inherits caller inference settings.'
    }
    // A remote call cannot enforce the foreground exec lifecycle. Reject before
    // creating a child rather than starting a leaf that fails on its first exec.
    if (args.mode === 'call' && ctx.remoteWorkdir) {
      return 'Error: call mode is not supported on remote workdirs because remote exec cannot enforce a foreground process lifecycle. Use task mode for remote work; no subagent was started.'
    }
    const allowedModes = this.sessions.getAllowedSubagentModes(ctx.sessionId)
    if (args.mode === undefined && !allowedModes.includes('task')) {
      return 'Error: asynchronous delegation is not allowed in this scope. Use call if available.'
    }
    // Existing callers may supply description instead of title; the new schema requires title.
    const display = args.title ?? description?.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120)
    if (args.mode !== 'call' && display === undefined) return 'Error: title is required.'
    const title = args.mode === 'call' ? undefined : parseSessionName(display)
    if (args.prompt_revision !== undefined && args.sub_revision !== undefined) throw new Error('Choose prompt_revision or sub_revision, not both.')
    if (typeof args.agent_type === 'string' && args.agent_type.startsWith('a2a:')) {
      if (args.prompt_revision !== undefined || args.sub_revision !== undefined) throw new Error('Remote A2A does not support local prompt drafts.')
      if (this.sessions.alignment?.required(ctx.sessionId)) throw new Error('Remote A2A execution does not enforce local Work bindings; managed delegation is unavailable.')
      if (!this.remote) throw new Error('A2A is not configured in this Project.')
      if (args.mode !== undefined && args.mode !== 'task') throw new Error('Remote agents support asynchronous task mode only.')
      if (Object.keys(args).some(key => !['agent_type', 'task', 'title', 'description', 'mode'].includes(key))) {
        throw new Error('Remote delegation accepts only agent_type, task, title, optional description and legacy task mode; local work context, report_to and preload_tools are not forwarded.')
      }
      if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('Remote delegation requires task text.')
      this.sessions.assertCanCreateChild(ctx.sessionId, 'task')
      return this.remote.start(args.agent_type, args.task, ctx)
    }
    const parentState = this.sessions.getSessionState(ctx.sessionId)
    if (ctx.layerfsWorkdir && (parentState?.workdir?.version !== 2
      || parentState.workdir.nodeId !== 'layerfs' || parentState.workdir.workdirId !== ctx.layerfsWorkdir.workspace)) {
      return 'Error: LayerFS parent mount binding is missing or changed; no subagent was started. Refresh the working context before delegating.'
    }
    if (ctx.remoteWorkdir && (parentState?.workdir?.version !== 2
      || parentState.workdir.nodeId !== ctx.remoteWorkdir.nodeId
      || parentState.workdir.workdirId !== ctx.remoteWorkdir.workdirId)) {
      return 'Error: remote parent workdir binding is missing or changed; no subagent was started. Refresh the working context before delegating.'
    }
    const work = args.work === undefined ? undefined : workBindingSchema.parse(args.work)
    if (work && !this.sessions.alignment) throw new Error('Work policy service is unavailable.')
    if (['initiative_id', 'initiative_name', 'project_name'].some(key => args[key] !== undefined)) {
      throw new TypeError('Unsupported context selector. Use workRoot with a canonical Work key.')
    }
    const initiativeId = parseWorkRoot(args.workRoot) ?? parentState?.initiativeId
    if (initiativeId) this.sessions.assertInitiativeAccess(initiativeId)
    const inheritedRole = parentState?.agentType ?? 'general'
    const ordinary = !parentState?.channelBoundary && !parentState?.automation && !ctx.channelAddress && !channelAddressFromSessionId(ctx.sessionId)
      && !this.sessions.isManagedConversation?.(ctx.sessionId)
    const resolveSelection = (name: string) => {
      const builtin = ordinary ? delegatedBuiltinSelection(name) : undefined
      return builtin ? builtin.agentType ?? this.sessions.defaultBuiltinAgentType?.(builtin.role) ?? name : name
    }
    const requestedType = args.agent_type != null ? String(args.agent_type) : undefined
    // Draft namespaces use exact definition IDs, independent of default aliases.
    const typeName = requestedType !== undefined ? (args.prompt_revision === undefined ? resolveSelection(requestedType) : requestedType)
      : args.mode === 'call' ? inheritedRole : 'general'
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
      return `Error: unknown agent type "${typeName}". Available: ${this.agentTypes.all().filter(isSelectableAgentType).map(type => type.name).join(', ')}`
    }
    const mode = args.mode ?? 'task'
    const overrides: InferenceSettings = {
      ...(args.model === undefined ? {} : { model: z.string().trim().min(1).max(512).parse(args.model) }),
      ...(args.effort === undefined ? {} : { reasoningEffort: z.enum(REASONING_EFFORTS).parse(args.effort) }),
    }
    const inference = mode === 'call' ? {
      ...structuredClone(parentState?.config ?? {}),
      ...inferenceSettings(ctx),
    } : { ...overrides }
    if (mode === 'call' && reportTo !== undefined) return 'Error: call mode cannot use report_to.'
    if (mode === 'call' && args.review !== undefined) return 'Error: calls do not support review policies.'
    const parsedReview = mode === 'task' ? reviewSchema.safeParse(args.review === undefined ? {} : args.review) : undefined
    if (parsedReview && !parsedReview.success) return reviewError(parsedReview.error)
    const review = parsedReview?.success ? parsedReview.data : undefined
    if (review?.mode === 'parent' && review.agent_type !== undefined) return 'Error: parent review does not accept agent_type.'
    const reviewerType = review?.mode === 'agent' ? resolveSelection(review.agent_type ?? 'verify') : undefined
    if (reviewerType) {
      const reviewer = this.agentTypes.resolve(reviewerType)
      if (!reviewer) return 'Error: reviewer must be a configured local agent.'
      if (reviewer.name.startsWith('a2a:') || !isToolAllowed(reviewer, 'task')) return 'Error: reviewer must be local and permitted to use the structured task review tool.'
    }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) return `Error: task is required for mode="${mode}".`
    if (reportTo !== undefined && !/^[^:]+:.+$/.test(reportTo)) return 'Error: report_to must be a session ID in channel:chatId format.'
    const nativeTool = !ctx.scriptInvocation && (ctx.toolCallName === 'subagent' || (mode === 'call' && ctx.toolCallName === 'call'))
    const executionKey = ctx.toolCallId && nativeTool
      ? `${ctx.physicalSessionId}:${ctx.messageId}:${ctx.toolCallId}` : crypto.randomUUID()
    return this.sessions.executeOnce(executionKey, async () => {
    this.sessions.assertCanCreateChild(ctx.sessionId, mode)
    let promptDraft
    if (args.prompt_revision !== undefined) {
      if (!this.subOverrides || !this.projectId || ctx.projectId !== this.projectId || parentState?.projectId !== this.projectId || typeof args.prompt_revision !== 'string') {
        throw new Error('Explicit prompt drafts require a local role in the same Project.')
      }
      if (agentType.runtimeOrigin || parentState?.channelBoundary || parentState?.automation || this.sessions.isManagedConversation?.(ctx.sessionId)) {
        throw new Error('Prompt drafts cannot override managed, published, or automated executions.')
      }
      promptDraft = await readAgentPromptDraft(this.subOverrides, agentType, args.prompt_revision)
    }
    let subDraft: { revision: string; markdown: string } | undefined
    if (args.sub_revision !== undefined) {
      if (agentType.source !== 'builtin' || agentType.name !== 'sub' || !this.subOverrides || !this.projectId ||
        ctx.projectId !== this.projectId || parentState?.projectId !== this.projectId || typeof args.sub_revision !== 'string') {
        throw new Error('Explicit sub drafts require a built-in sub execution in the same Project')
      }
      subDraft = { revision: args.sub_revision, markdown: await this.subOverrides.read(args.sub_revision) }
    }
    if (args.model !== undefined || args.effort !== undefined) {
      await this.sessions.validateExecutionInference({
        ...(agentType.model ? { model: agentType.model } : {}),
        ...(agentType.reasoningEffort ? { reasoningEffort: agentType.reasoningEffort } : {}),
        ...inference,
      })
    }
    if (mode === 'call' && !isNativeCallInvocation(ctx)) {
      throw new Error('Blocking calls require native call invocation; a script bridge cannot guarantee the caller remains attached.')
    }

    const originChannel = ctx.channel ?? 'system'
    const originChatId = ctx.chatId ?? 'direct'
    const originAddress = ctx.channelAddress ?? channelAddressFromSessionId(ctx.sessionId)
    if (originAddress && (originAddress.platform !== originChannel || originAddress.conversationId !== originChatId
      || (ctx.projectId !== undefined && originAddress.projectId !== ctx.projectId))) {
      throw new Error('Subagent source bot address does not match its session context')
    }

    const workPolicy = this.sessions.alignment?.prepareDelegation(ctx.sessionId, work, mode)
    console.info(`[subagent] Spawning ${typeName} subagent: ${(title ?? description ?? task).slice(0, 100)}`)

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
        subDraft,
        promptDraft,
        mode,
        workPolicy,
        executionKey,
        parentToolCallId: nativeTool ? ctx.toolCallId : undefined,
        parentSessionId,
        reportTo: mode === 'call' ? undefined : reportTo ?? parentSessionId,
        config: inference,
        originUser: ctx.senderName,
        description,
        ...(mode === 'task' ? { name: title } : {}),
        preloadTools,
        workspaceRoot,
        workdir: parentState?.workdir,
        folderId: parentState?.folderId,
        initiativeId,
      },
    )

    if (review) await this.sessions.configureTaskReview(sessionId, task, { mode: review.mode, agentType: reviewerType, maxRounds: review.max_rounds, criteria: review.criteria })
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
      sessionId, executionId: mode === 'task' ? sessionId : undefined, mode, agentType: typeName, promptVersion: this.sessions.getSessionState(sessionId)?.promptVersion, ...(agentType.source === 'builtin' && agentType.name === 'sub' ? { subRevision: promptDraft?.revision ?? subDraft?.revision ?? 'builtin' } : {}),
      promptRevision: promptDraft?.revision ?? subDraft?.revision,
      status: task ? 'running' : 'pending',
      message: 'Task started. Correct this assignment with message(sessionId, content); it applies at the next safe step. Do not take over its files until completion or confirmed cancellation. Review workflow is automatic. Parent review receives a review request and uses task(action=review) with the fixed revision; agent review needs no parent orchestration. Only PASS reports success; failures escalate.',
    })
    })
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🤖 ${args.agent_type ? `(${args.agent_type}) ` : ''}${String(args.title ?? args.description ?? args.task ?? '').slice(0, 80)}`
  }
}
