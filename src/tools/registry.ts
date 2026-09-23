import { trace } from '@opentelemetry/api'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { toolResultText, type Tool as TypedTool, type ToolDefinition, type ToolExecutionHook, type ToolResult } from './tool.ts'
import { imageFromDataUrl, MAX_TOOL_IMAGES } from '../utils/image-input.ts'
import type { ExecutionContext } from './context.ts'
import type { McpConnection } from '../mcp/client.ts'
import type { ExecutionMode } from '../sessions/execution-mode.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js'
import { redactMcpText } from '../mcp/errors.ts'
import type { WorkToolGuard } from '../sessions/work-alignment.ts'
type Tool = TypedTool<ToolResult>

const CALL_DENIED_TOOLS = new Set(['subagent', 'yield', 'message', 'work', 'event_subscribe', 'cron', 'cron_add', 'cron_list', 'cron_remove', 'continuation', 'kill', 'initiative', 'skill_read', 'skill_save'])

const CHAT_DISPLAY_MAX_LENGTH = 200
const DEFAULT_TRUNCATION_THRESHOLD = 12_000

/** Self-limited outputs and structured execution receipts must remain intact. */
const EXEMPT_TOOLS = new Set(['read', 'glob', 'grep', 'subagent', 'import_tool', 'invoke_tool', 'initiative', 'authoring_change', 'skill_read'])

export function toolInvocationContract(tools: Tool[]): string {
  return 'Call active tools with invoke_tool({ name, args }). Tool contracts:\n' +
    tools.map(tool => JSON.stringify({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    })).join('\n')
}

/**
 * Central registry of all available tools.
 */
export class Tools {
  private workGuard?: WorkToolGuard
  setWorkGuard(guard: WorkToolGuard): void { this.workGuard = guard }
  getWorkGuard(): WorkToolGuard | undefined { return this.workGuard }
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
  ): Promise<ToolResult> {
    const denial = context.tools?.executionDenial?.(name, args)
    if (denial) return denial
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
    let admission: ReturnType<WorkToolGuard['before']>
    try {
      context.signal?.throwIfAborted()

      await this.onBefore(name, args, context)
      context.signal?.throwIfAborted()
      admission = context.tools.getWorkGuard()?.before(tool, args, context)
      const result = await tool.execute(args, context)
      const receipt = admission
      admission = undefined
      let text = toolResultText(result)
      if (typeof result !== 'string' && result.isError && !/^Error:/.test(text)) text = `Error: ${text}`
      text += receipt?.finish((typeof result !== 'string' && result.isError === true) || /^(Error|Blocked):/.test(text)) ?? ''
      const images = typeof result === 'string' ? [] : result.content.filter(part => part.type === 'image_url')
      if (images.length > MAX_TOOL_IMAGES) throw new Error(`A tool result supports at most ${MAX_TOOL_IMAGES} images. Request fewer images.`)
      for (const image of images) imageFromDataUrl(image.image_url.url)
      // Run post-execution hooks
      text = await this.onAfter(name, args, text, context)

      if (
        text.length > this.truncationThreshold &&
        !EXEMPT_TOOLS.has(name) &&
        !(name === 'search' && typeof args.space === 'string' && args.space.split(':', 1)[0] === 'tools') &&
        !(context.remoteWorkdir && name === 'exec')
      ) {
        text = await this.truncateAndSave(name, text)
      }
      return images.length ? {
        content: [...(text ? [{ type: 'text' as const, text }] : []), ...images],
        ...(typeof result !== 'string' && result.isError ? { isError: true } : {}),
      } : text
    } catch (err) {
      admission?.finish(true)
      // An interrupted invocation has no result to persist or send to the model.
      if (context.signal?.aborted) throw err
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
  isReadonly(name: string, args: Record<string, unknown> = {}): boolean {
    const readonly = this.get(name)?.readonly
    return typeof readonly === 'function' ? readonly(args) : readonly === true
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
  override getWorkGuard(): WorkToolGuard | undefined { return super.getWorkGuard() ?? this.base.getWorkGuard() }
  private borrowedOwner?: SessionTools
  private borrowedLifetime?: AbortSignal
  private dynamicLifetime = new AbortController()
  private readonly validators = new WeakMap<Tool, JsonSchemaValidator<unknown>>()
  private readonly dynamicResources = new Map<string, { active: boolean }>()
  private readonly foreground = new Set<Promise<unknown>>()
  private readonly foregroundScopes = new Map<AbortSignal, Set<Promise<unknown>>>()
  private scope?: { mode: ExecutionMode; modes: readonly ExecutionMode[]; blocked?: (reason: string) => void }
  private resetCallbacks: Array<() => void | Promise<void>> = []
  /** Session-scoped MCP connection cache, keyed by server name. */
  private mcpConns = new Map<
    string,
    { conn: McpConnection; activeArgs: string[]; resource: { active: boolean }; toolsSignature?: string; version: number }
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
    readonly allowedModules?: readonly string[],
  ) {
    super(workspace)
    this.allowed = allowedTools !== undefined ? new Set(allowedTools) : undefined
    this.blocked = blockedTools?.length ? new Set(blockedTools) : undefined
    this.allowedModules = allowedModules === undefined ? undefined : Object.freeze([...allowedModules])
  }

  /** Check if a tool name passes the allow/block policy. */
  private isToolAllowed(name: string): boolean {
    if ((name === 'topic' || name === 'work') && this.scope && this.scope.mode !== 'session') return false
    if (this.scope?.mode === 'call' && CALL_DENIED_TOOLS.has(name)) return false
    if (name === 'subagent' && this.scope?.modes.length === 0) return false
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
  ): { conn: McpConnection; activeArgs: string[]; version: number } | undefined {
    return this.mcpConns.get(name)
  }

  /** Cache an MCP connection for this session. */
  setMcpConn(name: string, conn: McpConnection, activeArgs: string[]): void {
    if (this.mcpConns.has(name)) throw new Error(`MCP connection "${name}" must be disconnected before replacement`)
    this.mcpConns.set(name, { conn, activeArgs, resource: { active: true }, version: 0 })
  }

  invalidateMcpTools(name: string): void {
    const cached = this.mcpConns.get(name)
    if (!cached) return
    cached.resource.active = false
    cached.resource = { active: true }
    cached.version++
  }

  refreshMcpTools(name: string, signature: string): void {
    const cached = this.mcpConns.get(name)
    if (!cached) throw new Error(`Missing MCP connection "${name}"`)
    if (cached.toolsSignature !== undefined && cached.toolsSignature !== signature) this.invalidateMcpTools(name)
    cached.toolsSignature = signature
  }

  /** Remove a cached MCP connection (e.g. on reconnect failure). */
  removeMcpConn(name: string): void {
    const cached = this.mcpConns.get(name)
    if (cached) cached.resource.active = false
    this.mcpConns.delete(name)
  }

  async disconnectMcpConn(name: string): Promise<void> {
    const cached = this.mcpConns.get(name)
    this.removeMcpConn(name)
    if (cached) await cached.conn.disconnect()
  }

  async invalidateMcpServers(names: ReadonlySet<string>): Promise<void> {
    const closing = [...this.mcpConns].filter(([, cached]) => names.has(cached.conn.config.name))
      .map(([key]) => this.disconnectMcpConn(key))
    const outcomes = await Promise.allSettled(closing)
    const failures = outcomes.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'MCP connection cleanup failed')
  }

  get dynamicSignal(): AbortSignal { return this.dynamicLifetime.signal }

  /** Leaf snapshots borrow resources; independent sessions own their own resources. */
  get dynamicOwner(): SessionTools { return this.borrowedOwner ?? this }
  get ownerSignal(): AbortSignal { return this.borrowedLifetime ?? this.dynamicSignal }

  createIsolated(): SessionTools {
    const tools = new SessionTools(this.base, this.workspace,
      this.allowed ? [...this.allowed] : undefined, this.blocked ? [...this.blocked] : undefined, this.allowedModules)
    tools.scope = this.scope
    return tools
  }

  /** Register a tool for the current session only. */
  registerDynamic(tool: Tool, connectionKey?: string, resource?: { active: boolean }): void {
    this.dynamicResources.delete(tool.name)
    if (connectionKey !== undefined) {
      const connection = this.mcpConns.get(connectionKey)
      if (!connection) throw new Error(`Missing MCP connection "${connectionKey}"`)
      this.dynamicResources.set(tool.name, connection.resource)
    } else if (resource) this.dynamicResources.set(tool.name, resource)
    this.register(tool) // writes into this.tools (the dynamic layer)
  }

  /** Execute an active session tool through the `invoke_tool` gateway. */
  async executeDynamic(
    name: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const denial = this.executionDenial(name, args)
    if (denial) return denial
    if (!this.isDynamicToolAllowed(name)) {
      return `Error: dynamic tool "${name}" is not available for this agent type.`
    }
    if (!this.hasDynamic(name)) {
      return `Error: dynamic tool "${name}" is not active for this session.`
    }
    context.signal?.throwIfAborted()
    const tool = this.tools.get(name)!
    let validate = this.validators.get(tool)
    if (!validate) {
      try {
        validate = new AjvJsonSchemaValidator().getValidator(tool.parameters as JsonSchemaType)
        this.validators.set(tool, validate)
      } catch (error) {
        const reason = redactMcpText(error instanceof Error ? error.message : String(error), { phase: 'validate_config' })
        return `Error: invalid or unsupported input schema for "${name}"; no tool was executed. ${reason}. Ask the server owner to correct the schema.\n` +
          toolInvocationContract([tool])
      }
    }
    const validation = validate(args)
    if (!validation.valid) {
      return `Error: invalid arguments for "${name}"; no tool was executed. ${validation.errorMessage}\n` +
        toolInvocationContract([tool])
    }
    return await super.execute(name, args, context)
  }

  /** Dynamic tools require the gateway in allowlist mode and honor blacklists by name. */
  canUseDynamic(name: string): boolean {
    return this.isDynamicToolAllowed(name)
  }

  private isDynamicToolAllowed(name: string): boolean {
    if (this.scope?.mode === 'call' && CALL_DENIED_TOOLS.has(name)) return false
    if (this.allowed) return this.allowed.has('invoke_tool')
    return !this.blocked?.has(name)
  }

  /** Whether a name belongs to the active session-only tool layer. */
  hasDynamic(name: string): boolean {
    if (this.dynamicResources.get(name)?.active === false) {
      this.tools.delete(name)
      this.dynamicResources.delete(name)
    }
    return this.tools.has(name)
  }

  activeDynamicTools(): Tool[] {
    return [...this.tools.values()].filter(tool => this.canUseDynamic(tool.name) && this.hasDynamic(tool.name))
  }

  setExecutionScope(mode: ExecutionMode, modes: readonly ExecutionMode[], blocked?: (reason: string) => void): void {
    this.scope = { mode, modes: [...modes], blocked }
  }

  get executionMode(): ExecutionMode | undefined { return this.scope?.mode }

  runForeground<T>(parentSignal: AbortSignal, operation: (signal: AbortSignal, cancel: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const signal = AbortSignal.any([parentSignal, controller.signal])
    const children = new Set<Promise<unknown>>()
    const parent = this.foregroundScopes.get(parentSignal)
    this.foregroundScopes.set(signal, children)
    const cancel = () => controller.abort()
    const pending = Promise.resolve().then(() => operation(signal, cancel)).finally(async () => {
      cancel()
      while (children.size) await Promise.allSettled([...children])
      this.foregroundScopes.delete(signal)
    })
    this.foreground.add(pending)
    parent?.add(pending)
    const remove = () => { this.foreground.delete(pending); parent?.delete(pending) }
    void pending.then(remove, remove)
    return pending
  }

  async waitForForeground(): Promise<void> {
    while (this.foreground.size) await Promise.allSettled([...this.foreground])
  }

  executionDenial(name: string, args: Record<string, unknown>): string | undefined {
    if (name === 'invoke_tool' && typeof args.name === 'string') {
      return this.executionDenial(args.name, typeof args.args === 'object' && args.args !== null ? args.args as Record<string, unknown> : {})
    }
    if (this.scope?.mode === 'call' && name === 'exec' && args.timeout_ms !== undefined
      && (typeof args.timeout_ms !== 'number' || !Number.isInteger(args.timeout_ms)
        || args.timeout_ms < 1 || args.timeout_ms > MAX_CALL_TIMEOUT_MS)) {
      return this.rejectExecution(`Call exec requires timeout_ms between 1 and ${MAX_CALL_TIMEOUT_MS}; background execution is forbidden.`)
    }
    if (this.scope?.mode === 'call' && CALL_DENIED_TOOLS.has(name)) {
      const reason = `${name} is unavailable in a leaf call; return to the caller for coordination or deferred-capable execution.`
      this.scope.blocked?.(reason)
      return `Blocked: ${reason} Partial work and side effects are not rolled back.`
    }
    if (name === 'subagent' && this.scope && !this.scope.modes.includes('task') && args.mode === undefined) {
      return `Error: mode is required in this scope; choose ${this.scope.modes.join(', ')}.`
    }

    if (name === 'subagent' && this.scope && typeof args.mode === 'string'
      && !this.scope.modes.includes(args.mode as ExecutionMode)) {
      return `Error: this session may create only: ${this.scope.modes.join(', ') || 'nothing'}.`
    }
  }

  rejectExecution(reason: string): string {
    if (this.scope?.mode === 'call') {
      this.scope.blocked?.(reason)
      return `Blocked: ${reason} Partial work and side effects are not rolled back.`
    }
    return `Error: ${reason}`
  }

  /** Blocking callers retain ownership of borrowed tool resources until the child returns. */
  snapshot(): SessionTools {
    const base = new Tools(this.workspace)
    const guard = this.getWorkGuard()
    if (guard) base.setWorkGuard(guard)
    for (const name of this.names()) {
      const tool = this.get(name)
      if (tool) base.register(tool)
    }
    const copy = new SessionTools(base, this.workspace,
      this.allowed ? [...this.allowed] : undefined, this.blocked ? [...this.blocked] : undefined, this.allowedModules)
    copy.borrowedOwner = this.dynamicOwner
    copy.borrowedLifetime = this.ownerSignal
    for (const tool of this.tools.values()) {
      if (this.canUseDynamic(tool.name) && this.hasDynamic(tool.name)) {
        copy.registerDynamic(tool)
        const resource = this.dynamicResources.get(tool.name)
        if (resource) copy.dynamicResources.set(tool.name, resource)
      }
    }
    return copy
  }

  /** Register a callback to run when the session resets (e.g. disconnect MCP). */
  onReset(cb: () => void | Promise<void>): void {
    this.resetCallbacks.push(cb)
  }

  /** Clear all session-scoped tools and run cleanup callbacks (called on sleep). */
  resetDynamic(): void {
    void this.resetDynamicAndWait().catch(error => console.error('[tools] Session resource cleanup failed', error))
  }

  async resetDynamicAndWait(): Promise<void> {
    this.dynamicLifetime.abort()
    this.dynamicLifetime = new AbortController()
    this.tools.clear()
    this.dynamicResources.clear()
    // Disconnect all session-owned MCP connections
    const closing: Promise<unknown>[] = []
    for (const { conn, resource } of this.mcpConns.values()) {
      resource.active = false
      closing.push(Promise.resolve().then(() => conn.disconnect()))
    }
    this.mcpConns.clear()
    const cbs = this.resetCallbacks.splice(0)
    for (const cb of cbs) {
      try { closing.push(Promise.resolve(cb())) }
      catch (error) { closing.push(Promise.reject(error)) }
    }
    const results = await Promise.allSettled(closing)
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Session resource cleanup failed')
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
    const scope = this.scope
    return this.base.getDefinitions().filter((d) =>
      this.isToolAllowed(d.function.name)
    ).map(def => def.function.name === 'subagent' && scope
      ? { ...def, function: { ...def.function,
        description: scope.modes.includes('call')
          ? `${scope.modes.includes('task') ? 'Start an asynchronous task, or invoke' : 'Invoke'} a blocking bounded leaf call directly. Available modes: ${scope.modes.join(', ')}.`
          : 'Create an asynchronous bounded task. Durable conversations use the topic tool.',
        parameters: {
        ...def.function.parameters,
        required: [...new Set([...(def.function.parameters.required ?? []), 'task',
          ...(scope.modes.includes('task') ? [] : ['mode'])])],
        properties: {
          ...Object.fromEntries(Object.entries(def.function.parameters.properties)
            .filter(([name]) => name !== 'report_to' || scope.modes.includes('task'))),
          mode: { ...def.function.parameters.properties.mode, enum: [...scope.modes],
            description: scope.modes.includes('task')
              ? 'Omission defaults to task, which returns an admitted ID immediately. Call waits for its final result.'
              : 'Required. Call waits for the final result and cannot yield, message, or delegate.',
          },
          task: { ...def.function.parameters.properties.task,
            description: 'Required initial work: a bounded assignment with an expected result.',
          },
          agent_type: { ...def.function.parameters.properties.agent_type,
            description: `Agent role from Runtime's available types. ${scope.modes.includes('call')
              ? 'For call, omission inherits your role and an explicit role cannot widen your capabilities.'
              : 'Defaults to "sub".'}${scope.modes.includes('call') && scope.modes.includes('task') ? ' For task, defaults to "sub".' : ''}`,
          },
        },
      } } } : def.function.name === 'exec' && this.scope?.mode === 'call'
      ? { ...def, function: { ...def.function, description: `${def.function.description} In calls, execution stays foreground; timeout or cancellation terminates owned processes.`,
        parameters: { ...def.function.parameters, properties: { ...def.function.parameters.properties,
          timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_CALL_TIMEOUT_MS, default: MAX_CALL_TIMEOUT_MS,
            description: 'Foreground execution limit in milliseconds. Timeout terminates the process; the enclosing call deadline may expire sooner. Background execution is forbidden.' },
        } },
      } } : def)
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
  ): Promise<ToolResult> {
    const denial = this.executionDenial(name, args)
    if (denial) return denial
    if (!this.isToolAllowed(name)) {
      return this.rejectExecution(`tool "${name}" is not available for this agent type.`)
    }
    return this.base.execute(name, args, context)
  }

  override names(): string[] {
    return this.base.names().filter((n) => this.isToolAllowed(n))
  }
}
