import type { Tool, ToolParameters } from './tool.ts'
import type { CronService } from '../cron/service.ts'
import type { EventDelivery, EventUrgency } from '../events/types.ts'
import { ExecutionContext } from './context.ts'

const URGENCIES: EventUrgency[] = ['steering', 'queue', 'debounce', 'silent']

/**
 * Tool for the agent to manage cron jobs.
 */
export class CronTool implements Tool {
  readonly name = 'cron'
  readonly description =
    'Add, list, or remove scheduled jobs. A job fires on its schedule either into the originating session as an event (session="origin") or into an isolated cron:<id> session (session="isolated").'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "add", "list", or "remove"',
        enum: ['add', 'list', 'remove'],
      },
      id: { type: 'string', description: 'Job ID (required for remove)' },
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
          'Where the job runs when it fires: "origin" delivers an event to the session that created it; "isolated" runs in a dedicated cron:<id> session. Default "origin".',
        enum: ['origin', 'isolated'],
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

  constructor(private cronService: CronService) {}

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
    const action = String(args.action)

    switch (action) {
      case 'list': {
        const jobs = this.cronService.listJobs()
        if (jobs.length === 0) return 'No scheduled jobs.'
        return jobs.map((j) => {
          const target = j.isolated
            ? `cron:${j.id} (isolated)`
            : j.target?.sessionId ?? `${j.channel ?? 'cron'}:${j.chatId ?? j.id}`
          const detail = j.event
            ? `${j.event.type} (${j.event.source ?? 'cron'})`
            : `"${j.task ?? ''}"`
          return `• ${j.id}: ${detail} @ ${j.schedule} -> ${target}`
        }).join('\n')
      }

      case 'add': {
        const schedule = String(args.schedule ?? '')
        const task = String(args.task ?? '')
        if (!schedule || !task) {
          return 'Error: schedule and task are required for add'
        }
        const isolated = String(args.session ?? 'origin') === 'isolated'
        // Origin jobs may carry an urgency policy on the fired event.
        const urgency = typeof args.urgency === 'string' &&
            URGENCIES.includes(args.urgency as EventUrgency)
          ? args.urgency as EventUrgency
          : undefined
        let event
        if (!isolated && urgency) {
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
          target: isolated ? undefined : { sessionId: context.sessionId },
          event,
        })
        return `Created job ${id} with schedule "${schedule}" (${
          isolated ? 'isolated cron session' : 'origin session'
        })`
      }

      case 'remove': {
        const id = String(args.id ?? '')
        if (!id) return 'Error: id is required for remove'
        const ok = this.cronService.removeJob(id)
        return ok ? `Removed job ${id}` : `Job ${id} not found`
      }

      default:
        return `Unknown action: ${action}`
    }
  }
}
