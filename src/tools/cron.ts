import type { Tool, ToolParameters } from './tool.ts'
import { cronContextMode, type CronService } from '../cron/service.ts'
import type { EventDelivery, EventUrgency } from '../events/types.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ImportTool } from './load-tool.ts'

const URGENCIES: EventUrgency[] = ['steering', 'next-step', 'queue', 'debounce', 'silent']

export class CronAddTool implements Tool {
  readonly name = 'cron_add'
  readonly description =
    'Schedule a task. existing sends events to a durable session in this Project (default: current session); fresh starts an independent logical session per run. Create a topic first if recurring work needs its own conversation.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Useful job name (defaults to the task)' },
      agentType: { type: 'string', description: 'Agent type for fresh executions (default general)' },
      schedule: {
        type: 'string',
        description: 'Standard cron expression (weekdays 0=Sunday, 1=Monday; names SUN-SAT also supported) or interval like "every 5m".',
      },
      task: { type: 'string', description: 'Task prompt delivered on each tick.' },
      session: {
        type: 'string',
        description: 'existing (default) sends events to targetSessionId, or the current session when omitted. fresh starts a new independent session per run, inheriting workdir but not conversation.',
        enum: ['existing', 'fresh'],
      },
      targetSessionId: {
        type: 'string',
        description: 'existing only: an existing durable session in this Project; defaults to the current session. Scheduling a peer requires messaging permission. The target keeps its own agent, tools and workdir.',
      },
      once: { type: 'boolean', description: 'Delete job after first run.' },
      urgency: {
        type: 'string',
        description: 'existing only: steering (interrupt), next-step (next inference without aborting work), queue (default, after current turn), debounce (coalesce burst), silent (record only).',
        enum: URGENCIES,
      },
      debounce_ms: {
        type: 'number',
        description: 'Positive trailing debounce window in ms when urgency=debounce (default 30000).',
      },
    },
    required: ['schedule', 'task'],
    additionalProperties: false,
  }

  constructor(
    private cronService: CronService,
    private sessions?: SessionManager,
    private resolveAgentType?: (name: string) => boolean,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `Schedule "${String(args.task ?? '')}" @ ${String(args.schedule ?? '')}`
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal?.throwIfAborted()
    const schedule = args.schedule
    const task = args.task
    if (typeof schedule !== 'string' || !schedule.trim() || typeof task !== 'string' || !task.trim()) {
      return 'Error: schedule and task are required'
    }
    const mode = args.session ?? 'existing'
    if (mode !== 'existing' && mode !== 'fresh') return 'Error: session must be existing or fresh'
    if ('isolated' in args) return 'Error: isolated is not supported; create a topic and schedule it with targetSessionId.'
    if (args.targetSessionId !== undefined && (typeof args.targetSessionId !== 'string' || !args.targetSessionId.trim())) {
      return 'Error: targetSessionId must be a nonempty string'
    }
    if (mode === 'fresh' && args.targetSessionId !== undefined) return 'Error: targetSessionId is supported only for existing jobs'
    if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) return 'Error: name must be a nonempty string'
    if (args.agentType !== undefined && (typeof args.agentType !== 'string' || !args.agentType.trim())) return 'Error: agentType must be a nonempty string'
    if (args.agentType !== undefined && mode !== 'fresh') return 'Error: agentType is supported only for fresh jobs'
    const agentType = typeof args.agentType === 'string' ? args.agentType : 'general'
    if (mode === 'fresh' && (!this.resolveAgentType?.(agentType) || !this.sessions)) return 'Error: unknown agent type or fresh execution unavailable'
    const origin = mode === 'fresh' ? this.sessions?.getSessionState(context.sessionId) : undefined
    if (mode === 'fresh' && !origin) return 'Error: originating session is unavailable'
    if (args.urgency !== undefined && !URGENCIES.includes(args.urgency as EventUrgency)) return 'Error: invalid urgency'
    if (mode === 'fresh' && (args.urgency !== undefined || args.debounce_ms !== undefined)) {
      return 'Error: delivery urgency is supported only for existing jobs'
    }
    if (args.debounce_ms !== undefined && (args.urgency !== 'debounce' ||
      typeof args.debounce_ms !== 'number' || !Number.isFinite(args.debounce_ms) || args.debounce_ms <= 0)) {
      return 'Error: debounce_ms requires urgency=debounce and a positive finite duration'
    }
    const targetSessionId = typeof args.targetSessionId === 'string' ? args.targetSessionId : context.sessionId
    if (mode === 'existing') {
      if (!this.sessions) return 'Error: session scheduling is unavailable'
      const source = this.sessions.getSessionState(context.sessionId)
      if (context.projectId !== undefined && source?.projectId !== context.projectId) {
        return 'Error: cron context belongs to another Project'
      }
      this.sessions.assertCanScheduleSession(context.sessionId, targetSessionId)
    }
    const urgency = typeof args.urgency === 'string' &&
        URGENCIES.includes(args.urgency as EventUrgency)
      ? args.urgency as EventUrgency
      : undefined
    let event
    if (mode === 'existing' && urgency) {
      const delivery: EventDelivery = { urgency }
      if (typeof args.debounce_ms === 'number') delivery.debounceMs = args.debounce_ms
      event = { type: 'cron-tick', source: 'cron', content: task, delivery }
    }
    const id = this.cronService.addJob({
      schedule,
      task,
      deleteAfterRun: args.once === true,
      session: mode,
      name: typeof args.name === 'string' ? args.name.trim() : task.slice(0, 120),
      originSessionId: context.sessionId,
      ...(mode === 'fresh' ? {
        agentType,
        workspaceRoot: origin!.workspaceRoot ?? context.sessionId,
        workdir: origin!.workdir, folderId: origin!.folderId, initiativeId: origin!.initiativeId,
      } : {}),
      target: mode === 'existing' ? { sessionId: targetSessionId } : undefined,
      event,
    })
    await this.cronService.flush()
    return `Created job ${id} with schedule "${schedule}" (${
      mode === 'fresh' ? 'fresh session per run' : `existing session: ${targetSessionId}`
    })`
  }
}

export class CronListTool implements Tool {
  readonly name = 'cron_list'
  readonly description = 'List scheduled jobs in this Project, including their IDs, tasks, schedules and session targets.'
  readonly parameters: ToolParameters = { type: 'object', properties: {}, additionalProperties: false }

  constructor(private cronService: CronService) {}

  async execute(_args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal?.throwIfAborted()
    const jobs = this.cronService.listJobs()
    if (jobs.length === 0) return 'No scheduled jobs.'
    return jobs.map(job => {
      const target = cronContextMode(job) === 'fresh' ? 'new session per run (fresh)'
        : `${job.target!.sessionId} (existing)`
      const detail = job.event
        ? `${job.event.type} (${job.event.source ?? 'cron'})`
        : `"${job.task ?? ''}"`
      return `- ${job.id}: ${detail} @ ${job.schedule} -> ${target}`
    }).join('\n')
  }
}

export class CronRemoveTool implements Tool {
  readonly name = 'cron_remove'
  readonly description = 'Remove a scheduled job in this Project by its ID. Existing session history is retained.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: { id: { type: 'string', description: 'Job ID returned by cron_add or cron_list.' } },
    required: ['id'],
    additionalProperties: false,
  }

  constructor(private cronService: CronService) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `Remove scheduled job ${String(args.id ?? '')}`
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal?.throwIfAborted()
    if (typeof args.id !== 'string' || !args.id.trim()) return 'Error: id is required'
    const ok = this.cronService.removeJob(args.id)
    await this.cronService.flush()
    return ok ? `Removed job ${args.id}` : `Job ${args.id} not found`
  }
}

export function registerCronTools(
  importer: Pick<ImportTool, 'registerBuiltin'>,
  cron: CronService,
  sessions: SessionManager,
  resolveAgentType: (name: string) => boolean,
): void {
  const tools = [new CronAddTool(cron, sessions, resolveAgentType), new CronListTool(cron), new CronRemoveTool(cron)]
  for (const tool of tools) importer.registerBuiltin(tool.name, tool)
  importer.registerBuiltin('cron', { contracts: tools, factory: async () => tools })
}
