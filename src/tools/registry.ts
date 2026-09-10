import { trace } from '@opentelemetry/api'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Tool, ToolDefinition, ToolExecutionHook } from './tool.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { McpConnection } from '../mcp/client.ts'

const CHAT_DISPLAY_MAX_LENGTH = 200
const DEFAULT_TRUNCATION_THRESHOLD = 12_000

/** Tools whose results should NOT be auto-truncated (they handle their own). */
const EXEMPT_TOOLS = new Set(['read', 'glob', 'grep'])

/**
 * Central registry of all available tools.
 */
export class Tools {
  protected tools = new Map<string, Tool>()
  protected workspace: string
  private truncationThreshold: number
  private hooks: ToolExecutionHook[] = []

  constructor(
    workspace: string,
    truncationThreshold = DEFAULT_TRUNCATION_THRESHOLD,
  ) {
    this.workspace = workspace
    this.truncationThreshold = truncationThreshold
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[tool-registry] Overwriting existing tool: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    console.debug(`[tool-registry] Registered tool: ${tool.name}`)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Register a post-execution hook. Hooks run in registration order. */
  addHook(hook: ToolExecutionHook): void {
    this.hooks.push(hook)
    console.debug(`[tool-registry] Added hook: ${hook.name}`)
  }

  getChatTextDisplay(name: string, args: Record<string, unknown>): string {
    const tool = this.tools.get(name)
    if (!tool) {
      return ''
    }
    if (tool.getChatTextDisplay) {
      try {
        const text = tool.getChatTextDisplay(args)
        if (text.length > CHAT_DISPLAY_MAX_LENGTH) {
          return text.slice(0, CHAT_DISPLAY_MAX_LENGTH) + '...'
        }
        return text
      } catch (err) {
        console.warn(`Error in getChatTextDisplay for tool ${name}:`, err)
        return ''
      }
    }
    return ''
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const s = trace.getActiveSpan()
    s?.setAttributes({
      tool_name: name,
      args: JSON.stringify(args),
    })
    console.info(`Executing tool`)
    const tool = this.tools.get(name)
    if (!tool) {
      s?.setStatus({ code: 2, message: 'Tool not found' })
      return `Error: unknown tool "${name}"`
    }
    if (context.remoteWorkdir && tool.supportsRemoteWorkdir !== true) {
      return `Error: tool "${name}" does not support remote workdirs`
    }
    try {
      context.signal?.throwIfAborted()

      await this.onBefore(name, args, context)
      let result = await tool.execute(args, context)
      // Run post-execution hooks
      result = await this.onAfter(name, args, result, context)

      if (
        result.length > this.truncationThreshold &&
        !EXEMPT_TOOLS.has(name)
      ) {
        result = await this.truncateAndSave(name, result)
      }
      return result
    } catch (err) {
      // handle abort
      if (err instanceof Error && err.name === 'AbortError') {
        return `Tool execution aborted: ${name}`
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof Error) {
        s?.recordException(err)
      }
      s?.setStatus({ code: 2, message: msg })
      return `Error executing ${name}: ${msg}`
    }
  }

  private async onBefore(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.beforeExecute?.(toolName, args, context)
      } catch (err) {
        console.warn(
          `[tool-registry] Hook "${hook.name}" beforeExecute failed:`,
          err,
        )
      }
    }
  }

  /** Run all registered hooks and apply their output to the result. */
  private async onAfter(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    context: ExecutionContext,
  ): Promise<string> {
    for (const hook of this.hooks) {
      try {
        const out = await hook.afterExecute(toolName, args, result, context)
        if (out == null) continue
        if (typeof out === 'object' && 'replace' in out) {
          result = out.replace
        } else if (out) {
          result += out
        }
      } catch (err) {
        console.warn(`[tool-registry] Hook "${hook.name}" failed:`, err)
      }
    }
    return result
  }

  /**
   * Write the full result to a temp file and return a truncated version
   * with a pointer telling the AI to `read` for the rest.
   */
  private async truncateAndSave(
    toolName: string,
    result: string,
  ): Promise<string> {
    const tmpDir = join(this.workspace, '.tmp')
    try {
      await mkdir(tmpDir, { recursive: true })
    } catch { /* exists */ }

    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
    const rand = crypto.getRandomValues(new Uint8Array(3))
    const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join(
      '',
    )
    const filename = `tool-result-${toolName}-${now}-${hex}.txt`
    const filePath = join(tmpDir, filename)
    const relativePath = `.tmp/${filename}`

    await writeFile(filePath, result)

    const truncated = result.slice(0, this.truncationThreshold)
    const remaining = result.length - this.truncationThreshold
    return (
      truncated +
      `\n...[truncated: ${remaining} chars remaining]\n` +
      `Full output saved to: ${relativePath}\n` +
      `Use read with offset=${this.truncationThreshold} to read more.`
    )
  }

  /** Return OpenAI function-calling compatible definitions. */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
      optIn: t.optIn,
    }))
  }

  /** Check if a tool is readonly (safe to run in parallel). */
  isReadonly(name: string): boolean {
    return this.get(name)?.readonly === true
  }

  /** All registered tool names. */
  names(): string[] {
    return Array.from(this.tools.keys())
  }
}

/**
 * Per-session tool overlay.
 *
 * Wraps a base {@link Tools} and adds a session-scoped dynamic layer
 * on top.  Dynamic tools are visible only within one session and are cleared
 * on sleep so they never leak across session boundaries.
 *
 * Lookup order: dynamic layer first, then base registry.
 */
export class SessionTools extends Tools {
  private resetCallbacks: Array<() => void | Promise<void>> = []
  /** Session-scoped MCP connection cache, keyed by server name. */
  private mcpConns = new Map<
    string,
    { conn: McpConnection; activeArgs: string[] }
  >()
  /** Tool whitelist — if set, only these tools are available. */
  private readonly allowed: Set<string> | undefined
  /** Tool blacklist — blocked unless overridden by allowed. */
  private readonly blocked: Set<string> | undefined

  constructor(
    private base: Tools,
    workspace: string,
    allowedTools?: string[],
    blockedTools?: string[],
  ) {
    super(workspace)
    this.allowed = allowedTools?.length ? new Set(allowedTools) : undefined
    this.blocked = blockedTools?.length ? new Set(blockedTools) : undefined
  }

  /** Check if a tool name passes the allow/block policy. */
  private isToolAllowed(name: string): boolean {
    if (this.allowed) return this.allowed.has(name)
    // Opt-in tools are hidden unless explicitly in allowedTools
    const tool = this.tools.get(name) ?? this.base.get(name)
    if (tool?.optIn) return false
    if (this.blocked) return !this.blocked.has(name)
    return true
  }

  /** Get a cached MCP connection for this session. */
  getMcpConn(
    name: string,
  ): { conn: McpConnection; activeArgs: string[] } | undefined {
    return this.mcpConns.get(name)
  }

  /** Cache an MCP connection for this session. */
  setMcpConn(name: string, conn: McpConnection, activeArgs: string[]): void {
    this.mcpConns.set(name, { conn, activeArgs })
  }

  /** Remove a cached MCP connection (e.g. on reconnect failure). */
  removeMcpConn(name: string): void {
    this.mcpConns.delete(name)
  }

  /** Register a tool for the current session only. */
  registerDynamic(tool: Tool): void {
    this.register(tool) // writes into this.tools (the dynamic layer)
  }

  /** Execute an active session tool through the `invoke_tool` gateway. */
  async executeDynamic(
    name: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    if (!this.isDynamicToolAllowed(name)) {
      return `Error: dynamic tool "${name}" is not available for this agent type.`
    }
    if (!this.tools.has(name)) {
      return `Error: dynamic tool "${name}" is not active for this session.`
    }
    return await super.execute(name, args, context)
  }

  /** Dynamic tools require the gateway in allowlist mode and honor blacklists by name. */
  canUseDynamic(name: string): boolean {
    return this.isDynamicToolAllowed(name)
  }

  private isDynamicToolAllowed(name: string): boolean {
    if (this.allowed) return this.allowed.has('invoke_tool')
    return !this.blocked?.has(name)
  }

  /** Whether a name belongs to the active session-only tool layer. */
  hasDynamic(name: string): boolean {
    return this.tools.has(name)
  }

  /** Register a callback to run when the session resets (e.g. disconnect MCP). */
  onReset(cb: () => void | Promise<void>): void {
    this.resetCallbacks.push(cb)
  }

  /** Clear all session-scoped tools and run cleanup callbacks (called on sleep). */
  resetDynamic(): void {
    this.tools.clear()
    // Disconnect all session-owned MCP connections
    for (const { conn } of this.mcpConns.values()) {
      conn.disconnect().catch(() => {})
    }
    this.mcpConns.clear()
    const cbs = this.resetCallbacks.splice(0)
    for (const cb of cbs) {
      try {
        const result = cb()
        if (result && typeof (result as Promise<void>).catch === 'function') {
          ;(result as Promise<void>).catch(() => {})
        }
      } catch { /* ignore cleanup errors */ }
    }
  }

  override get(name: string): Tool | undefined {
    if (!this.isToolAllowed(name)) return undefined
    return this.base.get(name)
  }

  override has(name: string): boolean {
    if (!this.isToolAllowed(name)) return false
    return this.base.has(name)
  }

  override getDefinitions(): ToolDefinition[] {
    return this.base.getDefinitions().filter((d) =>
      this.isToolAllowed(d.function.name)
    )
  }

  override getChatTextDisplay(
    name: string,
    args: Record<string, unknown>,
  ): string {
    return this.base.getChatTextDisplay(name, args)
  }

  override async execute(
    name: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    if (!this.isToolAllowed(name)) {
      return `Error: tool "${name}" is not available for this agent type.`
    }
    return this.base.execute(name, args, context)
  }

  override names(): string[] {
    return this.base.names().filter((n) => this.isToolAllowed(n))
  }
}
