import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
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
 * based on the URI-style `space` parameter.
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
      space: {
        type: 'string',
        description:
          'grep:[file-glob] or grep:v:<folder>[/path] — contents. glob:[path] — names. Virtual folders: skills, memory, sessions, tools. web:[domain] — web search.',
      },
      limit: { type: 'integer', description: 'Virtual searches only: 1-100 results per page (default 100).' },
      offset: { type: 'integer', description: 'Virtual searches only: nonnegative result offset (default 0).' },
    },
    required: ['space', 'query'],
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
    if (typeof args.space !== 'string') return 'Error: space must be a string.'
    const { scheme, qualifier } = parseSpace(args.space)
    if (!['grep', 'glob', 'web'].includes(scheme)) return `Error: unknown search space "${scheme}". Use grep:, glob: or web:; virtual folders require grep:v:<folder> or glob:v:<folder>.`
    if (Object.keys(args).some(key => !['space', 'query', 'limit', 'offset'].includes(key))) return 'Error: supported search parameters are space, query, limit and offset.'
    if (typeof args.query !== 'string') return 'Error: query must be a string.'
    const query = args.query
    const virtualPath = ['grep', 'glob'].includes(scheme) && isVirtualPath(qualifier) ? qualifier
      : scheme === 'glob' && !qualifier && isVirtualPath(query) ? query.split(/[\\/]/)[0] : undefined
    if (context.remoteWorkdir && (!virtualPath || !/^v:sessions(?:[\\/]|$)/.test(virtualPath))) {
      return 'Error: only v:sessions searches are supported with a remote workdir.'
    }
    if (!virtualPath && (args.limit !== undefined || args.offset !== undefined)) return 'Error: limit and offset apply only to virtual searches.'

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
          if (qualifier) delegateArgs.path = qualifier
          return await this.glob.execute(delegateArgs, context)
        } else {
          const delegateArgs: Record<string, unknown> = { pattern: query, limit: args.limit, offset: args.offset }
          if (virtualPath) delegateArgs.path = virtualPath
          else if (qualifier) delegateArgs.include = qualifier
          return await this.grep.execute(delegateArgs, context)
        }
      }

      case 'web': {
        if (!this.webSearchTool) {
          return 'Error: web search is not configured for this search tool.'
        }
        const webQuery = qualifier
          ? `${query} site:${qualifier}`
          : query
        try {
          return await this.webSearchTool.execute({ query: webQuery }, context)
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
        throw new Error(`Unhandled search space: ${scheme}`)
    }
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const space = String(args.space ?? '?')
    const query = String(args.query ?? '')
    return `🔍 ${space} ${query}`
  }
}
