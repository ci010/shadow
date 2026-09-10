import type { ExecutionContext } from '../agent/agent.ts'
import type { SessionTools } from './registry.ts'
import type { Tool, ToolParameters } from './tool.ts'

export interface DynamicToolImporter {
  importForInvocation(
    toolName: string,
    sessionTools: SessionTools,
  ): Promise<string | undefined>
}

/**
 * Execute an active dynamic tool, importing known catalog tools on first use.
 * Dynamic tool schemas are documented by the skill that activates them,
 * rather than being appended to the provider's function definitions.
 */
export class InvokeTool implements Tool {
  readonly name = 'invoke_tool'
  readonly description =
    'Execute a session tool by name. Known catalog tools are imported automatically on first use. Read its skill for the tool name and parameter schema before calling.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the active session tool to execute.',
      },
      args: {
        type: 'object',
        description: 'Arguments for the named tool, matching the schema documented by its skill.',
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

    const toolArgs = args.args
    if (
      typeof toolArgs !== 'object' ||
      toolArgs === null ||
      Array.isArray(toolArgs)
    ) {
      return 'Error: args must be an object'
    }

    if (!context.tools.hasDynamic(name) && this.importer) {
      const result = await this.importer.importForInvocation(name, context.tools)
      if (!context.tools.hasDynamic(name)) {
        const detail = result ? ` ${result}` : ''
        return `Error: dynamic tool "${name}" is not active and could not be imported automatically.${detail}`
      }
    }

    return await context.tools.executeDynamic(name, toolArgs as Record<string, unknown>, context)
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    return `Invoke ${String(args.name ?? '')}`
  }
}