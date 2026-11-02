import { resolveDeepSeekSearch, type SearchProviders } from '../config/deepseek-search.ts'
import { DeepSeekSearchTool } from './deepseek-search.ts'
import { resolveWebSearchProvider, type WebSearchConfig } from '../config/web-search.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool } from './tool.ts'
import { ExaSearchTool } from './exa.ts'
import { TavilySearchTool } from './tavily.ts'
import { FirecrawlSearchTool, WebSearchTool } from './web.ts'
import { webSearchParameters } from './web-search-json.ts'

export function createWebSearchTool(
  config: WebSearchConfig,
  providers: SearchProviders = {},
): Tool {
  const provider = resolveWebSearchProvider(config, providers)
  if (provider === 'deepseek') return new DeepSeekSearchTool(resolveDeepSeekSearch(providers)?.apiKey ?? '')
  if (provider === 'firecrawl') return new FirecrawlSearchTool(config.firecrawlApiKey?.trim() || undefined)
  const key = {
    brave: config.braveApiKey,
    exa: config.exaApiKey,
    tavily: config.tavilyApiKey,
  }[provider]?.trim()
  if (!key) {
    const name = { brave: 'Brave', exa: 'Exa', tavily: 'Tavily' }[provider]
    return {
      name: 'web_search',
      readonly: true,
      description: 'Search the web using the selected search provider.',
      parameters: webSearchParameters,
      async execute(_args, context) {
        context?.signal.throwIfAborted()
        return `Error: ${name} search requires an API key. Configure it in web search settings.`
      },
      getChatTextDisplay: args => `🕵️ ${String(args.query)}`,
    }
  }
  if (provider === 'brave') return new WebSearchTool(key)
  if (provider === 'exa') return new ExaSearchTool(key)
  return new TavilySearchTool(key)
}

export function createLiveWebSearchTool(getConfig: () => WebSearchConfig, getProviders: () => SearchProviders = () => ({})): Tool {
  return {
    name: 'web_search',
    readonly: true,
    description: 'Search the web using the configured search provider and return results.',
    parameters: webSearchParameters,
    execute(args: Record<string, unknown>, context: ExecutionContext) {
      return createWebSearchTool(getConfig(), getProviders()).execute(args, context)
    },
    getChatTextDisplay: args => `🕵️ ${String(args.query)}`,
  }
}
