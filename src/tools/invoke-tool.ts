import type { ExecutionContext } from './context.ts'
import type { SessionTools } from './registry.ts'
import type { Tool, ToolParameters, ToolResult } from './tool.ts'

export interface DynamicToolImporter {
  initializeSource?(name: string, args: Record<string, unknown>, context: ExecutionContext, explicit?: boolean): Promise<string | undefined>
  canInvokeFromRemote?(toolName: string): boolean
  resolveInvocationTools?(toolName: string, context: ExecutionContext, instance?: string): SessionTools | string
  importForInvocation(
    toolName: string,
    sessionTools: SessionTools,
    signal?: AbortSignal,
    cwd?: string,
    folderId?: string,
  ): Promise<string | undefined>
}

/**
 * Resolve a known tool lazily and validate its current schema before execution.
 */
export class InvokeTool implements Tool<ToolResult> {
  readonly name = 'invoke_tool'
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Execute an exact tool name from v:tools, loading it lazily (shared initialization may register sibling tools). To discover tools of an uninitialized source, omit name and pass source with args: {}; this initializes only, without executing a tool. Read v:tools/@sources__ for source metadata. Validates the live schema; invalid arguments return the contract without execution.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact tool name to execute, active or lazily loadable. Mutually exclusive with source.',
      },
      source: {
        type: 'string',
        description: 'Explicit source initialization only; use args: {} and omit name. Returns tool contracts without executing them.',
      },
      args: {
        type: 'object',
        description: 'Arguments for the named tool, matching its current imported contract.',
      },
      instance: { type: 'string', description: 'Session browser instance ID from browser_setup or discovery. Required for chrome-devtools tools when multiple instances are open; never a business-tool argument.' },
    },
    required: ['args'],
  }

  constructor(private importer?: DynamicToolImporter) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    if (args.source !== undefined) {
      if (typeof args.source !== 'string' || !args.source.trim() || args.name !== undefined || args.instance !== undefined) {
        return 'Error: source must be a nonempty source name; omit name and instance for initialization.'
      }
      if (!args.args || typeof args.args !== 'object' || Array.isArray(args.args) || Object.keys(args.args).length) {
        return 'Error: source initialization requires args: {}.'
      }
      if (context.remoteWorkdir) return 'Error: source initialization is unavailable for remote workdirs.'
      return await this.importer?.initializeSource?.(args.source, args.args as Record<string, unknown>, context, true)
        ?? 'Error: unknown or unavailable source; read v:tools/@sources__ for initialization metadata.'
    }
    const name = typeof args.name === 'string' ? args.name : ''
    if (!name) return 'Error: name is required (or use source with args: {} for initialization)'
    if (context.remoteWorkdir && !this.importer?.canInvokeFromRemote?.(name)) {
      return 'Error: remote workdirs support only the built-in Project-Home session tool through invoke_tool.'
    }

    const toolArgs = args.args
    if (
      typeof toolArgs !== 'object' ||
      toolArgs === null ||
      Array.isArray(toolArgs)
    ) {
      return 'Error: args must be an object'
    }
    if (args.instance !== undefined && (typeof args.instance !== 'string' || !args.instance.trim())) {
      return 'Error: instance must be a nonempty browser instance ID.'
    }
    if (args.instance !== undefined && !this.importer?.resolveInvocationTools) {
      return 'Error: browser instance routing is not configured.'
    }
    const target = this.importer?.resolveInvocationTools?.(name, context, args.instance as string | undefined)
    if (typeof target === 'string') return target
    if (target) context = {
      ...context, tools: target,
      signal: AbortSignal.any([context.signal, context.tools.dynamicSignal, context.tools.ownerSignal, target.dynamicSignal]),
    }

    const initialized = await this.importer?.initializeSource?.(name, toolArgs as Record<string, unknown>, context)
    if (initialized !== undefined) return initialized

    if (this.importer) {
      const result = await this.importer.importForInvocation(name, context.tools, context.signal, context.cwd, context.folderId)
      if (!context.tools.hasDynamic(name)) {
        if (result) return result.startsWith('Error') ? result : `Error: ${result}`
        return `Error: dynamic tool "${name}" is not active and could not be imported automatically. Search with handler "grep" and path "v:tools", then read matching paths for current tool IDs.`
      }
    }

    return await context.tools.executeDynamic(name, toolArgs as Record<string, unknown>, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return args.source !== undefined ? `Initialize ${String(args.source)}` : `Invoke ${String(args.name ?? '')}`
  }
}