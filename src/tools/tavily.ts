import { z } from 'zod'
import type { ExecutionContext } from './context.ts'
import type { Tool } from './tool.ts'
import { executeJsonSearch, webSearchParameters } from './web-search-json.ts'

const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullable().optional(),
    url: z.string().url(),
    content: z.string(),
  })),
})

export class TavilySearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description = 'Search the web using the Tavily Search API and return results.'
  readonly parameters = webSearchParameters

  constructor(private apiKey: string) {}

  execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    return executeJsonSearch({
      provider: 'Tavily',
      apiKey: this.apiKey,
      url: 'https://api.tavily.com/search',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      maxCount: 20,
      body: (query, count) => ({ query, search_depth: 'basic', max_results: count, include_answer: false }),
      parseResults: data => responseSchema.parse(data).results.map(result => ({
        ...result, snippet: result.content,
      })),
    }, args, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🕵️ ${String(args.query)}`
  }
}
