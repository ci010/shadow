import type { ExecutionContext } from '../agent/agent.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { VirtualFs } from '../vfs/virtual-fs.ts'
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
 * Unified search tool that dispatches to glob, grep, or web search
 * based on the URI-style `space` parameter.
 */
export class SearchTool implements Tool {
  readonly name = 'search'
  readonly readonly = true
  readonly description = 'Search files or the web via the `space` scheme.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Glob pattern, regex, or keywords depending on space.',
      },
      space: {
        type: 'string',
        description:
          'grep:[glob] — file contents. glob:[path] — file names. web:[domain] — web search.',
      },
    },
    required: ['query', 'space'],
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
    const { scheme, qualifier } = parseSpace(String(args.space))
    const query = String(args.query)

    switch (scheme) {
      case 'glob':
      case 'grep': {
        const ripgrepReady = await this.checkRipgrepAvailable()
        if (!ripgrepReady) {
          return (
            `ripgrep (rg) is not available. File search requires ripgrep.\n` +
            `To install: read("v:skills/install-ripgrep") for instructions.`
          )
        }

        if (scheme === 'glob') {
          const delegateArgs: Record<string, unknown> = { pattern: query }
          if (qualifier) delegateArgs.path = qualifier
          return await this.glob.execute(delegateArgs, context)
        } else {
          const delegateArgs: Record<string, unknown> = { pattern: query }
          if (qualifier) delegateArgs.include = qualifier
          return await this.grep.execute(delegateArgs, context)
        }
      }

      case 'web': {
        if (!this.webSearchTool) {
          return (
            'Web search is not available — no SearXNG instance was detected at startup.\n\n' +
            'To fix this, check the following in order:\n' +
            '1. Is Docker running? Run: docker info\n' +
            '   - If Docker is not installed, read skill "docker-install" → read("v:skills/docker-install")\n' +
            '   - If Docker is installed but not running, start it (e.g. `docker` daemon, Docker Desktop, or `colima start`)\n' +
            '2. Is the SearXNG container running? Run: docker container list\n' +
            '   - If not listed, start it: docker container start searxng\n' +
            '   - If it doesn\'t exist, install it → read("v:skills/searxng") for instructions\n' +
            '3. After SearXNG is running, retry the search.'
          )
        }
        const webQuery = qualifier
          ? `${query} site:${qualifier}`
          : query
        try {
          return await this.webSearchTool.execute({ query: webQuery }, context)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return (
            `Web search failed: ${msg}\n\n` +
            'SearXNG may have stopped or become unreachable.\n' +
            'To fix: check if the SearXNG container is running → docker container list\n' +
            '  - If stopped: docker container start searxng\n' +
            '  - If missing: read("v:skills/searxng") for install instructions\n' +
            '  - If Docker is not running: start Docker first'
          )
        }
      }

      default:
        return `Unknown search space: "${scheme}". Use grep:, glob:, or web:.`
    }
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const space = String(args.space ?? '?')
    const query = String(args.query ?? '')
    return `🔍 ${space} ${query}`
  }
}
