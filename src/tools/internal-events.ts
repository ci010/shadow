import type { EventService } from '../events/service.ts'
import { EventSubscribeTool } from './event-subscribe.ts'
import type { ImportTool } from './load-tool.ts'
import type { Tool } from './tool.ts'

/** Internal bus subscriptions and external provider tools share discovery, not state. */
export function registerInternalEventTools(
  importer: Pick<ImportTool, 'registerBuiltin'>,
  events: EventService,
  additionalTools: Tool[] = [],
): void {
  const tools = [new EventSubscribeTool(events), ...additionalTools]
  for (const tool of tools) importer.registerBuiltin(tool.name, tool)
  importer.registerBuiltin('events', { contracts: tools, factory: async () => tools })
}
