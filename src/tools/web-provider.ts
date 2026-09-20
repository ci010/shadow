import type { Config } from '../config/schema.ts'
import type { Tool } from './tool.ts'
import { detectSearXNG, FirecrawlSearchTool, SearXNGSearchTool, WebSearchTool } from './web.ts'

/** Resolve optional local search only when used, never on the startup path. */
export function createWebSearchTool(
  config: Pick<Config['tools'], 'firecrawlApiKey' | 'braveApiKey'>,
  detect: typeof detectSearXNG = detectSearXNG,
): Tool {
  if (config.firecrawlApiKey) return new FirecrawlSearchTool(config.firecrawlApiKey)
  if (config.braveApiKey) return new WebSearchTool(config.braveApiKey)
  const fallback = new FirecrawlSearchTool()
  let selected: Tool | undefined
  return {
    name: fallback.name,
    description: fallback.description,
    parameters: fallback.parameters,
    readonly: true,
    async execute(args, context) {
      context.signal.throwIfAborted()
      if (!selected) {
        const base = await detect(context.signal)
        context.signal.throwIfAborted()
        if (!selected) {
          selected = base ? new SearXNGSearchTool(base) : fallback
          console.info(`[search] Selected ${base ? 'local SearXNG' : 'keyless Firecrawl'} provider`)
        }
      }
      return selected.execute(args, context)
    },
  }
}
