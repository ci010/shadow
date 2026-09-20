import { z } from 'zod'
import type { ExecutionContext } from './context.ts'
import type { Tool } from './tool.ts'
import { executeJsonSearch, webSearchParameters } from './web-search-json.ts'

const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullable().optional(),
    url: z.string().url(),
    highlights: z.array(z.string()).optional(),
  })),
})

export class ExaSearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description = 'Search the web using the Exa Search API and return results.'
  readonly parameters = webSearchParameters

  constructor(private apiKey: string) {}

  execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    return executeJsonSearch({
      provider: 'Exa',
      apiKey: this.apiKey,
      url: 'https://api.exa.ai/search',
      headers: { 'x-api-key': this.apiKey },
      maxCount: 100,
      body: (query, count) => ({ query, numResults: count, contents: { highlights: true } }),
      parseResults: data => responseSchema.parse(data).results.map(result => ({
        ...result, snippet: result.highlights?.join(' '),
      })),
    }, args, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🕵️ ${String(args.query)}`
  }
}
