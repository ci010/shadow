import type { ExecutionContext } from './context.ts'
import type { EventService } from '../events/service.ts'
import type { EventDelivery, EventSourceDescriptor, EventUrgency } from '../events/types.ts'
import type { Tool, ToolParameters } from './tool.ts'

const URGENCIES: EventUrgency[] = ['steering', 'queue', 'debounce', 'silent']

/** Build a delivery policy from tool args, or undefined if no urgency given. */
function parseDelivery(args: Record<string, unknown>): EventDelivery | undefined {
  const u = typeof args.urgency === 'string' ? args.urgency : undefined
  if (!u || !URGENCIES.includes(u as EventUrgency)) return undefined
  const delivery: EventDelivery = { urgency: u as EventUrgency }
  if (typeof args.coalesce_key === 'string' && args.coalesce_key) {
    delivery.coalesceKey = args.coalesce_key
  }
  const ms = typeof args.debounce_ms === 'number'
    ? args.debounce_ms
    : typeof args.debounce_ms === 'string'
    ? Number(args.debounce_ms)
    : undefined
  if (ms != null && Number.isFinite(ms) && ms > 0) delivery.debounceMs = ms
  return delivery
}

function formatSource(s: EventSourceDescriptor): string {
  const d = s.delivery ? ` [urgency=${s.delivery.urgency}]` : ''
  return `• ${s.source} (${s.kind})${d}${s.description ? ` — ${s.description}` : ''}`
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'object' && value && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore invalid JSON
  }
  return undefined
}

export class EventSubscribeTool implements Tool {
  readonly name = 'event_subscribe'
  readonly description =
    'Manage event subscriptions, event sources, and emit custom events. ' +
    'Events are signals that wake a session; declare urgency to control how they arrive ' +
    '(steering=interrupt now, queue=after current turn, debounce=coalesce a burst, silent=record only). ' +
    'Read v:events for subscriptions and v:events/sources for registered sources. Use the cron tool to schedule periodic events.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'subscribe | unsubscribe | emit | register_source | unregister_source | list_sources',
        enum: [
          'subscribe',
          'unsubscribe',
          'emit',
          'register_source',
          'unregister_source',
          'list_sources',
        ],
      },
      id: {
        type: 'string',
        description: 'Subscription ID (required for unsubscribe).',
      },
      event: {
        type: 'string',
        description: 'Event type to match or emit. Use * to subscribe to all.',
      },
      source: {
        type: 'string',
        description:
          'Event source tag. For subscribe/emit: filter/label (e.g. channel:web, cron). ' +
          'For register_source/unregister_source: the source tag to define/remove.',
      },
      channel: {
        type: 'string',
        description: 'Optional channel filter for channel.message events.',
      },
      chat_id: {
        type: 'string',
        description: 'Optional chat filter for channel.message events.',
      },
      content: {
        type: 'string',
        description: 'Event payload text when action=emit.',
      },
      meta_json: {
        type: 'string',
        description: 'Optional JSON object string for event metadata.',
      },
      target_session: {
        type: 'string',
        description: 'Optional target session ID; defaults to current session.',
      },
      urgency: {
        type: 'string',
        description:
          'Delivery urgency for subscribe/emit/register_source: steering (interrupt), ' +
          'queue (default, after current turn), debounce (coalesce burst), silent (record only).',
        enum: ['steering', 'queue', 'debounce', 'silent'],
      },
      coalesce_key: {
        type: 'string',
        description: 'Grouping key for debounce coalescing (defaults to "<type>:<source>").',
      },
      debounce_ms: {
        type: 'number',
        description: 'Trailing debounce window in ms (default 30000). Only for urgency=debounce.',
      },
      kind: {
        type: 'string',
        description: 'Source category for register_source (default "custom").',
        enum: ['channel', 'cron', 'agent', 'system', 'custom'],
      },
      description: {
        type: 'string',
        description: 'Human description for register_source.',
      },
    },
    required: ['action'],
  }

  constructor(
    private events: EventService,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const action = String(args.action ?? '')
    if (action === 'subscribe') {
      return `🔔 ${String(args.event ?? '*')}`
    }
    if (action === 'emit') {
      return `📣 ${String(args.event ?? 'custom')}`
    }
    return ''
  }

  execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const action = String(args.action ?? '')
    const sessionId = String(args.target_session ?? context.sessionId)

    const result = (async () => {
      switch (action) {
      case 'subscribe': {
        const event = String(args.event ?? '').trim()
        if (!event) return 'Error: event is required for subscribe'
        const sub = this.events.subscribe({
          sessionId,
          event,
          source: typeof args.source === 'string' ? args.source : undefined,
          channel: typeof args.channel === 'string' ? args.channel : undefined,
          chatId: typeof args.chat_id === 'string' ? args.chat_id : undefined,
          delivery: parseDelivery(args),
        })
        return `Subscribed ${sessionId} to ${event} (id=${sub.id})`
      }

      case 'unsubscribe': {
        const id = String(args.id ?? '').trim()
        if (!id) return 'Error: id is required for unsubscribe'
        const ok = this.events.unsubscribe(id)
        return ok ? `Unsubscribed ${id}` : `Subscription ${id} not found`
      }

      case 'emit': {
        const event = String(args.event ?? '').trim()
        if (!event) return 'Error: event is required for emit'
        const meta = parseJsonObject(args.meta_json)
        await this.events.emit({
          type: event,
          source: typeof args.source === 'string' ? args.source : 'agent',
          content: typeof args.content === 'string' ? args.content : '',
          meta,
          targetSessionId: sessionId,
          delivery: parseDelivery(args),
          origin: {
            sessionId: context.sessionId,
            inputId: context.messageId,
            source: { kind: 'session', sessionId: context.sessionId },
          },
        })
        return `Emitted event ${event} to ${sessionId}`
      }

      case 'register_source': {
        const source = String(args.source ?? '').trim()
        if (!source) return 'Error: source is required for register_source'
        const kind = typeof args.kind === 'string' &&
            ['channel', 'cron', 'agent', 'system', 'custom'].includes(args.kind)
          ? args.kind as EventSourceDescriptor['kind']
          : 'custom'
        const desc = this.events.registerSource({
          source,
          kind,
          description: typeof args.description === 'string' ? args.description : undefined,
          delivery: parseDelivery(args),
          ownerSessionId: sessionId,
        })
        return `Registered source ${desc.source} (${desc.kind})`
      }

      case 'unregister_source': {
        const source = String(args.source ?? '').trim()
        if (!source) return 'Error: source is required for unregister_source'
        const ok = this.events.unregisterSource(source)
        return ok
          ? `Unregistered source ${source}`
          : `Source ${source} not found or is a protected built-in`
      }

      case 'list_sources': {
        const sources = this.events.listSources()
        if (sources.length === 0) return 'No event sources registered.'
        return sources.map(formatSource).join('\n')
      }

      default:
        return `Unknown action: ${action}`
      }
    })()

    return result
  }
}
