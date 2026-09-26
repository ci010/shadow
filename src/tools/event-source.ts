import { CapabilityGrantSchema } from '../agent-authoring/contracts.ts'
import type { EventService } from '../events/service.ts'
import type { PollingSources } from '../events/polling-sources.ts'
import type { ExecutionContext } from './context.ts'
import { EventSubscribeTool } from './event-subscribe.ts'
import type { ImportTool } from './load-tool.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class EventSourceTool implements Tool {
  readonly name = 'event_source'
  readonly description = 'Create, list, run or remove Project polling event sources. Creation is allowed only in a direct user-initiated local conversation. Source code runs in a disposable restricted child and imports { fetch } from @shadow/fetch; fetch uses an approved HTTP grant and host-held credential.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'run', 'remove'] },
      id: { type: 'string', description: 'Stable lowercase source ID; event source tag becomes custom:<id>.' },
      code: { type: 'string', description: 'Module exporting async run({checkpoint}) returning {events:[{id,type,content,meta?}],checkpoint}. Each event ID must be stable across retries.' },
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
      return 'Error: event sources require a local durable authoring session in this Project'
    }
    if (args.action === 'list') return JSON.stringify(this.sources.list(context.sessionId))
    if (context.inputSource !== 'user') return 'Error: event source changes and manual runs require a direct user turn'
    if (typeof args.id !== 'string') return 'Error: id is required'
    if (args.action === 'remove') {
      const removed = await this.sources.remove(args.id, context.sessionId)
      return removed ? `Removed event source ${args.id}` : `Event source ${args.id} not found`
    }
    if (args.action === 'run') {
      const count = await this.sources.run(args.id, context.sessionId)
      return `Polled event source ${args.id}; delivered ${count} event(s)`
    }
    if (args.action !== 'create') return 'Error: unknown event source action'
    if (typeof args.code !== 'string' || typeof args.grant_json !== 'string' ||
      typeof args.interval_seconds !== 'number') return 'Error: code, grant_json, and interval_seconds are required'
    let grant: unknown
    try { grant = JSON.parse(args.grant_json) } catch { return 'Error: grant_json must be JSON' }
    const validated = CapabilityGrantSchema.parse(grant)
    if (validated.kind !== 'http' || validated.id !== 'fetch') return 'Error: grant must be HTTP with id=fetch'
    const created = this.sources.create({
      id: args.id, ownerSessionId: context.sessionId, code: args.code,
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
