import type { EventService } from '../events/service.ts'
import { EventSubscribeTool } from './event-subscribe.ts'
import type { ImportTool } from './load-tool.ts'

/** Internal runtime bus discovery; external acquisition lives under signals. */
export function registerInternalEventTools(
  importer: Pick<ImportTool, 'registerBuiltin'>,
  events: EventService,
): void {
  const tools = [new EventSubscribeTool(events)]
  for (const tool of tools) importer.registerBuiltin(tool.name, tool)
  importer.registerBuiltin('events', { contracts: tools, factory: async () => tools })
}
