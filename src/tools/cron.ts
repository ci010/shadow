import type { Tool, ToolParameters } from './tool.ts'
import type { CronService } from '../cron/service.ts'
import type { EventDelivery, EventUrgency } from '../events/types.ts'
import { ExecutionContext } from './context.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { cronContextMode } from '../cron/service.ts'

const URGENCIES: EventUrgency[] = ['steering', 'queue', 'debounce', 'silent']

/**
 * Tool for the agent to manage cron jobs.
 */
export class CronTool implements Tool {
  readonly name = 'cron'
  readonly description =
    'Add, list, or remove scheduled jobs. origin appends to the creating session; isolated continues one fixed cron:<id> session; fresh starts an independent logical session for each execution.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "add", "list", or "remove"',
        enum: ['add', 'list', 'remove'],
      },
      id: { type: 'string', description: 'Job ID (required for remove)' },
      name: { type: 'string', description: 'Useful automation name (fresh mode; defaults to the task)' },
      agentType: { type: 'string', description: 'Agent type for fresh executions (default general)' },
      schedule: {
        type: 'string',
        description:
          'Standard cron expression (weekdays 0=Sunday, 1=Monday; names SUN-SAT also supported) or interval like "every 5m" (required for add)',
      },
      task: {
        type: 'string',
        description: 'Task prompt for the agent (required for add)',
      },
      session: {
        type: 'string',
        description:
          'origin appends to the creating session (default); isolated continues a fixed cron:<id> session; fresh starts a new independent session per run, inheriting workdir but not conversation.',
        enum: ['origin', 'isolated', 'fresh'],
      },
      once: {
        type: 'boolean',
        description: 'Delete job after first run',
      },
      urgency: {
        type: 'string',
        description:
          'Delivery urgency of the fired event (session="origin" only): steering (interrupt), ' +
          'queue (default, after current turn), debounce (coalesce burst), silent (record only).',
        enum: ['steering', 'queue', 'debounce', 'silent'],
      },
      debounce_ms: {
        type: 'number',
        description: 'Trailing debounce window in ms when urgency=debounce (default 30000).',
      },
    },
    required: ['action'],
  }

  constructor(
    private cronService: CronService,
    private sessions?: SessionManager,
    private resolveAgentType?: (name: string) => boolean,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const action = String(args.action)
    switch (action) {
      case 'add':
        return `⏰ "${String(args.task ?? '')}" @ ${
          String(args.schedule ?? '')
        }`
      case 'remove':
        return `🗑️ "${String(args.id ?? '')}"`
    }
    return ''
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    context.signal?.throwIfAborted()
    const action = String(args.action)

    switch (action) {
      case 'list': {
        const jobs = this.cronService.listJobs()
        if (jobs.length === 0) return 'No scheduled jobs.'
        return jobs.map((j) => {
          const target = cronContextMode(j) === 'fresh' ? 'new session per run (fresh)' : cronContextMode(j) === 'isolated'
            ? `cron:${j.id} (isolated)`
            : j.target?.sessionId ?? `${j.channel ?? 'cron'}:${j.chatId ?? j.id}`
          const detail = j.event
            ? `${j.event.type} (${j.event.source ?? 'cron'})`
            : `"${j.task ?? ''}"`
          return `• ${j.id}: ${detail} @ ${j.schedule} -> ${target}`
        }).join('\n')
      }

      case 'add': {
        const schedule = args.schedule
        const task = args.task
        if (typeof schedule !== 'string' || !schedule.trim() || typeof task !== 'string' || !task.trim()) {
          return 'Error: schedule and task are required for add'
        }
        const mode = args.session ?? 'origin'
        if (mode !== 'origin' && mode !== 'isolated' && mode !== 'fresh') return 'Error: session must be origin, isolated, or fresh'
        const isolated = mode === 'isolated'
        if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) return 'Error: name must be a nonempty string'
        if (args.agentType !== undefined && (typeof args.agentType !== 'string' || !args.agentType.trim())) return 'Error: agentType must be a nonempty string'
        if (args.agentType !== undefined && mode !== 'fresh') return 'Error: agentType is supported only for fresh jobs'
        const agentType = typeof args.agentType === 'string' ? args.agentType : 'general'
        if (mode === 'fresh' && (!this.resolveAgentType?.(agentType) || !this.sessions)) return 'Error: unknown agent type or fresh execution unavailable'
        const origin = mode === 'fresh' ? this.sessions?.getSessionState(context.sessionId) : undefined
        if (mode === 'fresh' && !origin) return 'Error: originating session is unavailable'
        if (args.urgency !== undefined && !URGENCIES.includes(args.urgency as EventUrgency)) return 'Error: invalid urgency'
        // Origin jobs may carry an urgency policy on the fired event.
        const urgency = typeof args.urgency === 'string' &&
            URGENCIES.includes(args.urgency as EventUrgency)
          ? args.urgency as EventUrgency
          : undefined
        let event
        if (mode === 'origin' && urgency) {
          const delivery: EventDelivery = { urgency }
          const ms = typeof args.debounce_ms === 'number' ? args.debounce_ms : undefined
          if (ms && ms > 0) delivery.debounceMs = ms
          event = { type: 'cron-tick', source: 'cron', content: task, delivery }
        }
        const id = this.cronService.addJob({
          schedule,
          task,
          deleteAfterRun: args.once === true || args.once === 'true',
          isolated,
          session: mode,
          ...(mode === 'fresh' ? {
            name: typeof args.name === 'string' ? args.name.trim() : task.slice(0, 120),
            agentType, originSessionId: context.sessionId,
            workspaceRoot: origin!.workspaceRoot ?? context.sessionId,
            workdir: origin!.workdir, folderId: origin!.folderId, initiativeId: origin!.initiativeId,
          } : {}),
          target: mode === 'origin' ? { sessionId: context.sessionId } : undefined,
          event,
        })
        await this.cronService.flush()
        return `Created job ${id} with schedule "${schedule}" (${
          mode === 'fresh' ? 'fresh session per run' : isolated ? 'isolated cron session' : 'origin session'
        })`
      }

      case 'remove': {
        const id = String(args.id ?? '')
        if (!id) return 'Error: id is required for remove'
        const ok = this.cronService.removeJob(id)
        await this.cronService.flush()
        return ok ? `Removed job ${id}` : `Job ${id} not found`
      }

      default:
        return `Unknown action: ${action}`
    }
  }
}
