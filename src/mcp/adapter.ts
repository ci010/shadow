import { uspan } from '../utils/otel.ts'
import type { Tools } from '../tools/registry.ts'
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

  async execute(args: Record<string, unknown>): Promise<string> {
    return this.connection.callTool(this.toolInfo.name, args)
  }
}

/**
 * Discover all tools from all MCP connections and register them
 * into the local ToolRegistry.
 */
export async function registerMcpTools(
  connections: McpConnection[],
  registry: Tools,
): Promise<string[]> {
  const registered: string[] = []
  using _span = uspan('registerMcpTools')
  for (const conn of connections) {
    try {
      const tools = await conn.listTools()
      for (const t of tools) {
        const adapter = new McpToolAdapter(conn, t)
        registry.register(adapter)
        console.debug(`Registered MCP tool: ${adapter.name}`)
        registered.push(adapter.name)
      }
      console.info(
        `Registered ${tools.length} tools from MCP server "${conn.config.name}"`,
      )
    } catch (err) {
      console.error(
        `Failed to list MCP tools from server "${conn.config.name}"`,
        err,
      )
    }
  }

  return registered
}
