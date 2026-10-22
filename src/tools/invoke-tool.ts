import type { ExecutionContext } from './context.ts'
import type { SessionTools } from './registry.ts'
import type { Tool, ToolParameters, ToolResult } from './tool.ts'

export interface DynamicToolImporter {
  initializeSource?(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<string | undefined>
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
    'Execute an exact tool name, loading it lazily. To initialize an MCP source without executing its tools, pass its source name with args: {} and use the returned contracts. Validates arguments against the current schema; invalid arguments return the contract without execution.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active session tool to execute.',
      },
      args: {
        type: 'object',
        description: 'Arguments for the named tool, matching its current imported contract.',
      },
      instance: { type: 'string', description: 'Session browser instance ID from browser_setup or discovery. Required for chrome-devtools tools when multiple instances are open; never a business-tool argument.' },
    },
    required: ['name', 'args'],
  }

  constructor(private importer?: DynamicToolImporter) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name : ''
    if (!name) return 'Error: name is required'
    if (context.remoteWorkdir && !this.importer?.canInvokeFromRemote?.(name)) {
      return 'Error: remote workdirs support only the built-in Project-Home initiative tool through invoke_tool.'
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
    return `Invoke ${String(args.name ?? '')}`
  }
}