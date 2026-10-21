import { validateChromeCall } from '../browser/chrome-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool, ToolParameters, ToolResult } from '../tools/tool.ts'
import type { McpConnection, McpToolInfo } from './client.ts'
import type { McpServerConfig } from '../config/schema.ts'
import { mcpReadOnlyPolicy, type McpReadOnlyPolicy } from './readonly.ts'

export function mcpToolContract(config: McpServerConfig, toolInfo: McpToolInfo) {
  return {
    name: `${config.name}__${toolInfo.name}`,
    description: `[MCP:${config.name}] ${toolInfo.description}`,
    parameters: toolInfo.inputSchema,
    readOnlyPolicy: mcpReadOnlyPolicy(config, toolInfo),
  }
}

/**
 * Wraps a single MCP tool as a local Tool instance.
 */
export class McpToolAdapter implements Tool<ToolResult> {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  readonly readonly: boolean | undefined
  readonly readOnlyPolicy: McpReadOnlyPolicy

  constructor(
    private connection: McpConnection,
    private toolInfo: McpToolInfo,
  ) {
    const contract = mcpToolContract(connection.config, toolInfo)
    this.name = contract.name
    this.description = contract.description
    this.readOnlyPolicy = contract.readOnlyPolicy
    this.readonly = contract.readOnlyPolicy.readOnly
    this.parameters = (toolInfo.inputSchema ??
      { type: 'object', properties: {} }) as unknown as ToolParameters
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const summary = Object.keys(args).slice(0, 3).join(', ')
    return `🔧 ${this.toolInfo.name}${summary ? ` (${summary})` : ''}`
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    validateChromeCall(this.connection.config, this.toolInfo, args)
    return this.connection.callTool(this.toolInfo.name, args, context.signal)
  }
}
