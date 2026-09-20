import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ImportTool } from './load-tool.ts'
import { detectRipgrep, GlobTool, GrepTool, installRipgrep } from './ripgrep.ts'
import type { SkillsManager } from '../skills/loader.ts'
import { searchSkills } from '../skills/search.ts'
import type { TopicService } from '../sessions/topics.ts'

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
 * Unified search tool that dispatches to glob, grep, web, or tool search
 * based on the URI-style `space` parameter.
 */
export class SearchTool implements Tool {
  readonly name = 'search'
  readonly supportsRemoteWorkdir = true
  readonly readonly = (args: Record<string, unknown>) =>
    typeof args.space === 'string' && ['glob', 'grep', 'web', 'skills', 'sessions'].includes(parseSpace(args.space).scheme)
  readonly description = 'Search files, the web, skills, Project topic sessions, or available tools via the `space` scheme. sessions: discovers peer topic goals, scope, folders and Initiative references. skills: returns skill summaries and read paths without activating tools; read a skill to register its declared tools in this session. tools: searches installed MCP indexes without connecting, returning exact names and parameter schemas for invoke_tool. Explicit built-in browser/factory discovery may initialize resources but never executes their tools.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Glob pattern, regex, or keywords depending on space. For tools: and skills:, empty or omitted query lists entries. Skill search matches name, description, category and instructions.',
      },
      space: {
        type: 'string',
        description:
          'grep:[glob] — file contents. glob:[path] — file names. web:[domain] — web search. sessions: — Project peer topic discovery (no activation). skills:[category] — skill discovery without activation. tools:[source] — tool contracts (e.g. tools:mail); tools: searches persisted MCP metadata and active tools without starting configured servers. Browser/factory sources require explicit selection.',
      },
      limit: { type: 'integer', description: 'Maximum entries per page: tools: 1-10 (default 3), skills: and sessions: 1-20 (default 5).' },
      offset: { type: 'integer', default: 0, description: 'tools:, skills: and sessions: only. Nonnegative result offset; use nextOffset to continue listing or searching.' },
      instance: { type: 'string', description: 'tools:chrome-devtools only. Session browser instance ID; required when multiple instances are open. Returns that instance\'s live contracts.' },
    },
    required: ['space'],
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
    private importer?: ImportTool,
    private skills?: SkillsManager,
    private topics?: () => TopicService,
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
    if (args.instance !== undefined && (scheme !== 'tools' || qualifier !== 'chrome-devtools')) {
      return 'Error: instance requires space tools:chrome-devtools.'
    }
    if (scheme === 'sessions') {
      if (!this.topics) return 'Error: Project topic discovery is not configured.'
      if (qualifier) return 'Error: sessions: searches only the current Project; qualifiers are not supported.'
      const topics = this.topics()
      topics.assertActor(context.projectId, context.sessionId)
      return JSON.stringify(await topics.search({ query: args.query, limit: args.limit, offset: args.offset }))
    }
    if (context.remoteWorkdir) return 'Error: only sessions: discovery is supported by search with a remote workdir.'
    if (scheme === 'skills') {
      if (!this.skills) return 'Error: skill discovery is not configured for this search tool'
      return searchSkills(this.skills, { ...args, category: qualifier }, context.admin)
    }
    if (scheme === 'tools') {
      if (!this.importer) return 'Error: tool discovery is not configured for this search tool.'
      return this.importer.searchTools({
        query: args.query,
        source: qualifier || undefined,
        limit: args.limit,
        offset: args.offset,
        instance: args.instance,
      }, context)
    }
    if (typeof args.query !== 'string') return 'Error: query must be a string for file or web search.'
    const query = args.query

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
        return `Unknown search space: "${scheme}". Use grep:, glob:, web:, tools:, or skills:.`
    }
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const space = String(args.space ?? '?')
    const query = String(args.query ?? '')
    return `🔍 ${space} ${query}`
  }
}
