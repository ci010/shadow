import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolParameters } from '../tools/tool.ts'
import type { McpConnection, McpToolInfo } from './client.ts'

/**
 * Wraps a single MCP tool as a local Tool instance.
 */
export class McpToolAdapter implements Tool {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters

  constructor(
    private connection: McpConnection,
    private toolInfo: McpToolInfo,
  ) {
    // Prefix with server name to avoid collisions
    this.name = `${connection.config.name}__${toolInfo.name}`
    this.description = `[MCP:${connection.config.name}] ${toolInfo.description}`
    this.parameters = (toolInfo.inputSchema ??
      { type: 'object', properties: {} }) as unknown as ToolParameters
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const summary = Object.keys(args).slice(0, 3).join(', ')
    return `🔧 ${this.toolInfo.name}${summary ? ` (${summary})` : ''}`
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    return this.connection.callTool(this.toolInfo.name, args, context.signal)
  }
}
