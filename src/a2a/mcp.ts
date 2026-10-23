import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { A2aClientTools } from './client.ts'

export function createA2aMcpServer(client: A2aClientTools, projectId: string, owner: string): Server {
  const server = new Server({ name: 'shadow-a2a', version: '1.0.0' }, { capabilities: { tools: {} } })
  const connectionId = randomUUID()
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: client.tools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const text = await client.call(request.params.name, request.params.arguments ?? {}, {
        projectId, sessionId: owner, physicalSessionId: connectionId,
        messageId: 'mcp', toolCallId: String(extra.requestId), signal: extra.signal,
      })
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      console.error('[a2a:mcp] Tool call failed', error)
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'A2A tool call failed.' }] }
    }
  })
  return server
}
