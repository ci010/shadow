import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolParameters } from '../tools/tool.ts'
import type { McpConnection, McpToolInfo } from './client.ts'

export function mcpToolContract(serverName: string, toolInfo: McpToolInfo) {
  return {
    name: `${serverName}__${toolInfo.name}`,
    description: `[MCP:${serverName}] ${toolInfo.description}`,
    parameters: toolInfo.inputSchema,
  }
}

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
    const contract = mcpToolContract(connection.config.name, toolInfo)
    this.name = contract.name
    this.description = contract.description
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
