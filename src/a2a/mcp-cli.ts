import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { A2aConfigSchema } from './config.ts'
import { A2aStore } from './store.ts'
import { A2aClientTools } from './client.ts'
import { createA2aMcpServer } from './mcp.ts'
import { absolutePath, lockA2aDirectory, readA2aConfig } from './cli-support.ts'

export const A2aMcpConfigSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  owner: z.string().min(1).max(128),
  stateDirectory: absolutePath,
  agents: A2aConfigSchema.shape.agents,
}).strict()

async function main() {
  const raw = await readA2aConfig()
  if (raw === undefined) return
  const config = A2aMcpConfigSchema.parse(raw)
  const unlock = lockA2aDirectory(config.stateDirectory)
  let close: (() => Promise<void>) | undefined
  try {
    const store = new A2aStore(config.stateDirectory)
    store.init()
    const client = new A2aClientTools(config.projectId, { agents: config.agents }, store)
    const server = createA2aMcpServer(client, config.projectId, `mcp:${config.owner}`)
    let closing: Promise<void> | undefined
    close = () => closing ??= (async () => {
      try { await client.close(); await server.close() } finally { unlock() }
    })()
    const shutdown = () => { void close!().catch(error => { console.error('[a2a:mcp] Shutdown failed', error); process.exitCode = 1 }) }
    server.onclose = shutdown
    process.stdin.once('end', shutdown)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await server.connect(new StdioServerTransport())
    client.start()
  } catch (error) {
    if (close) await close()
    else unlock()
    throw error
  }
}

if (import.meta.main) {
  await main().catch(error => { console.error('[a2a:mcp] Startup failed', error); process.exitCode = 1 })
}
