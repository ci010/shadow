import type { ExecutionContext } from './context.ts'
import type { ToolParameters } from './tool.ts'

export const webSearchParameters: ToolParameters = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    count: { type: 'string', description: 'Number of results (default 5; provider limits apply)' },
  },
  required: ['query'],
}

interface SearchResult {
  title?: string | null
  url: string
  snippet?: string
}

interface JsonSearchOptions {
  provider: string
  apiKey: string
  url: string
  headers: Record<string, string>
  maxCount: number
  body: (query: string, count: number) => unknown
  parseResults: (data: unknown) => SearchResult[]
}

export async function executeJsonSearch(
  options: JsonSearchOptions,
  args: Record<string, unknown>,
  context?: ExecutionContext,
): Promise<string> {
  context?.signal.throwIfAborted()
  if (!options.apiKey.trim()) return `Error: ${options.provider} search requires an API key. Configure it in web search settings.`
  if (typeof args.query !== 'string' || !args.query.trim()) {
    return 'Error: Search query must be a non-empty string.'
  }
  const rawCount = args.count === undefined ? 5 : args.count
  const count = typeof rawCount === 'number' || (typeof rawCount === 'string' && rawCount.trim())
    ? Number(rawCount)
    : NaN
  if (!Number.isInteger(count) || count < 1 || count > options.maxCount) {
    return `Error: ${options.provider} result count must be an integer between 1 and ${options.maxCount}.`
  }
  const signal = context
    ? AbortSignal.any([context.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000)
  let response: Response
  try {
    response = await fetch(options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
      body: JSON.stringify(options.body(args.query, count)),
      signal,
    })
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    return `Error: ${options.provider} search request failed.`
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    signal.throwIfAborted()
    if (response.status === 401 || response.status === 403) {
      return `Error: ${options.provider} rejected the API key (${response.status}).`
    }
    if (response.status === 429) return `Error: ${options.provider} rate limit reached (429).`
    return `Error: ${options.provider} search returned ${response.status}.`
  }
  let data: unknown
  try {
    data = await response.json()
    signal.throwIfAborted()
  } catch {
    signal.throwIfAborted()
    return `Error: ${options.provider} search returned invalid JSON.`
  }
  let results: SearchResult[]
  try {
    results = options.parseResults(data)
  } catch {
    return `Error: ${options.provider} search returned an invalid response structure.`
  }
  return results.slice(0, count).map((result, index) => {
    const lines = [`${index + 1}. ${result.title ?? result.url}`, `   ${result.url}`]
    if (result.snippet) lines.push(`   ${result.snippet}`)
    return lines.join('\n')
  }).join('\n\n') || 'No results found.'
}
