import { basename, isAbsolute, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ExecutionContext } from './context.ts'
import { McpToolAdapter, mcpToolContract } from '../mcp/adapter.ts'
import { McpConnection } from '../mcp/client.ts'
import { McpToolIndex } from '../mcp/tool-index.ts'
import { parseMcpConfigDocument, parseMcpServerConfig } from '../mcp/config.ts'
import { mcpCleanupFailure, mcpFailure } from '../mcp/errors.ts'
import type { McpServerConfig } from '../config/schema.ts'
import type { Tool as TypedTool, ToolParameters, ToolResult } from './tool.ts'
import { toolInvocationContract, type SessionTools } from './registry.ts'
import type { ChromeManager } from '../browser/chrome-manager.ts'
import { executeScript } from '../script-runtime/runtime.ts'
import { assertImportPolicy } from '../script-runtime/module-policy.ts'
import { bindScriptTools } from '../script-runtime/bridge.ts'
import { getProjectScope } from '../projects/scope.ts'
import { isDeepStrictEqual } from 'node:util'
import { SkillToolDeclarationsSchema, resolveSkillToolSource, type SkillToolDeclaration, type SkillDirectoryResolver } from '../skills/tool-declarations.ts'
import type { Skill } from '../skills/loader.ts'
import { readSkillDirectory } from '../skills/edit-store.ts'
import { parseSkillFile } from '../skills/parse.ts'
import { SessionBrowsers, type BrowserInstance } from '../browser/session-browsers.ts'
import { BrowserSetupTool } from './browser-setup.ts'
import type { VirtualEntry, VirtualListOptions } from '../vfs/virtual-fs.ts'

type Tool = TypedTool<ToolResult>

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
   * Format: `{ "args": ["--no-usage-statistics"] }`.
   * Browser entries allow only reviewed adapter switches and a managed port.
   * Session browser_setup choices are ephemeral and never written here.
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
  code: string
  resource: { active: boolean }
}

function isScriptLoadable(entry: LoadableEntry): entry is ScriptLoadable {
  return 'script' in entry
}

/**
 * A factory that creates tool(s) on demand — used when a tool needs
 * initialization at load time rather than runtime startup.
 */
export interface FactoryLoadable {
  factory: () => Promise<Tool | Tool[]>
  contracts?: Array<Pick<Tool, 'name' | 'description' | 'parameters'>>
}

function isMcpLoadable(entry: LoadableEntry): entry is McpLoadable {
  return 'config' in entry && !('execute' in entry)
}

function isFactoryLoadable(entry: LoadableEntry): entry is FactoryLoadable {
  return 'factory' in entry
}

interface ImportOptions {
  signal: AbortSignal
  cwd?: string
}

class ScriptToolAdapter implements Tool {
  readonly description: string
  readonly parameters: ToolParameters

  constructor(
    readonly name: string,
    private declaration: SkillToolDeclaration,
    private code: string,
    private validate: (context: ExecutionContext) => Promise<void>,
  ) {
    this.description = declaration.description
    this.parameters = declaration.parameters
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    await this.validate(context)
    const imports = this.declaration.imports
    assertImportPolicy(imports, context.tools.allowedModules ?? imports)
    const signal = AbortSignal.any([context.signal, context.tools.dynamicSignal, context.tools.ownerSignal])
    const binding = bindScriptTools({ ...context, signal }, { dynamic: true })
    try {
      const { value: result } = await executeScript({
        code: this.code, args, signal: binding.signal, cwd: context.cwd, filename: this.declaration.source,
        entry: 'run', policy: { kind: 'restricted', imports }, callModule: binding.call,
      })
      await this.validate(context)
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    } finally {
      await binding.cleanup()
    }
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
      throw new Error('Project Chrome imports accept only a managed remote-debugging-port and reviewed capability/telemetry switches; use browser_setup for browser selection or explicit CDP attachment, never raw connection/profile flags')
    }
  }
  return { args: forwarded, port }
}

/**
 * Import a tool or side-effecting resource into the current session.
 *
 * Supports three path forms:
 *  - `v:tools/<name>` — load a pre-registered tool, MCP server, or factory.
 * Skill tools are declared in SKILL.md; their source runs only in a child.
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
  private readonly browsers = new SessionBrowsers()
  readonly name = 'import_tool'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Import a tool or MCP server into the current session. ' +
    'Source: v:tools/<name> for registered tools (including SKILL.md declarations), or .json for MCP config files. ' +
    'Read v:tools for available sources. Returns current tool contracts before execution. Active until sleep or configuration changes.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Virtual source (v:tools/<name>) or .json MCP configuration path.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra string arguments. For MCP tools: CLI flags (e.g. ["--remote-debugging-port=9223"]). ' +
          'Skill tools take arguments at invocation, not import time.',
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
    private mcpIndex = new McpToolIndex(workspace),
  ) {
    this.builtins = new Map(loadable)
    this.projectId = this.scope?.projectId ?? chromeManager?.projectId
    if (this.scope && chromeManager && chromeManager.projectId !== this.projectId) {
      throw new Error('Import tool Chrome project binding mismatch')
    }
    if (this.sessionBrowsersEnabled()) {
      this.registerBuiltin('browser_setup', new BrowserSetupTool(async (request, context) => {
        const denied = this.contextError(`${VIRTUAL_TOOLS_PREFIX}chrome-devtools`, context)
        if (denied) return denied
        if (!context.tools.canUseDynamic('browser_setup') || !context.tools.has('invoke_tool')) {
          return 'Error: browser setup is not available for this agent type.'
        }
        const signal = AbortSignal.any([context.signal, context.tools.dynamicSignal])
        return this.withImports(context.tools.dynamicOwner, signal, async () => {
          if (request.action === 'list') return JSON.stringify({
            instances: this.browsers.list(context.tools).map(instance => this.browserReceipt(instance)),
          })
          if (request.action === 'close') {
            const instance = this.browsers.resolve(context.tools, request.instance)
            if (typeof instance === 'string') return instance
            await this.browsers.close(context.tools, instance)
            return JSON.stringify({ instance: instance.id, closed: true })
          }
          const instance = this.browsers.create(context.tools, request.target)
          const result = await this.withImports(instance.tools, signal, () =>
            this.loadByName('chrome-devtools', instance.tools, [], { signal, cwd: context.cwd ?? this.workspace }))
          if (typeof result === 'string') return result
          return JSON.stringify(this.browserReceipt(instance))
        })
      }))
    }
  }

  private sessionBrowsersEnabled(): boolean {
    const entry = this.loadable.get('chrome-devtools')
    return !!(entry && isMcpLoadable(entry) && this.projectId &&
      (entry.chromeManager ?? entry.sharedConn?.chromeManager ?? this.chromeManager))
  }

  private browserReceipt(instance: BrowserInstance) {
    return {
      instance: instance.id, source: 'v:tools/chrome-devtools', mode: instance.target.mode,
      owned: instance.target.mode === 'launch', ready: instance.ready,
      ...(instance.target.mode === 'launch' ? instance.target.options : { endpoint: instance.target.endpoint }),
      usage: 'Search glob:v:tools/chrome-devtools/<instance> or grep:v:tools/chrome-devtools/<instance>. Pass instance to invoke_tool({name:"chrome-devtools__...",instance,args:{...}}).',
    }
  }

  resolveInvocationTools(toolName: string, context: ExecutionContext, instance?: string): SessionTools | string {
    if (!toolName.startsWith('chrome-devtools__') || !this.sessionBrowsersEnabled()) {
      return instance === undefined ? context.tools : 'Error: instance is supported only for the built-in session browser.'
    }
    const denied = this.contextError(`${VIRTUAL_TOOLS_PREFIX}chrome-devtools`, context)
    if (denied) return denied
    if (!context.tools.canUseDynamic(toolName)) return `Error: dynamic tool "${toolName}" is not available for this agent type.`
    const target = this.browsers.resolve(context.tools, instance)
    return typeof target === 'string' ? target : target.tools
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
    if (Object.keys(declarations).length && context.remoteWorkdir) throw new Error('Skill scripts require a local workdir')
    if (skill.meta.admin && !context.admin) throw new Error('This skill requires an admin session')
    if (this.projectId && context.projectId !== this.projectId) throw new Error('Skill tool Project binding mismatch')
    const signal = AbortSignal.any([context.signal, context.tools.dynamicSignal])
    return this.withImports(context.tools, signal, async () => {
      const snapshot = Object.keys(declarations).length ? readSkillDirectory(skill.dirPath) : undefined
      if (snapshot) {
        const parsed = parseSkillFile(snapshot.files['SKILL.md'].toString('utf8'), basename(skill.dirPath))
        if (!isDeepStrictEqual(parsed.meta, skill.meta) || parsed.body !== skill.body) {
          throw new Error('Skill changed while reading; read the skill again before invoking its tools')
        }
      }
      const current = this.skillTools.get(context.tools) ?? new Map<string, ScriptLoadable>()
      const next = new Map<string, ScriptLoadable>()
      for (const [name, declaration] of Object.entries(declarations)) {
        assertImportPolicy(declaration.imports, context.tools.allowedModules ?? declaration.imports)
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
        const sourceVersion = snapshot!.revision
        const code = snapshot!.files[relative(skill.dirPath, source).replaceAll('\\', '/')]?.toString('utf8')
        if (code === undefined) throw new Error('Skill source changed while reading; read the skill again')
        const script = { ...declaration, source, skill: skill.meta.name, admin: skill.meta.admin }
        next.set(name, previous?.resource.active && previous.sourceVersion === sourceVersion && isDeepStrictEqual(previous.script, script)
          ? previous : { script, sourceVersion, code, resource: { active: true } })
      }
      signal.throwIfAborted()
      if (snapshot && readSkillDirectory(skill.dirPath).revision !== snapshot.revision) {
        throw new Error('Skill changed while reading; read the skill again before invoking its tools')
      }
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
        kind: isMcpLoadable(entry) ? 'mcp' : isScriptLoadable(entry) ? 'script' : 'tool',
        ...(isScriptLoadable(entry) ? { skill: entry.script.skill } : {}),
        description: isMcpLoadable(entry)
          ? entry.config.description ?? `MCP server ${entry.config.name} (${entry.config.transport})`
          : isFactoryLoadable(entry) ? `On-demand tool ${name}`
          : isScriptLoadable(entry) ? entry.script.description : entry.description,
      }),
    }))
  }

  readCatalog(name: string, tools: SessionTools): string {
    const entries = this.catalogEntries(tools)
    if (!name) return entries.length ? entries.map(entry => entry.content).join('\n')
      : 'No dynamic tool sources are available for this agent.'
    return entries.find(entry => entry.name === name)?.content ?? `Error: unknown or unavailable source "${name}".`
  }

  async readVirtual(path: string, context: ExecutionContext): Promise<string> {
    const entries = await this.virtualEntries(context, { subpath: path })
    if (!path) return entries.filter(entry => !entry.name.includes('/')).map(entry => entry.content).join('\n') || 'No dynamic tool sources are available for this agent.'
    const entry = entries.find(entry => entry.name === path)
    if (!entry) throw new Error('Unknown or unavailable tool metadata path. Search glob:v:tools for current paths.')
    return entry.content
  }

  async virtualEntries(context: ExecutionContext, options?: VirtualListOptions): Promise<VirtualEntry[]> {
    const requester = context.tools
    const signal = AbortSignal.any([context.signal, requester.dynamicSignal, requester.ownerSignal])
    signal.throwIfAborted()
    if ((!requester.has('read') && !requester.has('search')) || !requester.has('invoke_tool')) {
      throw new Error('Tool metadata is not available for this agent type.')
    }
    const selected = options?.subpath?.split('/')[0]
    const entries: VirtualEntry[] = []
    const metadata = this.catalogEntries(requester)
    for (const [name, entry] of this.catalogFor(requester)) {
      if (selected && name !== selected) continue
      signal.throwIfAborted()
      const source = `${VIRTUAL_TOOLS_PREFIX}${name}`
      const children: VirtualEntry[] = []
      let warning: string | undefined
      const add = (tool: { name: string; description: string; parameters: unknown }, instance?: string, indexedAt?: string) => {
        if (!requester.canUseDynamic(tool.name)) return
        const path = `${name}/${instance ? `${instance}/` : ''}${encodeURIComponent(tool.name)}`
        children.push({
          name: path,
          content: options?.content === false ? '' : JSON.stringify({
            name: tool.name, source, instance, indexedAt, description: tool.description, parameters: tool.parameters,
          }, null, 2),
        })
      }
      const denied = this.contextError(source, context)
      if (denied) {
        warning = denied
      } else {
        try {
          if (isMcpLoadable(entry)) {
            const browser = name === 'chrome-devtools' && this.sessionBrowsersEnabled()
            const active = browser
              ? this.browsers.list(requester).flatMap(instance => instance.tools.activeDynamicTools().map(tool => ({ tool, instance: instance.id })))
              : requester.activeDynamicTools().filter(tool => tool.name.startsWith(`${entry.config.name}__`)).map(tool => ({ tool, instance: undefined }))
            if (active.length) {
              for (const { tool, instance } of active) add(tool, instance)
            } else if (browser) {
              warning = 'Browser tools are not initialized. Use browser_setup explicitly; search never launches a browser.'
            } else {
              const indexed = await this.mcpIndex.read(entry.config)
              signal.throwIfAborted()
              if (indexed) {
                for (const info of indexed.tools) {
                  if (!entry.toolFilter || entry.toolFilter.has(info.name)) add(mcpToolContract(entry.config.name, info), undefined, indexed.indexedAt)
                }
              } else {
                warning = 'Tool metadata is not indexed. Read v:skills/mcp-config for indexing, or initialize built-in browser sources with browser_setup. Search never connects services.'
              }
            }
          } else if (isFactoryLoadable(entry)) {
            const contracts = entry.contracts ?? requester.activeDynamicTools().filter(tool => tool.name === name)
            for (const tool of contracts) add(tool)
            if (!contracts.length) warning = 'On-demand source has no static metadata; search does not initialize it.'
          } else if (!isScriptLoadable(entry) || entry.resource.active && (!entry.script.admin || context.admin)) {
            add(isScriptLoadable(entry) ? { name, ...entry.script } : entry)
          }
        } catch (error) {
          signal.throwIfAborted()
          warning = mcpFailure(error, { phase: 'read_config', source, config: isMcpLoadable(entry) ? entry.config : undefined }).message
        }
      }
      const summary = metadata.find(item => item.name === name)
      if (summary) entries.push({
        name,
        content: JSON.stringify({
          ...JSON.parse(summary.content),
          tools: children.map(child => `${VIRTUAL_TOOLS_PREFIX}${child.name}`),
          ...(warning ? { warning } : {}),
        }, null, 2),
        warning,
      })
      entries.push(...children)
    }
    signal.throwIfAborted()
    return entries
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
    options: { signal?: AbortSignal; cwd?: string } = {},
  ): Promise<string> {
    const signal = options.signal ? AbortSignal.any([options.signal, tools.dynamicSignal]) : tools.dynamicSignal
    return this.withImports(tools, signal, () => this.performImport(args, tools, { signal, cwd: options.cwd }))
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
      const instance = this.browsers.forTools(tools)
      if (signal.aborted && instance && !instance.ready) await this.browsers.close(instance.owner, instance)
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
      return 'Error: `source` is required. Use v:tools/<name> for registered tools or .json for MCP config files.'
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
      const browser = name === 'chrome-devtools' ? this.browsers.list(tools)[0] : undefined
      return `${summary}${browser ? ` Browser instance: ${browser.id}.` : ''}\n${toolInvocationContract(result)}`
    }

    // JSON MCP config file
    if (path.endsWith('.json')) {
      return await this.loadFromJsonConfig(path, tools, extraArgs, args.server, options)
    }

    return `Error: unrecognized source "${path}". Declare scripts in SKILL.md and read the skill, then use v:tools/<name>; MCP configurations use .json.`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const error = this.contextError(String(args.source ?? ''), context)
    if (error) return error
    return await this.importSource(args, context.tools, { signal: context.signal, cwd: context.cwd ?? this.workspace })
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
      if (entry.config.name === 'chrome-devtools' && this.projectId) {
        const scope = getProjectScope()
        if (!manager || manager.projectId !== this.projectId || this.scope?.closed ||
          (scope && (scope.projectId !== this.projectId || (this.scope && scope !== this.scope)))) {
          return 'Error: project Chrome requires its own runtime-managed browser'
        }
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
    cwd?: string,
  ): Promise<string | undefined> {
    if (!sessionTools.canUseDynamic(toolName)) return undefined
    if (toolName.startsWith('chrome-devtools__') && this.sessionBrowsersEnabled()) {
      const target = this.browsers.resolve(sessionTools)
      if (typeof target === 'string') return target
      sessionTools = target.tools
    }
    if (sessionTools.hasDynamic(toolName)) return undefined
    const activeSignal = signal ? AbortSignal.any([signal, sessionTools.dynamicSignal]) : sessionTools.dynamicSignal
    const load = (name: string) => this.withImports(sessionTools, activeSignal, async () => {
      const result = await this.loadByName(name, sessionTools, [], { signal: activeSignal, cwd })
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
      result ??= `Error: tool "${toolName}" is not advertised by server "${serverName}". Search grep:v:tools and read the matching paths for current tool IDs.`
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
      if (name === 'chrome-devtools' && this.sessionBrowsersEnabled()) {
        const instance = this.browsers.resolve(tools)
        if (typeof instance === 'string') return instance
        instance.fileRoot ??= options.cwd ?? this.workspace
        if (extraArgs.length && instance.importArgs && !isDeepStrictEqual(extraArgs, instance.importArgs)) {
          return 'Error loading project Chrome: browser instance startup arguments are fixed. Close it before changing preload arguments. Use browser_setup for separately routed browser targets.'
        }
        const instanceArgs = instance.importArgs ?? extraArgs
        const load = async () => {
          const signal = AbortSignal.any([options.signal, instance.tools.dynamicSignal])
          try {
            const result = await this.loadMcp(name, entry, instance.tools, instanceArgs, { ...options, signal })
            signal.throwIfAborted()
            if (typeof result !== 'string') {
              instance.ready = true
              instance.importArgs = [...instanceArgs]
            } else if (!instance.ready) await this.browsers.close(instance.owner, instance)
            return result
          } catch (error) {
            if (!instance.ready) {
              try { await this.browsers.close(instance.owner, instance) }
              catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser setup and cleanup failed') }
            }
            throw error
          }
        }
        return tools === instance.tools ? load() : this.withImports(instance.tools, options.signal, load)
      }
      return await this.loadMcp(name, entry, tools, extraArgs, options)
    }

    if (isFactoryLoadable(entry)) {
      return await this.loadFactory(name, entry, tools, options)
    }

    if (isScriptLoadable(entry)) {
      await resolveSkillToolSource(entry.script.skill, entry.script.source, this.getSkillDirectory)
      this.assertCurrentSkill(entry)
      if (tools.hasDynamic(name)) return tools.activeDynamicTools().filter(tool => tool.name === name)
      if (extraArgs.length) return 'Error: skill scripts do not accept import-time arguments; pass arguments to invoke_tool.'
      return this.loadScript(entry.script, entry.code, tools, options, name, entry.resource, async context => {
        if (!entry.resource.active) throw new Error('Skill tool registration expired; read the skill again')
        if (entry.script.admin && !context.admin) throw new Error('This skill requires an admin session')
        if (context.remoteWorkdir) throw new Error('Skill scripts require a local workdir')
        if (this.projectId && context.projectId !== this.projectId) throw new Error('Skill tool Project binding mismatch')
        await resolveSkillToolSource(entry.script.skill, entry.script.source, this.getSkillDirectory)
        this.assertCurrentSkill(entry)
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
        name === 'chrome-devtools')
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
      const instance = this.browsers.forTools(sessionTools)
      if (instance?.target.mode === 'attach') {
        if (parsed.port !== undefined) return 'Error: an attached browser cannot use a managed remote-debugging-port.'
        effectiveArgs.push(instance.target.argument)
      } else {
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
        const result = await chromeManager.allocate(key, parsed.port, undefined,
          instance?.target.mode === 'launch' ? instance.target.options : undefined, options.signal)
        if ('error' in result) return `Error launching project Chrome: ${result.error}`
        effectiveArgs.push(...result.extraArgs)
      }
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
        () => this.loadable.get(name) === entry && this.browsers.forTools(sessionTools)?.active !== false,
        this.configured.get(name) === entry && !extraCliArgs.length && !chromeManager ? entry.config : undefined,
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
    indexConfig?: McpServerConfig,
  ): Promise<Tool[]> {
    const checkCurrent = () => {
      options.signal.throwIfAborted()
      if (!isCurrent()) throw new Error('MCP configuration changed during import; import the source again.')
    }
    checkCurrent()
    const browserRoot = this.browsers.forTools(sessionTools)?.fileRoot
    let cached = sessionTools.getMcpConn(connKey)
    if (cached && (JSON.stringify(cached.conn.config) !== JSON.stringify(config) || cached.conn.workspaceRoot !== browserRoot)) {
      await sessionTools.disconnectMcpConn(connKey)
      cached = undefined
    }
    const connect = async () => {
      checkCurrent()
      const conn = new McpConnection(config, browserRoot ?? this.workspace, browserRoot)
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
      if (indexConfig) {
        await this.mcpIndex.store(indexConfig, tools, options.signal)
        checkCurrent()
        if (sessionTools.getMcpConn(connKey) !== cached || version !== cached.version) {
          throw new Error('MCP tool list changed during index refresh; import the source again.')
        }
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

  private assertCurrentSkill(entry: ScriptLoadable): void {
    if (!entry.resource.active) throw new Error('Skill tool registration expired; read the skill again')
    const directory = this.getSkillDirectory(entry.script.skill)
    if (!directory) throw new Error(`Skill "${entry.script.skill}" was not found; read the skill again`)
    if (readSkillDirectory(directory).revision !== entry.sourceVersion) {
      entry.resource.active = false
      throw new Error(`Skill "${entry.script.skill}" changed; read the skill again before invoking its tools`)
    }
  }

  private async loadScript(
    declaration: SkillToolDeclaration,
    code: string,
    sessionTools: SessionTools,
    options: ImportOptions,
    registeredName: string,
    resource: { active: boolean },
    validate: (context: ExecutionContext) => Promise<void>,
  ): Promise<Tool[] | string> {
    options.signal.throwIfAborted()
    if (!resource.active) return `Error: skill tool "${registeredName}" changed while loading; read the skill again`
    const tool = new ScriptToolAdapter(registeredName, declaration, code, validate)
    sessionTools.registerDynamic(tool, undefined, resource)
    return [tool]
  }
}
