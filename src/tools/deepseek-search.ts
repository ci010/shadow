import { z } from 'zod'
import type { ExecutionContext } from './context.ts'
import type { Tool } from './tool.ts'
import { executeJsonSearch, webSearchParameters } from './web-search-json.ts'

const responseSchema = z.object({
  results: z.array(z.object({
    title: z.string().nullable().optional(),
    url: z.string().url(),
    snippet: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
  })),
})

export class DeepSeekSearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description = 'Search the web using the official DeepSeek Search API.'
  readonly parameters = webSearchParameters
  constructor(private apiKey: string) {}

  async execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    context?.signal.throwIfAborted()
    if (!this.apiKey) return 'Error: DeepSeek search requires a configured DeepSeek provider with an API key and official endpoint. Configure it in provider settings.'
    if (typeof args.query === 'string' && Array.from(args.query).length > 128) {
      return 'Error: DeepSeek search query must contain at most 128 Unicode characters.'
    }
    return executeJsonSearch({
      provider: 'DeepSeek', apiKey: this.apiKey,
      url: 'https://api.deepseek.com/v1/tools/search',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      maxCount: 50,
      body: (query, count) => ({ query, count, need_content: false }),
      parseResults: data => responseSchema.parse(data).results.map(result => ({
        ...result, snippet: result.snippet || result.summary || result.content || undefined,
      })),
    }, args, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string { return `🕵️ ${String(args.query)}` }
}
