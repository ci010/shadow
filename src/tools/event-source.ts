import { SimplePollingSchema } from '../events/simple-polling.ts'
import { CapabilityGrantSchema } from '../execution/grant-contract.ts'
import type { EventService } from '../events/service.ts'
import type { PollingSources } from '../events/polling-sources.ts'
import type { ExecutionContext } from './context.ts'
import { EventSubscribeTool } from './event-subscribe.ts'
import type { ImportTool } from './load-tool.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class EventSourceTool implements Tool {
  readonly name = 'event_source'
  readonly description = 'Configure generic Project polling signals from any HTTP source (GitHub, GitLab, etc.), without Work. Create then event_subscribe to custom:<id> with queue, run to establish a checkpoint, inspect the saved source/subscription and verify a real change before promising monitoring. List/inspect are owner-only reads; create/run/pause/resume/remove require a direct user turn. Restricted code imports { fetch } from @shadow/fetch using the exact HTTP grant and optional host-held credential. No secrets in code; use credential_request for provisioning. Polling is not a webhook or exactly-once delivery; prefer simple_json items/snapshot for complete single-response endpoints; infrastructure owns baseline and deduplication. Advanced code retains responsibility for stable IDs and pagination.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'inspect', 'run', 'pause', 'resume', 'remove'] },
      id: { type: 'string', description: 'Stable lowercase source ID; event source tag becomes custom:<id>.' },
      code: { type: 'string', description: 'Module exporting async run({checkpoint}) returning {events:[{id,type,content,meta?}],checkpoint}. Each event ID must be stable across retries.' },
      simple_json: { type: 'string', description: 'SimplePolling JSON: mode items or snapshot, exact GET request {method,path,query?}, select path segments, eventType, completeResponse:true. items requires idPath and maxItems (rejects length >= bound), optional filter {path,equals}; snapshot optional fingerprintPath. Both support contentPath. Only complete single-response endpoints; no pagination. First run is silent baseline. See event-sources skill.' },
      grant_json: { type: 'string', description: 'HTTP grant JSON with id="fetch", kind="http", HTTPS origin, allowed routes, and optional credential {secretRef,header,prefix}. Never include a credential value.' },
      interval_seconds: { type: 'number', description: 'Poll cadence, 30..86400 seconds.' },
    },
    required: ['action'],
    additionalProperties: false,
  }

  constructor(
    private sources: PollingSources,
    private canAuthor: (sessionId: string) => boolean,
  ) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId === undefined || !this.canAuthor(context.sessionId)) {
      return 'Error: event sources require a local durable owner session in this Project'
    }
    if (args.action === 'list') return JSON.stringify(this.sources.list(context.sessionId))
    if (args.action === 'inspect') {
      if (typeof args.id !== 'string') return 'Error: id is required'
      return JSON.stringify(this.sources.inspect(args.id, context.sessionId))
    }
    if (context.inputSource !== 'user') return 'Error: event source changes and manual runs require a direct user turn'
    if (typeof args.id !== 'string') return 'Error: id is required'
    if (args.action === 'pause' || args.action === 'resume') {
      await this.sources.setEnabled(args.id, context.sessionId, args.action === 'resume')
      return `${args.action === 'resume' ? 'Resumed' : 'Paused'} event source custom:${args.id}; checkpoint retained`
    }
    if (args.action === 'remove') {
      const removed = await this.sources.remove(args.id, context.sessionId)
      return removed ? `Removed event source ${args.id}` : `Event source ${args.id} not found`
    }
    if (args.action === 'run') {
      const count = await this.sources.run(args.id, context.sessionId)
      return `Polled event source ${args.id}; delivered ${count} event(s)`
    }
    if (args.action !== 'create') return 'Error: unknown event source action'
    if ((typeof args.code !== 'string' && typeof args.simple_json !== 'string') ||
      (args.code !== undefined && args.simple_json !== undefined) || typeof args.grant_json !== 'string' ||
      typeof args.interval_seconds !== 'number') return 'Error: exactly one of code or simple_json, plus grant_json and interval_seconds are required'
    let grant: unknown
    try { grant = JSON.parse(args.grant_json) } catch { return 'Error: grant_json must be JSON' }
    const validated = CapabilityGrantSchema.parse(grant)
    if (validated.kind !== 'http' || validated.id !== 'fetch') return 'Error: grant must be HTTP with id=fetch'
    const created = this.sources.create({
      id: args.id, ownerSessionId: context.sessionId, code: typeof args.code === 'string' ? args.code : undefined,
      simple: typeof args.simple_json === 'string' ? SimplePollingSchema.parse(JSON.parse(args.simple_json)) : undefined,
      intervalMs: args.interval_seconds * 1000, grant: validated,
    })
    return `Created event source custom:${created.id} (sha256:${created.hash}); subscribe with event_subscribe and run it to establish the initial checkpoint`
  }
}

export function registerEventTools(
  importer: Pick<ImportTool, 'registerBuiltin'>,
  events: EventService,
  sources: PollingSources,
  canAuthor: (sessionId: string) => boolean,
): void {
  const tools = [new EventSubscribeTool(events), new EventSourceTool(sources, canAuthor)]
  for (const tool of tools) importer.registerBuiltin(tool.name, tool)
  importer.registerBuiltin('events', { contracts: tools, factory: async () => tools })
}
