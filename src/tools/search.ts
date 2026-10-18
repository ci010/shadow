import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { isAbsolute } from 'node:path'
import { isVirtualPath, type VirtualFs } from '../vfs/virtual-fs.ts'
import { detectRipgrep, GlobTool, GrepTool, installRipgrep } from './ripgrep.ts'

/**
 * Parse a space like "grep:*.ts" into { scheme, qualifier }.
 * Supports: "grep:", "grep:*.ts", "glob:src/", "web:", "web:github.com"
 * Also accepts bare scheme: "grep", "glob", "web".
 */
function parseSpace(space: string): { scheme: string; qualifier: string } {
  const sep = space.indexOf(':')
  if (sep === -1) return { scheme: space, qualifier: '' }
  return { scheme: space.slice(0, sep), qualifier: space.slice(sep + 1) }
}

/**
 * Unified search tool that dispatches to glob, grep or web search
 * based on the implementation name in `handler`.
 */
export class SearchTool implements Tool {
  readonly name = 'search'
  readonly supportsRemoteWorkdir = true
  readonly readonly = true
  readonly description = 'Search names with glob, content with grep, or the web. Virtual searches return read paths without activating skills, connecting services or launching browsers.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Glob pattern, regex or web keywords. Use ** to list virtual entries.',
      },
      handler: {
        type: 'string', enum: ['grep', 'glob', 'web'],
        description: 'Search implementation: grep (content), glob (names), or web. Bare names only; put file/virtual scope in path and web scope in domain.',
      },
      domain: { type: 'string', description: 'web only: restrict results to a DNS domain, e.g. github.com. No URL, path or site: prefix.' },
      path: { type: 'string', description: 'File/directory search root or v:<folder>[/path]. Defaults to the effective workdir, not the repository root.' },
      include: { type: 'string', description: 'grep only: relative file glob, e.g. **/*.ts. Not the search root.' },
      limit: { type: 'integer', description: 'File/virtual searches: 1-100 results per page (default 100).' },
      offset: { type: 'integer', description: 'File/virtual searches: nonnegative result offset (default 0).' },
    },
    required: ['handler', 'query'],
    additionalProperties: false,
  }

  private glob: GlobTool
  private grep: GrepTool
  private ripgrepAvailable: boolean | undefined
  private installAttempted = false
  private workspace: string

  constructor(
    workspace: string,
    private webSearchTool?: Tool,
    virtualFs?: VirtualFs,
    private autoInstallRipgrep = true,
  ) {
    this.workspace = workspace
    this.glob = new GlobTool(workspace, virtualFs)
    this.grep = new GrepTool(workspace, virtualFs)
  }

  private async checkRipgrepAvailable(): Promise<boolean> {
    if (this.ripgrepAvailable === true) return true
    // Re-check each time until rg is found (background install may have finished)
    this.ripgrepAvailable = await detectRipgrep()
    if (this.ripgrepAvailable) return true
    if (!this.autoInstallRipgrep) return false

    // Only attempt install once (singleton handles concurrency + timeout)
    if (this.installAttempted) return false
    this.installAttempted = true

    const result = await installRipgrep(this.workspace)
    if (result.success) {
      this.ripgrepAvailable = true
    } else {
      console.warn(`[search] ripgrep auto-install failed: ${result.message}`)
    }
    return this.ripgrepAvailable ?? false
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    // Runtime-only compatibility for stored calls. Never advertise the overloaded legacy field.
    if (args.handler !== undefined && args.space !== undefined) return 'Error: use handler, not both handler and legacy space.'
    const legacy = args.handler === undefined && typeof args.space === 'string'
    const { scheme, qualifier } = legacy ? parseSpace(args.space as string) : { scheme: args.handler, qualifier: '' }
    if (typeof scheme !== 'string' || !['grep', 'glob', 'web'].includes(scheme)) return 'Error: handler must be a bare implementation name: grep, glob or web. Put file/virtual scope in path and web scope in domain.'
    if (Object.keys(args).some(key => !['handler', 'domain', 'space', 'query', 'path', 'include', 'limit', 'offset'].includes(key))) return 'Error: supported search parameters are handler, query, path, include, domain, limit and offset.'
    if (args.domain !== undefined) {
      if (scheme !== 'web') return 'Error: domain is supported only by web.'
      if (typeof args.domain !== 'string' || args.domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(args.domain)) return 'Error: domain must be a DNS domain without URL, path, whitespace or site: prefix.'
      if (qualifier) return 'Error: specify the web domain in domain, not both domain and legacy space.'
    }
    if (typeof args.query !== 'string') return 'Error: query must be a string.'
    // File-only options are harmless on web searches; do not reject the request.
    const ignoredWebOptions = scheme === 'web'
      ? ['path', 'include', 'limit', 'offset'].filter(key => args[key] !== undefined)
      : []
    if (scheme !== 'web') {
      for (const key of ['path', 'include']) {
        if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key])) return `Error: ${key} must be a nonempty string.`
      }
      if (args.include !== undefined && scheme !== 'grep') return 'Error: include is supported only by grep.'
      if (typeof args.include === 'string' && isAbsolute(args.include)) return 'Error: include is a relative file glob; put the search root in path.'
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) return 'Error: limit must be an integer from 1 to 100.'
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) return 'Error: offset must be a nonnegative safe integer.'
    }
    const query = args.query
    let root = typeof args.path === 'string' ? args.path : undefined
    let include = typeof args.include === 'string' ? args.include : undefined
    if (scheme === 'glob' || scheme === 'grep' && (isVirtualPath(qualifier) || isAbsolute(qualifier))) {
      if (qualifier) {
        if (root !== undefined) return 'Error: specify the search root either in path or in space, not both.'
        if (!isVirtualPath(qualifier) && /[*?]/.test(qualifier)) return 'Error: put the directory in path and the file glob in include (grep) or query (glob).'
        root = qualifier
      }
    } else if (scheme === 'grep' && qualifier) {
      if (include !== undefined) return 'Error: specify the file glob either in include or in space, not both.'
      include = qualifier
    }
    const virtualPath = ['grep', 'glob'].includes(scheme) && root && isVirtualPath(root) ? root
      : scheme === 'glob' && !root && isVirtualPath(query) ? query.split(/[\\/]/)[0] : undefined
    if (context.remoteWorkdir && (!virtualPath || !/^v:sessions(?:[\\/]|$)/.test(virtualPath))) {
      return 'Error: only v:sessions searches are supported with a remote workdir.'
    }

    switch (scheme) {
      case 'glob':
      case 'grep': {
        const ripgrepReady = virtualPath || await this.checkRipgrepAvailable()
        if (!ripgrepReady) {
          return (
            `ripgrep (rg) is not available. File search requires ripgrep.\n` +
            `To install: read("v:skills/install-ripgrep") for instructions.`
          )
        }

        if (scheme === 'glob') {
          const delegateArgs: Record<string, unknown> = { pattern: query, limit: args.limit, offset: args.offset }
          if (root) delegateArgs.path = root
          return await this.glob.execute(delegateArgs, context)
        } else {
          const delegateArgs: Record<string, unknown> = { pattern: query, limit: args.limit, offset: args.offset }
          if (root) delegateArgs.path = root
          if (include) delegateArgs.include = include
          return await this.grep.execute(delegateArgs, context)
        }
      }

      case 'web': {
        if (!this.webSearchTool) {
          return 'Error: web search is not configured for this search tool.'
        }
        const domain = args.domain ?? qualifier
        const webQuery = domain
          ? `${query} site:${domain}`
          : query
        try {
          const result = await this.webSearchTool.execute({ query: webQuery }, context)
          return ignoredWebOptions.length
            ? `Warning: web search ignores unsupported parameters: ${ignoredWebOptions.join(', ')}. Results are not filtered or paginated by these parameters.\n\n${result}`
            : result
        } catch (err) {
          context.signal.throwIfAborted()
          const msg = err instanceof Error ? err.message : String(err)
          return (
            `Web search failed: ${msg}\n\n` +
            'Check network access to the search provider and its service status, API credentials, and usage limits.'
          )
        }
      }

      default:
        throw new Error(`Unhandled search handler: ${scheme}`)
    }
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const handler = String(args.handler ?? args.space ?? '?')
    const scope = args.domain ?? args.path
    const query = String(args.query ?? '')
    return `🔍 ${handler}${scope ? ` ${scope}` : ''} ${query}`
  }
}
