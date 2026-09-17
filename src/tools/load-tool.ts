import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, stat as nodeStat } from 'node:fs/promises'
import type { ExecutionContext } from './context.ts'
import { McpToolAdapter } from '../mcp/adapter.ts'
import { McpConnection } from '../mcp/client.ts'
import { parseMcpConfigDocument, parseMcpServerConfig } from '../mcp/config.ts'
import { mcpCleanupFailure, mcpFailure } from '../mcp/errors.ts'
import { toolSearchScore } from './search-tools.ts'
import type { McpServerConfig } from '../config/schema.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { toolInvocationContract, type SessionTools } from './registry.ts'
import type { ChromeManager } from '../browser/chrome-manager.ts'
import { registerTypeScriptLoader } from '../utils/typescript.ts'
import { getProjectScope } from '../projects/scope.ts'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { SkillToolDeclarationsSchema, resolveSkillToolSource, type SkillToolDeclaration, type SkillDirectoryResolver } from '../skills/tool-declarations.ts'
import type { Skill } from '../skills/loader.ts'

/**
 * Describes an MCP server that can be connected on-demand and whose tools
 * are registered into the session overlay.
 *
 * Connections are managed per-session via {@link SessionTools.getMcpConn} /
 * {@link SessionTools.setMcpConn} and cleaned up when the session sleeps.
 */
export interface McpLoadable {
  config: McpServerConfig
  /**
   * Absolute path to a JSON config file with persistent extra args.
   * Format: `{ "args": ["--browser-path=...", "--profile=..."] }`
   *
   * Written once during setup (guided by the skill), read on every `import_tool` call.
   */
  configPath?: string
  /**
   * When set, only register tools whose unprefixed name is in this set.
   * Tools not in the filter are silently skipped.
   */
  toolFilter?: Set<string>
  /**
   * Pointer to another McpLoadable whose config/connection should be reused.
   * Avoids spawning a second MCP server process for the same server.
   * The connection cache key is derived from the shared entry's config name.
   */
  sharedConn?: McpLoadable
  /**
   * When set, this entry uses the ChromeManager for auto-launching Chrome
   * and allocating ports/user-data-dirs before connecting the MCP server.
   */
  chromeManager?: ChromeManager
}

export type LoadableEntry = Tool | McpLoadable | FactoryLoadable | ScriptLoadable

interface ScriptLoadable {
  script: SkillToolDeclaration & { skill: string; admin?: boolean }
  sourceVersion: string
  resource: { active: boolean }
}

function isScriptLoadable(entry: LoadableEntry): entry is ScriptLoadable {
  return 'script' in entry
}

/**
 * A factory that creates tool(s) on demand — used when a tool needs
 * runtime detection at load time (e.g. SearXNG base URL probing).
 */
export interface FactoryLoadable {
  factory: () => Promise<Tool | Tool[]>
}

function isMcpLoadable(entry: LoadableEntry): entry is McpLoadable {
  return 'config' in entry && !('execute' in entry)
}

function isFactoryLoadable(entry: LoadableEntry): entry is FactoryLoadable {
  return 'factory' in entry
}

/**
 * Shape of a TypeScript module that defines an agent-created tool.
 * The agent writes these into skill directories and loads them via `import_tool(source=...)`.
 */
interface ScriptToolModule {
  name: string
  description: string
  parameters: ToolParameters
  execute: (
    args: Record<string, unknown>,
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<unknown>
  /** Optional init function called at import time with the `args` from `import_tool`. */
  init?: (args: string[]) => Promise<void> | void
  [key: string]: unknown
}

function isScriptToolModule(
  mod: Record<string, unknown>,
): mod is ScriptToolModule {
  return (
    typeof mod.name === 'string' &&
    typeof mod.description === 'string' &&
    typeof mod.parameters === 'object' && mod.parameters !== null &&
    typeof mod.execute === 'function'
  )
}

interface ImportOptions {
  signal: AbortSignal
}

/**
 * Wraps an agent-authored TypeScript tool module as a Tool instance.
 * The module's execute receives a `callTool` callback that dispatches
 * to the session's tool overlay, allowing custom tools to compose
 * with any loaded tool.
 */
class ScriptToolAdapter implements Tool {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters

  constructor(private mod: ScriptToolModule, registeredName?: string, private validate?: (context: ExecutionContext) => Promise<void>) {
    this.name = registeredName ?? mod.name
    this.description = mod.description
    this.parameters = mod.parameters as ToolParameters
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    await this.validate?.(context)
    const callTool = async (
      name: string,
      toolArgs: Record<string, unknown>,
    ): Promise<unknown> => {
      const result = context.tools.hasDynamic(name)
        ? await context.tools.executeDynamic(name, toolArgs, context)
        : context.tools.has(name)
        ? await context.tools.execute(name, toolArgs, context)
        : await context.tools.execute('invoke_tool', { name, args: toolArgs }, context)
      try {
        return JSON.parse(result)
      } catch {
        return result
      }
    }

    const result = await this.mod.execute(args, callTool)
    if (typeof result === 'string') return result
    return JSON.stringify(result, null, 2)
  }
}

/** Scoped browser config fails explicitly on malformed data; legacy imports remain permissive. */
async function readConfigArgs(configPath: string, strict = false): Promise<string[]> {
  try {
    const text = await readFile(configPath, 'utf8')
    const data = JSON.parse(text)
    if (strict && (!data || !Array.isArray(data.args) || !data.args.every((arg: unknown) => typeof arg === 'string'))) {
      throw new Error('Chrome config must contain an args array of strings')
    }
    if (Array.isArray(data.args)) return data.args.map(String)
  } catch (error) {
    if (strict && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  return []
}

const VIRTUAL_TOOLS_PREFIX = 'v:tools/'

/** Only reviewed non-connection switches may reach the managed browser adapter. */
function managedChromeArgs(args: string[]): { args: string[]; port?: number } {
  const forwarded: string[] = []
  let port: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const separator = arg.indexOf('=')
    const flag = separator < 0 ? arg : arg.slice(0, separator)
    const value = separator < 0 ? undefined : arg.slice(separator + 1)
    if (flag === '--remote-debugging-port') {
      const raw = value ?? args[++i]
      if (port !== undefined || !raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
        throw new Error('Managed Chrome requires one valid remote-debugging-port (1-65535)')
      }
      port = Number(raw)
    } else if (/^--(?:no-)?(?:usage-statistics|usageStatistics|performance-crux|performanceCrux|category-emulation|categoryEmulation|category-performance|categoryPerformance|category-network|categoryNetwork)$/.test(flag) &&
      (value === undefined || value === 'true' || value === 'false')) {
      forwarded.push(arg)
    } else {
      throw new Error('Project Chrome accepts only a managed remote-debugging-port and reviewed capability/telemetry switches; external endpoints, auto-connect, profiles and other launch options are not supported')
    }
  }
  return { args: forwarded, port }
}

/**
 * Import a tool or side-effecting resource into the current session.
 *
 * Supports three path forms:
 *  - `v:tools/<name>` — load a pre-registered tool, MCP server, or factory.
 *  - `<path>.ts` — import a TypeScript tool module from the filesystem.
 *  - `<path>.json` — load an MCP server from a JSON config file (standard
 *    `{ mcpServers: { ... } }` or shim `{ command, args, env }` format).
 *
 * Tools registered this way are visible for the rest of the conversation but
 * are cleared on sleep so they never persist across session boundaries.
 */
export class ImportTool implements Tool {
  private readonly configured = new Map<string, McpLoadable>()
  private readonly skillTools = new WeakMap<SessionTools, Map<string, ScriptLoadable>>()
  private readonly builtins: Map<string, LoadableEntry>
  private readonly sessions = new Set<SessionTools>()
  private readonly imports = new WeakMap<SessionTools, Promise<unknown>>()
  private readonly scope = getProjectScope()
  private readonly projectId?: string
  private readonly browserKeys = new WeakMap<SessionTools, Map<string, string>>()
  readonly name = 'import_tool'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Import a tool or MCP server into the current session. ' +
    'Source: v:tools/<name> for pre-registered, .ts for script tools, .json for MCP config files. ' +
    'Read v:tools for available sources. Returns current tool contracts before execution. Active until sleep or configuration changes.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Virtual source (v:tools/<name>) or filesystem path (.ts module, .json MCP config).',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra string arguments. For MCP tools: CLI flags (e.g. ["--remote-debugging-port=9223"]). ' +
          'For .ts modules: passed to the module\'s optional init(args) function.',
      },
      server: {
        type: 'string',
        description: 'Optional server name when importing a multi-server JSON config. Omit to import all entries.',
      },
    },
    required: ['source'],
  }

  constructor(
    private loadable: Map<string, LoadableEntry>,
    private workspace: string,
    private chromeManager?: ChromeManager,
    private getSkillDirectory: SkillDirectoryResolver = () => undefined,
  ) {
    this.builtins = new Map(loadable)
    this.projectId = this.scope?.projectId ?? chromeManager?.projectId
    if (this.scope && chromeManager && chromeManager.projectId !== this.projectId) {
      throw new Error('Import tool Chrome project binding mismatch')
    }
  }

  isBuiltinName(name: string): boolean { return this.builtins.has(name) }

  registerBuiltin(name: string, entry: LoadableEntry): void {
    if (this.configured.has(name) || [...this.sessions].some(tools => this.skillTools.get(tools)?.has(name))) {
      throw new Error(`Built-in source "${name}" conflicts with an installed catalog source`)
    }
    this.builtins.set(name, entry)
    this.loadable.set(name, entry)
  }

  private catalogFor(tools: SessionTools): Map<string, LoadableEntry> {
    return new Map([...this.loadable, ...(this.skillTools.get(tools) ?? [])])
  }

  async registerSkillTools(skill: Skill, context: ExecutionContext): Promise<string[]> {
    if (skill.meta.toolsError) throw new Error(`Invalid tools in skill "${skill.meta.name}": ${skill.meta.toolsError}`)
    const declarations = SkillToolDeclarationsSchema.parse(skill.meta.tools ?? {})
    if (Object.keys(declarations).length && context.remoteWorkdir) throw new Error('Skill TypeScript tools require a local workdir')
    if (skill.meta.admin && !context.admin) throw new Error('This skill requires an admin session')
    if (this.projectId && context.projectId !== this.projectId) throw new Error('Skill tool Project binding mismatch')
    const signal = AbortSignal.any([context.signal, context.tools.dynamicSignal])
    return this.withImports(context.tools, signal, async () => {
      const current = this.skillTools.get(context.tools) ?? new Map<string, ScriptLoadable>()
      const next = new Map<string, ScriptLoadable>()
      for (const [name, declaration] of Object.entries(declarations)) {
        if (!context.tools.has('invoke_tool') || !context.tools.canUseDynamic(name)) {
          throw new Error(`Skill tool "${name}" is not available for this agent type`)
        }
        const previous = current.get(name)
        if (context.tools.has(name) || this.loadable.has(name) || name === 'import_tool' || name === 'install_tool' ||
          (previous && previous.script.skill !== skill.meta.name) ||
          (!previous && context.tools.hasDynamic(name))) {
          throw new Error(`Skill tool "${name}" conflicts with an existing tool; choose another frontmatter alias`)
        }
        const source = await resolveSkillToolSource(skill.meta.name, declaration.source, this.getSkillDirectory)
        const info = await nodeStat(source, { bigint: true })
        const sourceVersion = `${info.mtimeNs}:${info.ctimeNs}:${info.size}`
        const script = { ...declaration, source, skill: skill.meta.name, admin: skill.meta.admin }
        next.set(name, previous && previous.sourceVersion === sourceVersion && isDeepStrictEqual(previous.script, script)
          ? previous : { script, sourceVersion, resource: { active: true } })
      }
      signal.throwIfAborted()
      for (const [name, entry] of current) {
        if (entry.script.skill === skill.meta.name && next.get(name) !== entry) {
          entry.resource.active = false
          current.delete(name)
        }
      }
      for (const [name, entry] of next) current.set(name, entry)
      this.skillTools.set(context.tools, current)
      return [...next.keys()]
    })
  }

  async updateMcpServers(servers: McpServerConfig[]): Promise<void> {
    for (const tools of this.sessions) {
      for (const server of servers) {
        if (this.skillTools.get(tools)?.has(server.name)) {
          throw new Error(`MCP source "${server.name}" conflicts with an active skill tool; choose another server name`)
        }
      }
    }
    const next = new Map<string, McpLoadable>()
    for (const server of servers) {
      const config = parseMcpServerConfig(server.name, server)
      if (next.has(config.name)) throw new Error(`Duplicate MCP server "${config.name}"`)
      const existing = this.configured.get(config.name)
      next.set(config.name, existing && JSON.stringify(existing.config) === JSON.stringify(config)
        ? existing : { config })
    }
    const changed = new Set<string>()
    for (const name of new Set([...this.configured.keys(), ...next.keys()])) {
      if (this.configured.get(name) === next.get(name)) continue
      changed.add(name)
      const entry = next.get(name) ?? this.builtins.get(name)
      if (entry) this.loadable.set(name, entry)
      else this.loadable.delete(name)
    }
    this.configured.clear()
    for (const [name, entry] of next) this.configured.set(name, entry)
    const results = await Promise.allSettled([...this.sessions].map(tools => tools.invalidateMcpServers(changed)))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'MCP catalog updated, but old connection cleanup failed')
  }

  catalogEntries(tools: SessionTools): Array<{ name: string; content: string }> {
    if ((!tools.has('read') && !tools.has('import_tool') && !tools.has('search')) || !tools.has('invoke_tool')) return []
    return [...this.catalogFor(tools)].map(([name, entry]) => ({
      name,
      content: JSON.stringify({
        source: `${VIRTUAL_TOOLS_PREFIX}${name}`,
        kind: isMcpLoadable(entry) ? 'mcp' : isScriptLoadable(entry) ? 'typescript' : 'tool',
        ...(isScriptLoadable(entry) ? { skill: entry.script.skill } : {}),
        description: isMcpLoadable(entry)
          ? entry.config.description ?? `MCP server ${entry.config.name} (${entry.config.transport})`
          : isFactoryLoadable(entry) ? `On-demand tool ${name}`
          : isScriptLoadable(entry) ? `Skill TypeScript tool ${name}; loaded on tool discovery or invocation` : entry.description,
      }),
    }))
  }

  readCatalog(name: string, tools: SessionTools): string {
    const entries = this.catalogEntries(tools)
    if (!name) return entries.length ? entries.map(entry => entry.content).join('\n')
      : 'No dynamic tool sources are available for this agent.'
    return entries.find(entry => entry.name === name)?.content ?? `Error: unknown or unavailable source "${name}".`
  }

  async searchTools(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (!context.tools.has('search') || !context.tools.has('invoke_tool')) {
      return 'Error: tool search and invocation are not available for this agent type.'
    }
    if (args.query !== undefined && typeof args.query !== 'string') return 'Error: query must be a string.'
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (query.length > 500) return 'Error: query must contain at most 500 characters.'
    const limit = args.limit === undefined ? 3 : args.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
      return 'Error: limit must be an integer from 1 through 10.'
    }
    const offset = args.offset === undefined ? 0 : args.offset
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      return 'Error: offset must be a nonnegative safe integer.'
    }
    if (args.source !== undefined && (typeof args.source !== 'string' || !args.source.trim())) {
      return 'Error: source must be a nonempty catalog source.'
    }
    const selected = typeof args.source === 'string'
      ? args.source.replace(/^v:tools\//, '') : undefined
    if (selected !== undefined && !this.catalogFor(context.tools).has(selected)) return `Error: unknown catalog source "${selected}".`
    const signal = AbortSignal.any([context.signal, context.tools.dynamicSignal])
    return this.withImports(context.tools, signal, async () => {
      const candidates = new Map<string, { tool: Tool; source?: string }>()
      const errors: Array<{ source: string; message: string }> = []
      const searchedSources: string[] = []
      const deferredSources: string[] = []
      const sources = [...this.catalogFor(context.tools)].filter(([name]) => selected === undefined || name === selected)
      const scan = async ([name, entry]: [string, LoadableEntry]) => {
        const source = `${VIRTUAL_TOOLS_PREFIX}${name}`
        if (selected === undefined && (isFactoryLoadable(entry) ||
          (isMcpLoadable(entry) && (!this.configured.has(name) || entry.config.name === 'chrome-devtools' ||
            entry.chromeManager || entry.sharedConn?.chromeManager)))) {
          deferredSources.push(source)
          return
        }
        const denied = this.contextError(source, context)
        if (denied) {
          errors.push({ source, message: denied })
          return
        }
        try {
          const result = await this.loadByName(name, context.tools, [], {
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          })
          signal.throwIfAborted()
          if (typeof result === 'string') {
            errors.push({ source, message: result })
            return
          }
          searchedSources.push(source)
          for (const tool of result) {
            if (context.tools.canUseDynamic(tool.name)) candidates.set(tool.name, { tool, source })
          }
        } catch (error) {
          signal.throwIfAborted()
          errors.push({ source, message: mcpFailure(error, {
            phase: 'connect', source, config: isMcpLoadable(entry) ? entry.config : undefined,
          }).message })
        }
      }
      for (let start = 0; start < sources.length; start += 3) {
        signal.throwIfAborted()
        const outcomes = await Promise.allSettled(sources.slice(start, start + 3).map(scan))
        signal.throwIfAborted()
        const failed = outcomes.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      if (selected === undefined) {
        for (const tool of context.tools.activeDynamicTools()) {
          if (!candidates.has(tool.name)) candidates.set(tool.name, { tool })
        }
      }
      const ranked = [...candidates.values()]
        .filter(({ tool }) => context.tools.hasDynamic(tool.name))
        .map(candidate => ({ ...candidate, score: toolSearchScore(query, candidate.tool, candidate.source) }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en'))
      return JSON.stringify({
        tools: ranked.slice(offset, offset + limit).map(({ tool, source }) => ({
          name: tool.name, source, description: tool.description, parameters: tool.parameters,
        })),
        totalMatches: ranked.length,
        hasMore: ranked.length > offset + limit,
        nextOffset: ranked.length > offset + limit ? offset + limit : null,
        searchedSources: searchedSources.sort(),
        deferredSources: deferredSources.sort(),
        errors,
      })
    })
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const extra = Array.isArray(args.args) && args.args.length > 0
      ? ` ${(args.args as string[]).join(' ')}`
      : ''
    return `🔌 ${String(args.source ?? '')}${extra}`
  }

  async importSource(
    args: Record<string, unknown>,
    tools: SessionTools,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const signal = options.signal ? AbortSignal.any([options.signal, tools.dynamicSignal]) : tools.dynamicSignal
    return this.withImports(tools, signal, () => this.performImport(args, tools, { signal }))
  }

  private async withImports<T>(tools: SessionTools, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (!this.sessions.has(tools)) {
      this.sessions.add(tools)
      tools.onReset(() => {
        this.sessions.delete(tools)
        for (const entry of this.skillTools.get(tools)?.values() ?? []) entry.resource.active = false
        this.skillTools.delete(tools)
      })
    }
    const pending = (this.imports.get(tools) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted()
        return action()
      })
    this.imports.set(tools, pending)
    try {
      return await pending
    } finally {
      if (this.imports.get(tools) === pending) this.imports.delete(tools)
    }
  }

  private async performImport(
    args: Record<string, unknown>,
    tools: SessionTools,
    options: ImportOptions,
  ): Promise<string> {
    const path = typeof args.source === 'string' ? args.source : undefined
    if (args.args !== undefined && (!Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string'))) {
      return 'Error: args must be an array of strings.'
    }
    if (args.server !== undefined && (typeof args.server !== 'string' || !args.server.trim())) {
      return 'Error: server must be a nonempty string.'
    }
    const extraArgs: string[] = Array.isArray(args.args) ? args.args : []

    if (!path) {
      return 'Error: `source` is required. Use v:tools/<name> for pre-registered tools, .ts for script tools, .json for MCP config files.'
    }

    // Virtual tool path: v:tools/<name>
    if (path.startsWith(VIRTUAL_TOOLS_PREFIX)) {
      if (args.server !== undefined) return 'Error: server selects an entry in a JSON config; omit it for virtual sources.'
      const name = path.slice(VIRTUAL_TOOLS_PREFIX.length)
      if (!name) {
        return this.readCatalog('', tools)
      }
      const entry = this.loadable.get(name)
      const result = await this.loadByName(name, tools, extraArgs, options)
      if (typeof result === 'string') return result
      const summary = entry && isMcpLoadable(entry)
        ? `Loaded ${result.length} tool(s) from MCP server "${name}" for this session.`
        : `Tool "${name}" loaded for this session.`
      return `${summary}\n${toolInvocationContract(result)}`
    }

    // JSON MCP config file
    if (path.endsWith('.json')) {
      return await this.loadFromJsonConfig(path, tools, extraArgs, args.server, options)
    }

    // TypeScript module
    if (path.endsWith('.ts')) {
      if (args.server !== undefined) return 'Error: server selects an entry in a JSON config; omit it for script tools.'
      return await this.loadFromPath(path, tools, extraArgs, options)
    }

    return `Error: unrecognized source "${path}". Use v:tools/<name>, a .ts module path, or a .json MCP config file.`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const error = this.contextError(String(args.source ?? ''), context)
    if (error) return error
    return await this.importSource(args, context.tools, { signal: context.signal })
  }

  private contextError(source: string, context: ExecutionContext): string | undefined {
    if (context.remoteWorkdir &&
      (source !== `${VIRTUAL_TOOLS_PREFIX}initiative` || !this.canInvokeFromRemote('initiative'))) {
      return 'Error: remote workdirs can import only the built-in Project-Home initiative tool.'
    }
    const entry = source.startsWith(VIRTUAL_TOOLS_PREFIX) ? this.loadable.get(source.slice(VIRTUAL_TOOLS_PREFIX.length)) : undefined
    if (entry && isMcpLoadable(entry)) {
      const manager = entry.chromeManager ?? entry.sharedConn?.chromeManager ?? this.chromeManager
      if ((entry.config.name === 'chrome-devtools' || entry.chromeManager || entry.sharedConn?.chromeManager) &&
        context.projectId !== (this.projectId ?? manager?.projectId)) {
        return 'Error: import tool Chrome project binding mismatch'
      }
    }
    return undefined
  }

  canInvokeFromRemote(toolName: string): boolean {
    const entry = this.loadable.get(toolName)
    return toolName === 'initiative' && entry !== undefined && entry === this.builtins.get(toolName) &&
      !isMcpLoadable(entry) && !isFactoryLoadable(entry) && !isScriptLoadable(entry) && entry.supportsRemoteWorkdir === true
  }

  /** Import the catalog entry that owns a dynamic tool name, when determinable. */
  async importForInvocation(
    toolName: string,
    sessionTools: SessionTools,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!sessionTools.canUseDynamic(toolName)) return undefined
    if (sessionTools.hasDynamic(toolName)) return undefined
    const activeSignal = signal ? AbortSignal.any([signal, sessionTools.dynamicSignal]) : sessionTools.dynamicSignal
    const load = (name: string) => this.withImports(sessionTools, activeSignal, async () => {
      const result = await this.loadByName(name, sessionTools, [], { signal: activeSignal })
      return typeof result === 'string' ? result : undefined
    })

    if (this.catalogFor(sessionTools).has(toolName)) {
      return await load(toolName)
    }

    const separator = toolName.indexOf('__')
    if (separator <= 0) return undefined
    const serverName = toolName.slice(0, separator)
    const unprefixedName = toolName.slice(separator + 2)
    let result: string | undefined

    for (const [catalogName, entry] of this.loadable) {
      if (!isMcpLoadable(entry) || entry.config.name !== serverName) continue
      if (entry.toolFilter && !entry.toolFilter.has(unprefixedName)) continue

      result = await load(catalogName)
      if (sessionTools.hasDynamic(toolName)) return result
      result ??= `Error: tool "${toolName}" is not advertised by server "${serverName}". Use search with space "tools:" for current tool IDs.`
    }
    return result
  }

  private async loadByName(
    name: string,
    tools: SessionTools,
    extraArgs: string[],
    options: ImportOptions,
  ): Promise<Tool[] | string> {
    const entry = this.catalogFor(tools).get(name)
    if (!entry) {
      const available = [...this.loadable.keys()]
      const hint = available.length > 0
        ? ` Available: ${available.join(', ')}`
        : ' No tools are currently available to load.'
      return `Unknown tool "${name}".${hint}`
    }

    if (isMcpLoadable(entry)) {
      return await this.loadMcp(name, entry, tools, extraArgs, options)
    }

    if (isFactoryLoadable(entry)) {
      return await this.loadFactory(name, entry, tools, options)
    }

    if (isScriptLoadable(entry)) {
      await resolveSkillToolSource(entry.script.skill, entry.script.source, this.getSkillDirectory)
      if (tools.hasDynamic(name)) return tools.activeDynamicTools().filter(tool => tool.name === name)
      return this.loadScript(entry.script.source, tools, entry.script.args ?? [], options, name, entry.resource, async context => {
        if (!entry.resource.active) throw new Error('Skill tool registration expired; read the skill again')
        if (entry.script.admin && !context.admin) throw new Error('This skill requires an admin session')
        if (context.remoteWorkdir) throw new Error('Skill TypeScript tools require a local workdir')
        if (this.projectId && context.projectId !== this.projectId) throw new Error('Skill tool Project binding mismatch')
        await resolveSkillToolSource(entry.script.skill, entry.script.source, this.getSkillDirectory)
      })
    }

    // Plain Tool
    options.signal.throwIfAborted()
    tools.registerDynamic(entry)
    return [entry]
  }

  private async loadMcp(
    name: string,
    entry: McpLoadable,
    sessionTools: SessionTools,
    extraCliArgs: string[],
    options: ImportOptions,
  ): Promise<Tool[] | string> {
    // If this entry shares a connection with another loadable, resolve it
    const connOwner = entry.sharedConn ?? entry
    const connKey = extraCliArgs.length > 0
      ? `${connOwner.config.name}:${extraCliArgs.join(',')}`
      : connOwner.config.name

    const chromeManager = entry.chromeManager ?? connOwner.chromeManager ??
      (connOwner.config.name === 'chrome-devtools' ? this.chromeManager : undefined)
    const scope = getProjectScope()
    const projectId = this.projectId ?? scope?.projectId ?? chromeManager?.projectId
    const managedChrome = projectId !== undefined &&
      (chromeManager !== undefined || connOwner.config.name === 'chrome-devtools' ||
        name === 'chrome-devtools' || name === 'chrome-devtools-full')
    if (managedChrome && (!chromeManager || chromeManager.projectId !== projectId ||
      (scope && (scope.projectId !== projectId || (this.scope && scope !== this.scope))) ||
      this.scope?.closed)) {
      return 'Error: project Chrome requires its own runtime-managed browser'
    }
    let configArgs: string[]
    try {
      const configPath = entry.configPath ?? connOwner.configPath
      configArgs = configPath ? await readConfigArgs(configPath, managedChrome) : []
    } catch (error) {
      return `Error loading project Chrome config: ${error instanceof Error ? error.message : String(error)}`
    }
    let effectiveArgs = [...(connOwner.config.args ?? []), ...configArgs, ...extraCliArgs]
    if (managedChrome && chromeManager) {
      let parsed: ReturnType<typeof managedChromeArgs>
      try {
        const [packageName, ...baseArgs] = connOwner.config.args ?? []
        if (connOwner.config.transport !== 'stdio' || connOwner.config.url ||
          !packageName || !/^chrome-devtools-mcp(?:@[a-zA-Z0-9.*^~+-]+)?$/.test(packageName)) {
          throw new Error('Project Chrome requires the built-in managed Chrome DevTools adapter')
        }
        parsed = managedChromeArgs([...baseArgs, ...configArgs, ...extraCliArgs])
        effectiveArgs = [packageName, ...parsed.args]
      } catch (error) {
        return `Error loading project Chrome: ${error instanceof Error ? error.message : String(error)}`
      }
      let keys = this.browserKeys.get(sessionTools)
      if (!keys) {
        keys = new Map()
        this.browserKeys.set(sessionTools, keys)
      }
      let key = keys.get(connKey)
      if (!key) {
        key = crypto.randomUUID()
        keys.set(connKey, key)
        const allocationKey = key
        sessionTools.onReset(async () => {
          keys.delete(connKey)
          await chromeManager.release(allocationKey)
        })
      }
      const result = await chromeManager.allocate(key, parsed.port)
      if ('error' in result) return `Error launching project Chrome: ${result.error}`
      effectiveArgs.push(...result.extraArgs)
    } else if (chromeManager) {
      // Check if port/user-data-dir were explicitly provided
      const hasExplicitPort = effectiveArgs.some((a) => a.startsWith('--remote-debugging-port='))
      const hasExplicitDir = effectiveArgs.some((a) => a.startsWith('--user-data-dir='))
      const hasBrowserUrl = effectiveArgs.some((a) => a.startsWith('--browserUrl='))

      if (!hasBrowserUrl) {
        const explicitPort = hasExplicitPort
          ? parseInt(effectiveArgs.find((a) => a.startsWith('--remote-debugging-port='))!.split('=')[1])
          : undefined
        const explicitDir = hasExplicitDir
          ? effectiveArgs.find((a) => a.startsWith('--user-data-dir='))!.split('=')[1]
          : undefined

        const result = await chromeManager.allocate(connKey, explicitPort, explicitDir)
        if ('error' in result) {
          return `Chrome auto-launch failed for "${name}":\n${result.error}\n\nTo fix: read("v:skills/chrome-devtools") for manual setup instructions.`
        }
        // Inject --browserUrl into effective args
        effectiveArgs.push(...result.extraArgs)
        // Register cleanup to release Chrome session on session sleep
        sessionTools.onReset(() => chromeManager.release(connKey))
      }
    }

    if (connOwner.config.transport !== 'stdio' && effectiveArgs.length) {
      return 'Error: extra CLI arguments apply only to stdio MCP servers.'
    }
    try {
      const adapters = await this.connectMcp(
        { ...connOwner.config, args: effectiveArgs }, connKey, sessionTools, entry.toolFilter, options,
        () => this.loadable.get(name) === entry,
      )
      return adapters
    } catch (error) {
      if (!(options.signal.reason instanceof Error && options.signal.reason.name === 'TimeoutError')) {
        options.signal.throwIfAborted()
      }
      return `Error importing MCP server "${name}": ${mcpFailure(error, {
        phase: 'connect', config: connOwner.config, source: `${VIRTUAL_TOOLS_PREFIX}${name}`,
      }).message}`
    }
  }

  private async connectMcp(
    config: McpServerConfig,
    connKey: string,
    sessionTools: SessionTools,
    filter: Set<string> | undefined,
    options: ImportOptions,
    isCurrent: () => boolean = () => true,
  ): Promise<Tool[]> {
    const checkCurrent = () => {
      options.signal.throwIfAborted()
      if (!isCurrent()) throw new Error('MCP configuration changed during import; import the source again.')
    }
    checkCurrent()
    let cached = sessionTools.getMcpConn(connKey)
    if (cached && JSON.stringify(cached.conn.config) !== JSON.stringify(config)) {
      await sessionTools.disconnectMcpConn(connKey)
      cached = undefined
    }
    const connect = async () => {
      checkCurrent()
      const conn = new McpConnection(config, this.workspace)
      try {
        await conn.connect(options.signal)
        checkCurrent()
        sessionTools.setMcpConn(connKey, conn, config.args ?? [])
        conn.setToolsChangedHandler(() => {
          if (sessionTools.getMcpConn(connKey)?.conn === conn) sessionTools.invalidateMcpTools(connKey)
        })
        return sessionTools.getMcpConn(connKey)!
      } catch (error) {
        if (sessionTools.getMcpConn(connKey)?.conn === conn) sessionTools.removeMcpConn(connKey)
        const context = { phase: 'connect' as const, config }
        try {
          await conn.disconnect()
        } catch (cleanupError) {
          throw mcpCleanupFailure(error, cleanupError, context)
        }
        throw mcpFailure(error, context)
      }
    }
    cached ??= await connect()
    try {
      const version = cached.version
      const tools = await cached.conn.listTools(options.signal)
      checkCurrent()
      if (sessionTools.getMcpConn(connKey) !== cached || version !== cached.version) {
        throw new Error('MCP tool list changed during import; import the source again.')
      }
      sessionTools.refreshMcpTools(connKey, JSON.stringify(tools))
      const connection = cached.conn
      const adapters = tools.filter(tool => !filter || filter.has(tool.name))
        .map(tool => new McpToolAdapter(connection, tool))
        .filter(tool => sessionTools.canUseDynamic(tool.name))
      for (const adapter of adapters) sessionTools.registerDynamic(adapter, connKey)
      return adapters
    } catch (error) {
      const context = { phase: 'list_tools' as const, config }
      try {
        await sessionTools.disconnectMcpConn(connKey)
      } catch (cleanupError) {
        throw mcpCleanupFailure(error, cleanupError, context)
      }
      throw mcpFailure(error, context)
    }
  }

  /** Load an MCP server from a JSON config file. Supports standard and shim formats. */
  private async loadFromJsonConfig(
    jsonPath: string,
    sessionTools: SessionTools,
    extraArgs: string[],
    selectedServer: unknown,
    options: ImportOptions,
  ): Promise<string> {
    const absolutePath = isAbsolute(jsonPath) ? jsonPath : resolve(this.workspace, jsonPath)

    let text: string
    try {
      text = await readFile(absolutePath, 'utf8')
    } catch (error) {
      return `Error: ${mcpFailure(error, { phase: 'read_config', source: absolutePath }).message}`
    }

    let configs: McpServerConfig[]
    try {
      if (selectedServer !== undefined && typeof selectedServer !== 'string') throw new TypeError('server must be a string')
      configs = parseMcpConfigDocument(JSON.parse(text), { defaultName: basename(absolutePath, '.json'), server: selectedServer })
      if (extraArgs.length && configs.some(config => config.transport !== 'stdio')) {
        throw new Error('Extra CLI arguments apply only to stdio MCP servers')
      }
    } catch (error) {
      return `Error: invalid MCP config: ${mcpFailure(error, { phase: 'validate_config', source: absolutePath }).message}`
    }

    const results: string[] = []
    for (const config of configs) {
      options.signal.throwIfAborted()
      try {
        const adapters = await this.connectMcp(
          { ...config, args: [...(config.args ?? []), ...extraArgs] },
          config.name, sessionTools, undefined, options,
        )
        results.push(`Loaded ${adapters.length} tool(s) from MCP server "${config.name}".\n${toolInvocationContract(adapters)}`)
      } catch (error) {
        options.signal.throwIfAborted()
        results.push(`Error importing MCP server "${config.name}": ${mcpFailure(error, {
          phase: 'connect', config, source: absolutePath,
        }).message}`)
      }
    }
    return results.join('\n\n')
  }

  private async loadFactory(
    name: string,
    entry: FactoryLoadable,
    sessionTools: SessionTools,
    options: ImportOptions,
  ): Promise<Tool[] | string> {
    let result: Tool | Tool[]
    try {
      result = await entry.factory()
    } catch (err) {
      return `Error loading "${name}": ${err instanceof Error ? err.message : String(err)
        }`
    }
    const tools = Array.isArray(result) ? result : [result]
    options.signal.throwIfAborted()
    for (const t of tools) {
      sessionTools.registerDynamic(t)
    }
    return tools
  }

  private async loadFromPath(
    path: string,
    sessionTools: SessionTools,
    initArgs: string[],
    options: ImportOptions,
  ): Promise<string> {
    const result = await this.loadScript(path, sessionTools, initArgs, options)
    return typeof result === 'string' ? result
      : `Custom tool "${result[0].name}" loaded for this session.\n${toolInvocationContract(result)}`
  }

  private async loadScript(
    path: string,
    sessionTools: SessionTools,
    initArgs: string[],
    options: ImportOptions,
    registeredName?: string,
    resource?: { active: boolean },
    validate?: (context: ExecutionContext) => Promise<void>,
  ): Promise<Tool[] | string> {
    options.signal.throwIfAborted()
    const registrationExpired = () => resource?.active === false
    const absolutePath = isAbsolute(path) ? path : resolve(this.workspace, path)

    try {
      await nodeStat(absolutePath)
    } catch {
      return `Error: tool module not found at "${absolutePath}"`
    }

    let mod: Record<string, unknown>
    options.signal.throwIfAborted()
    if (registrationExpired()) return 'Error: skill tool registration changed before loading; read the skill again'
    try {
      registerTypeScriptLoader()
      const specifier = pathToFileURL(absolutePath).href
      // Cache-bust so re-loading a modified module picks up changes
      mod = await import(`${specifier}?v=${randomUUID()}`)
    } catch (err) {
      return `Error importing tool module: ${err instanceof Error ? err.message : String(err)
        }`
    }

    if (!isScriptToolModule(mod)) {
      return (
        'Error: tool module must export: name (string), description (string), ' +
        'parameters (object), and execute (function). ' +
        `Found exports: ${Object.keys(mod).join(', ')}`
      )
    }

    options.signal.throwIfAborted()
    if (registrationExpired()) return 'Error: skill tool registration changed before initialization; read the skill again'
    // Call optional init() with load-time args
    if (mod.init && initArgs.length > 0) {
      try {
        await mod.init(initArgs)
      } catch (err) {
        return `Error initializing tool "${mod.name}": ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const tool = new ScriptToolAdapter(mod, registeredName, validate)
    options.signal.throwIfAborted()
    if (registrationExpired()) return `Error: skill tool "${tool.name}" changed while loading; read the skill again`
    sessionTools.registerDynamic(tool, undefined, resource)
    return [tool]
  }
}
