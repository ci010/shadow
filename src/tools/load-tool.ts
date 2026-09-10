import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, stat as nodeStat } from 'node:fs/promises'
import type { ExecutionContext } from '../agent/agent.ts'
import { McpToolAdapter } from '../mcp/adapter.ts'
import { McpConnection } from '../mcp/client.ts'
import type { McpServerConfig } from '../config/schema.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { SessionTools } from './registry.ts'
import type { ChromeManager } from '../utils/chrome-manager.ts'
import { registerTypeScriptLoader } from '../utils/typescript.ts'

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

export type LoadableEntry = Tool | McpLoadable | FactoryLoadable

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

function invocationContract(tools: Tool[]): string {
  const contracts = tools.map((tool) =>
    JSON.stringify({ name: tool.name, parameters: tool.parameters }),
  )
  return (
    'Call active tools with invoke_tool({ name, args }). Tool contracts:\n' +
    contracts.join('\n')
  )
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

  constructor(private mod: ScriptToolModule) {
    this.name = mod.name
    this.description = mod.description
    this.parameters = mod.parameters as ToolParameters
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const callTool = async (
      name: string,
      toolArgs: Record<string, unknown>,
    ): Promise<unknown> => {
      const result = context.tools.hasDynamic(name)
        ? await context.tools.executeDynamic(name, toolArgs, context)
        : await context.tools.execute(name, toolArgs, context)
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

/** Read the extra args from a config JSON file, or return [] if missing/invalid. */
async function readConfigArgs(configPath: string): Promise<string[]> {
  try {
    const text = await readFile(configPath, 'utf8')
    const data = JSON.parse(text)
    if (Array.isArray(data.args)) return data.args.map(String)
  } catch { /* file missing or invalid — no extra args */ }
  return []
}

const VIRTUAL_TOOLS_PREFIX = 'v:tools/'

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
  readonly name = 'import_tool'
  readonly description = 'Import a tool or MCP server into the current session. ' +
    'Source: v:tools/<name> for pre-registered, .ts for script tools, .json for MCP config files. ' +
    'Active until sleep.'
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
    },
    required: ['source'],
  }

  constructor(
    private loadable: Map<string, LoadableEntry>,
    private workspace: string,
    private chromeManager?: ChromeManager,
  ) { }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const extra = Array.isArray(args.args) && args.args.length > 0
      ? ` ${(args.args as string[]).join(' ')}`
      : ''
    return `🔌 ${String(args.source ?? '')}${extra}`
  }

  async importSource(
    args: Record<string, unknown>,
    tools: SessionTools,
  ) {
    const path = args.source ? String(args.source) : undefined
    const extraArgs = Array.isArray(args.args) ? args.args.map(String) : []

    if (!path) {
      return 'Error: `source` is required. Use v:tools/<name> for pre-registered tools, .ts for script tools, .json for MCP config files.'
    }

    // Virtual tool path: v:tools/<name>
    if (path.startsWith(VIRTUAL_TOOLS_PREFIX)) {
      const name = path.slice(VIRTUAL_TOOLS_PREFIX.length)
      if (!name) {
        const available = [...this.loadable.keys()]
        return available.length > 0
          ? `Available tools: ${available.join(', ')}`
          : 'No tools are currently available to load.'
      }
      return await this.loadByName(name, tools, extraArgs)
    }

    // JSON MCP config file
    if (path.endsWith('.json')) {
      return await this.loadFromJsonConfig(path, tools)
    }

    // TypeScript module
    if (path.endsWith('.ts')) {
      return await this.loadFromPath(path, tools, extraArgs)
    }

    return `Error: unrecognized source "${path}". Use v:tools/<name>, a .ts module path, or a .json MCP config file.`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    return await this.importSource(args, context.tools)
  }

  /** Import the catalog entry that owns a dynamic tool name, when determinable. */
  async importForInvocation(
    toolName: string,
    sessionTools: SessionTools,
  ): Promise<string | undefined> {
    if (!sessionTools.canUseDynamic(toolName)) return undefined
    if (sessionTools.hasDynamic(toolName)) return undefined

    if (this.loadable.has(toolName)) {
      return await this.importSource(
        { source: `${VIRTUAL_TOOLS_PREFIX}${toolName}` },
        sessionTools,
      )
    }

    const separator = toolName.indexOf('__')
    if (separator <= 0) return undefined
    const serverName = toolName.slice(0, separator)
    const unprefixedName = toolName.slice(separator + 2)
    let result: string | undefined

    for (const [catalogName, entry] of this.loadable) {
      if (!isMcpLoadable(entry) || entry.config.name !== serverName) continue
      if (entry.toolFilter && !entry.toolFilter.has(unprefixedName)) continue

      result = await this.loadByName(catalogName, sessionTools, [])
      if (sessionTools.hasDynamic(toolName)) return result
    }
    return result
  }

  private async loadByName(
    name: string,
    tools: SessionTools,
    extraArgs: string[],
  ): Promise<string> {
    const entry = this.loadable.get(name)
    if (!entry) {
      const available = [...this.loadable.keys()]
      const hint = available.length > 0
        ? ` Available: ${available.join(', ')}`
        : ' No tools are currently available to load.'
      return `Unknown tool "${name}".${hint}`
    }

    if (isMcpLoadable(entry)) {
      return await this.loadMcp(name, entry, tools, extraArgs)
    }

    if (isFactoryLoadable(entry)) {
      return await this.loadFactory(name, entry, tools)
    }

    // Plain Tool
    tools.registerDynamic(entry)
    return `Tool "${name}" loaded for this session.\n${invocationContract([entry])}`
  }

  private async loadMcp(
    name: string,
    entry: McpLoadable,
    sessionTools: SessionTools,
    extraCliArgs: string[] = [],
  ): Promise<string> {
    // If this entry shares a connection with another loadable, resolve it
    const connOwner = entry.sharedConn ?? entry
    const connKey = extraCliArgs.length > 0
      ? `${connOwner.config.name}:${extraCliArgs.join(',')}`
      : connOwner.config.name

    // Build the effective args: base config args + persistent config file args + caller args
    const configArgs = entry.configPath
      ? await readConfigArgs(entry.configPath)
      : []
    const effectiveArgs = [
      ...(connOwner.config.args ?? []),
      ...configArgs,
      ...extraCliArgs,
    ]

    // Auto-launch Chrome if this entry has a chromeManager
    const chromeManager = entry.chromeManager ?? (entry.sharedConn as McpLoadable | undefined)?.chromeManager
    if (chromeManager) {
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

    // Get existing connection from session cache
    let cached = sessionTools.getMcpConn(connKey)

    // Reconnect if args changed since last connection
    if (cached && JSON.stringify(cached.activeArgs) !== JSON.stringify(effectiveArgs)) {
      try {
        await cached.conn.disconnect()
      } catch { /* ignore */ }
      sessionTools.removeMcpConn(connKey)
      cached = undefined
    }

    // Connect if no existing connection in this session
    if (!cached) {
      const config = { ...connOwner.config, args: effectiveArgs }
      const conn = new McpConnection(config, this.workspace)
      try {
        await conn.connect()
      } catch (err) {
        return `Error connecting to MCP server "${name}": ${err instanceof Error ? err.message : String(err)
          }`
      }
      sessionTools.setMcpConn(connKey, conn, effectiveArgs)
      cached = { conn, activeArgs: effectiveArgs }
    }

    // List tools (reconnect once on failure — e.g. process died)
    let tools
    try {
      tools = await cached.conn.listTools()
    } catch {
      // Reconnect and retry
      const config = { ...connOwner.config, args: effectiveArgs }
      const conn = new McpConnection(config, this.workspace)
      try {
        await conn.connect()
        tools = await conn.listTools()
      } catch (err) {
        sessionTools.removeMcpConn(connKey)
        return `Error connecting to MCP server "${name}": ${err instanceof Error ? err.message : String(err)
          }`
      }
      sessionTools.setMcpConn(connKey, conn, effectiveArgs)
      cached = { conn, activeArgs: effectiveArgs }
    }

    // Apply tool filter if configured
    const filtered = entry.toolFilter
      ? tools.filter((t) => entry.toolFilter!.has(t.name))
      : tools

    const adapters = filtered.map((t) => new McpToolAdapter(cached.conn, t))
    for (const adapter of adapters) sessionTools.registerDynamic(adapter)

    const toolNames = filtered.map((t) => `${entry.config.name}__${t.name}`).join(
      ', ',
    )
    return `Loaded ${filtered.length} tool(s) from MCP server "${name}" for this session: ${toolNames}\n${invocationContract(adapters)}`
  }

  /** Dynamically connect to an MCP server specified inline and register its tools. */
  private async loadDynamicMcp(
    mcp: Record<string, unknown>,
    sessionTools: SessionTools,
  ): Promise<string> {
    const serverName = mcp.name ? String(mcp.name) : `mcp-${Date.now()}`
    const transport = (mcp.transport ? String(mcp.transport) : 'stdio') as McpServerConfig['transport']
    const command = mcp.command ? String(mcp.command) : undefined
    const args = Array.isArray(mcp.args) ? mcp.args.map(String) : undefined
    const url = mcp.url ? String(mcp.url) : undefined
    const env = mcp.env && typeof mcp.env === 'object' && !Array.isArray(mcp.env)
      ? Object.fromEntries(Object.entries(mcp.env).map(([k, v]) => [k, String(v)]))
      : undefined

    if (transport === 'stdio' && !command) {
      return 'Error: `command` is required for stdio transport'
    }
    if ((transport === 'sse' || transport === 'streamable-http') && !url) {
      return `Error: \`url\` is required for ${transport} transport`
    }

    const config: McpServerConfig = { name: serverName, transport, command, args, url, env }
    const conn = new McpConnection(config, this.workspace)

    try {
      await conn.connect()
    } catch (err) {
      return `Error connecting to MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)
        }`
    }

    // Store connection in session cache — cleaned up on resetDynamic()
    sessionTools.setMcpConn(serverName, conn, args ?? [])

    let tools
    try {
      tools = await conn.listTools()
    } catch (err) {
      await conn.disconnect().catch(() => { })
      return `Error listing tools from MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)
        }`
    }

    const adapters = tools.map((t) => new McpToolAdapter(conn, t))
    for (const adapter of adapters) sessionTools.registerDynamic(adapter)

    const toolNames = tools.map((t) => `${serverName}__${t.name}`).join(', ')
    return `Loaded ${tools.length} tool(s) from MCP server "${serverName}": ${toolNames}\n${invocationContract(adapters)}`
  }

  /** Load an MCP server from a JSON config file. Supports standard and shim formats. */
  private async loadFromJsonConfig(
    jsonPath: string,
    sessionTools: SessionTools,
  ): Promise<string> {
    const absolutePath = isAbsolute(jsonPath) ? jsonPath : resolve(this.workspace, jsonPath)

    let text: string
    try {
      text = await readFile(absolutePath, 'utf8')
    } catch {
      return `Error: MCP config file not found at "${absolutePath}"`
    }

    let data: Record<string, unknown>
    try {
      data = JSON.parse(text)
    } catch {
      return `Error: invalid JSON in "${absolutePath}"`
    }

    // Standard format: { mcpServers: { "name": { command, args, env } } }
    if (data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)) {
      const entries = Object.entries(data.mcpServers as Record<string, unknown>)
      if (entries.length === 0) return 'Error: mcpServers is empty'
      const [name, value] = entries[0]
      return await this.loadDynamicMcp(
        { name, ...(value as Record<string, unknown>) },
        sessionTools,
      )
    }

    // Shim format: { command, args, env }
    if (data.command) {
      const serverName = basename(absolutePath, '.json')
      return await this.loadDynamicMcp(
        { name: serverName, ...data },
        sessionTools,
      )
    }

    return 'Error: JSON must contain either `mcpServers` (standard format) or `command` (shim format)'
  }

  private async loadFactory(
    name: string,
    entry: FactoryLoadable,
    sessionTools: SessionTools,
  ): Promise<string> {
    let result: Tool | Tool[]
    try {
      result = await entry.factory()
    } catch (err) {
      return `Error loading "${name}": ${err instanceof Error ? err.message : String(err)
        }`
    }
    const tools = Array.isArray(result) ? result : [result]
    for (const t of tools) {
      sessionTools.registerDynamic(t)
    }
    return `Tool "${name}" loaded for this session.\n${invocationContract(tools)}`
  }

  private async loadFromPath(
    path: string,
    sessionTools: SessionTools,
    initArgs: string[] = [],
  ): Promise<string> {
    const absolutePath = isAbsolute(path) ? path : resolve(this.workspace, path)

    try {
      await nodeStat(absolutePath)
    } catch {
      return `Error: tool module not found at "${absolutePath}"`
    }

    let mod: Record<string, unknown>
    try {
      registerTypeScriptLoader()
      const specifier = pathToFileURL(absolutePath).href
      // Cache-bust so re-loading a modified module picks up changes
      mod = await import(`${specifier}?v=${Date.now()}`)
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

    // Call optional init() with load-time args
    if (mod.init && initArgs.length > 0) {
      try {
        await mod.init(initArgs)
      } catch (err) {
        return `Error initializing tool "${mod.name}": ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const tool = new ScriptToolAdapter(mod)
    sessionTools.registerDynamic(tool)
    return `Custom tool "${tool.name}" loaded for this session.\n${invocationContract([tool])}`
  }
}
