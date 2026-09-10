import type { Tool, ToolParameters } from './tool.ts'
import { env } from 'node:process'

// ── SearXNG detection ────────────────────────────────────────────────────────

const SEARXNG_PROBE_PORTS = [8888, 8080, 8081, 80]
const SEARXNG_PROBE_HOSTS = ['localhost', 'searxng']
const SEARXNG_PROBE_TIMEOUT_MS = 2_000

function normalizeSearXNGBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

async function probeSearXNGBase(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/search?q=test&format=json`, {
      signal: AbortSignal.timeout(SEARXNG_PROBE_TIMEOUT_MS),
    })
    if (res.ok || res.status === 429) {
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('json') || (await res.text()).includes('searxng')) {
        return base
      }
    }
  } catch {
    // JSON output may be disabled or slower than the probe timeout.
  }

  try {
    const htmlRes = await fetch(`${base}/`, {
      signal: AbortSignal.timeout(SEARXNG_PROBE_TIMEOUT_MS),
    })
    if (htmlRes.ok) {
      const body = await htmlRes.text()
      if (body.toLowerCase().includes('searxng')) {
        return base
      }
    }
  } catch {
    // host not reachable or timed out
  }

  return null
}

/**
 * Probe a single host:port to check if SearXNG is running there.
 * The bot container already sets NO_PROXY for localhost and the compose
 * service name, so normal fetch is sufficient here.
 */
async function probeSearXNG(
  host: string,
  port: number,
): Promise<string | null> {
  return await probeSearXNGBase(`http://${host}:${port}`)
}

/**
 * Probe common hosts/ports to detect a running SearXNG instance.
 * Checks both localhost (native) and 'searxng' (Docker compose service name).
 * All probes run in parallel for fast detection.
 * Returns the base URL (e.g. "http://searxng:8080") or null if not found.
 */
export async function detectSearXNG(): Promise<string | null> {
  const explicitBase = env.SEARXNG_URL
  if (explicitBase?.trim()) {
    const normalizedBase = normalizeSearXNGBase(explicitBase)
    const detected = await probeSearXNGBase(normalizedBase)
    if (detected) return detected
  }

  const probes: Promise<string | null>[] = []
  for (const host of SEARXNG_PROBE_HOSTS) {
    for (const port of SEARXNG_PROBE_PORTS) {
      probes.push(probeSearXNG(host, port))
    }
  }
  const results = await Promise.all(probes)
  return results.find((r) => r !== null) ?? null
}

// ── web_search (SearXNG) ─────────────────────────────────────────────────────

interface SearXNGResult {
  title: string
  url: string
  content?: string
  publishedDate?: string | null
  pubdate?: string | null
  engines?: string[]
  template?: string
  iframe_src?: string
}

interface SearXNGResponse {
  results?: SearXNGResult[]
  answers?: string[]
  infoboxes?: Array<
    {
      infobox: string
      content?: string
      urls?: Array<{ title: string; url: string }>
    }
  >
  suggestions?: string[]
}

function serializeSearXNGResponse(
  data: SearXNGResponse,
  count: number,
): string {
  const parts: string[] = []

  // Direct answers (highest signal)
  const answers = data.answers?.filter(Boolean) ?? []
  if (answers.length > 0) {
    parts.push(`DIRECT ANSWERS:\n${answers.map((a) => `  • ${a}`).join('\n')}`)
  }

  // Infoboxes
  for (const box of data.infoboxes ?? []) {
    const lines = [`INFOBOX: ${box.infobox}`]
    if (box.content) lines.push(box.content)
    if (box.urls?.length) {
      lines.push(
        '  See also: ' +
          box.urls.map((u) => `${u.title} — ${u.url}`).join(', '),
      )
    }
    parts.push(lines.join('\n'))
  }

  // Web results
  const results = (data.results ?? []).slice(0, count)
  if (results.length === 0 && parts.length === 0) return 'No results found.'

  const resultLines = results.map((r, i) => {
    const lines = [`${i + 1}. ${r.title}`, `   URL: ${r.url}`]
    if (r.content) lines.push(`   ${r.content}`)
    const date = r.publishedDate ?? r.pubdate
    if (date) lines.push(`   Published: ${date.slice(0, 10)}`)
    if (r.engines?.length) lines.push(`   Sources: ${r.engines.join(', ')}`)
    return lines.join('\n')
  })
  if (resultLines.length > 0) parts.push(resultLines.join('\n\n'))

  // Related suggestions
  const suggestions = data.suggestions?.slice(0, 5) ?? []
  if (suggestions.length > 0) {
    parts.push(`RELATED: ${suggestions.join(' | ')}`)
  }

  return parts.join('\n\n---\n\n')
}

export class SearXNGSearchTool implements Tool {
  readonly name = 'web_search'
  readonly readonly = true
  readonly description =
    'Search the web using a local SearXNG instance and return results.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'string', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  }

  constructor(private baseUrl: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query)
    const count = Number(args.count ?? 5)
    const url = `${this.baseUrl}/search?q=${
      encodeURIComponent(query)
    }&format=json`

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      if (res.status === 403) {
        return 'Error: SearXNG JSON output is disabled. Enable `json` in `search.formats`.'
      }
      return `Error: SearXNG returned ${res.status}`
    }

    const data = (await res.json()) as SearXNGResponse
    return serializeSearXNGResponse(data, count)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `🔍 ${String(args.query)}`
  }
}

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

  async execute(args: Record<string, unknown>): Promise<string> {
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

  async execute(args: Record<string, unknown>): Promise<string> {
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
      signal: AbortSignal.timeout(60_000),
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
