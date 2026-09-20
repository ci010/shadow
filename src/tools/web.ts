import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'

// ── web_search (Brave Search API) ───────────────────────────────────────────

export class WebSearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description =
    'Search the web using Brave Search API and return results.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'string', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  }

  constructor(private apiKey: string) {}

  async execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    context?.signal.throwIfAborted()
    const query = String(args.query)
    const count = Number(args.count ?? 5)
    const url = `https://api.search.brave.com/res/v1/web/search?q=${
      encodeURIComponent(query)
    }&count=${count}`

    const res = await fetch(url, {
      headers: {
        'X-Subscription-Token': this.apiKey,
        Accept: 'application/json',
      },
      signal: context?.signal,
    })
    if (!res.ok) return `Error: Brave search returned ${res.status}`

    const data = (await res.json()) as {
      web?: {
        results?: Array<{ title: string; url: string; description: string }>
      }
    }
    const results = data.web?.results ?? []
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
      .join('\n\n') || 'No results found.'
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const query = String(args.query)
    return `🕵️ ${query}`
  }
}

// ── web_search (Firecrawl Search API) ───────────────────────────────────────

interface FirecrawlWebResult {
  title?: string
  description?: string
  url: string
  markdown?: string | null
}

interface FirecrawlSearchResponse {
  success?: boolean
  data?: {
    web?: FirecrawlWebResult[]
  }
  warning?: string | null
  error?: string
}

/**
 * Web search backed by the Firecrawl Search API (https://www.firecrawl.dev/).
 * Uses the v2 `/search` endpoint with the `web` source.
 *
 * Firecrawl is keyless: the REST API works without an `Authorization` header
 * (1,000 free credits per month). Pass an API key to raise that limit.
 * See https://www.firecrawl.dev/blog/firecrawl-keyless-launch
 */
export class FirecrawlSearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description =
    'Search the web using the Firecrawl Search API and return results.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'string', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  }

  private baseUrl: string

  constructor(private apiKey?: string, baseUrl = 'https://api.firecrawl.dev') {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    context?.signal.throwIfAborted()
    const query = String(args.query)
    const count = Number(args.count ?? 5)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    // Keyless requests omit Authorization; a key only raises the credit limit.
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    const res = await fetch(`${this.baseUrl}/v2/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        limit: count,
        sources: [{ type: 'web' }],
      }),
      signal: context
        ? AbortSignal.any([context.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as FirecrawlSearchResponse
        if (body.error) detail = `: ${body.error}`
      } catch {
        // non-JSON error body
      }
      if (res.status === 401 || res.status === 403) {
        return `Error: Firecrawl rejected the API key (${res.status})${detail}`
      }
      if (res.status === 429) {
        return (
          `Error: Firecrawl rate limit reached (${res.status})${detail}\n` +
          'Keyless usage is capped at 1,000 credits/month. Set FIRECRAWL_API_KEY to raise the limit.'
        )
      }
      return `Error: Firecrawl search returned ${res.status}${detail}`
    }

    const data = (await res.json()) as FirecrawlSearchResponse
    const results = (data.data?.web ?? []).slice(0, count)
    if (results.length === 0) return 'No results found.'

    return results
      .map((r, i) => {
        const lines = [`${i + 1}. ${r.title ?? r.url}`, `   ${r.url}`]
        if (r.description) lines.push(`   ${r.description}`)
        return lines.join('\n')
      })
      .join('\n\n')
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const query = String(args.query)
    return `🔥 ${query}`
  }
}
