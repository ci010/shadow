import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { env as sysEnv } from 'node:process'
import type { McpServerConfig } from '../config/schema.ts'
import { Span } from '../utils/otel.ts'
import { loadDotEnv } from '../utils/env.ts'

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Manages a connection to a single external MCP server.
 */
export class McpConnection {
  private client: Client
  private transport: StdioClientTransport | null = null

  constructor(
    readonly config: McpServerConfig,
    private readonly cwd?: string,
  ) {
    this.client = new Client({ name: 'bot-agent', version: '0.1.0' }, {})
  }

  @Span('McpConnection.connect')
  async connect(): Promise<void> {
    switch (this.config.transport) {
      case 'stdio': {
        if (!this.config.command) {
          throw new Error(
            `MCP server "${this.config.name}" requires a command for stdio transport`,
          )
        }
        // Merge workspace .env (lowest priority) → process env → config env (highest priority)
        const dotEnv = this.cwd ? await loadDotEnv(this.cwd) : {}
        const mergedEnv = {
          ...dotEnv,
          ...Object.fromEntries(
            Object.entries(sysEnv).filter((entry): entry is [string, string] =>
              entry[1] !== undefined
            ),
          ),
          ...this.config.env as Record<string, string>,
        }
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
          cwd: this.cwd,
        })
        await this.client.connect(this.transport)
        break
      }
      case 'sse':
      case 'streamable-http': {
        // TODO: implement SSE / streamable-http transports
        throw new Error(
          `Transport "${this.config.transport}" not yet implemented`,
        )
      }
    }
  }

  @Span('McpConnection.disconnect')
  async disconnect(): Promise<void> {
    await this.client.close()
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools()
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args })
    // MCP returns content as an array of content blocks
    const contents = result.content as Array<{ type: string; text?: string }>
    return contents
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n')
  }
}
