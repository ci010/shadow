import type { ExecutionContext } from './context.ts'
import type { SessionTools } from './registry.ts'
import type { Tool, ToolParameters } from './tool.ts'

export interface DynamicToolImporter {
  canInvokeFromRemote?(toolName: string): boolean
  importForInvocation(
    toolName: string,
    sessionTools: SessionTools,
    signal?: AbortSignal,
  ): Promise<string | undefined>
}

/**
 * Resolve a known tool lazily and validate its current schema before execution.
 */
export class InvokeTool implements Tool {
  readonly name = 'invoke_tool'
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Execute a tool by its exact name. Known catalog tools are connected lazily; arguments are validated against the current schema before execution. Use search with space "tools:" to find names, descriptions and schemas. No separate import is required for catalog tools. Skills are optional guidance.'
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
    },
    required: ['name', 'args'],
  }

  constructor(private importer?: DynamicToolImporter) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
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

    if (!context.tools.hasDynamic(name) && this.importer) {
      const result = await this.importer.importForInvocation(name, context.tools, context.signal)
      if (!context.tools.hasDynamic(name)) {
        if (result) return result.startsWith('Error') ? result : `Error: ${result}`
        return `Error: dynamic tool "${name}" is not active and could not be imported automatically. Use search with space "tools:" for current tool IDs.`
      }
    }

    return await context.tools.executeDynamic(name, toolArgs as Record<string, unknown>, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `Invoke ${String(args.name ?? '')}`
  }
}