import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTempWorkspace } from '../testing/workspace.ts'
import { A2aConfigSchema } from './config.ts'
import { A2aClientTools } from './client.ts'
import { A2aStore } from './store.ts'
import { createA2aMcpServer } from './mcp.ts'
import { lockA2aDirectory } from './cli-support.ts'

test('MCP exposes the same A2A tools and cannot accept caller identity or arbitrary endpoint overrides', async () => {
  await withTempWorkspace(async root => {
    const store = new A2aStore(root); store.init()
    const tools = new A2aClientTools('p', A2aConfigSchema.parse({ agents: {
      shadow: { cardUrl: 'https://shadow.invalid/card', endpointUrl: 'https://shadow.invalid/a2a' },
    } }), store)
    const server = createA2aMcpServer(tools, 'p', 'mcp:configured-owner')
    const client = new Client({ name: 'coding-agent-fixture', version: '1.0' })
    const [first, second] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(first)
      await client.connect(second)
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
        ['a2a_agents', 'a2a_calls', 'a2a_send', 'reply', 'a2a_get', 'a2a_cancel'])
      const result = await client.callTool({ name: 'a2a_agents', arguments: {} })
      assert.deepEqual(result.content, [{ type: 'text', text: '[{"agent":"shadow"}]' }])
      const invalid = await client.callTool({ name: 'a2a_send', arguments: {
        agent: 'shadow', message: 'work', sessionId: 'another-owner', endpointUrl: 'http://127.0.0.1/admin',
      } })
      assert.equal(invalid.isError, true)
      assert.equal((await client.callTool({ name: 'unknown', arguments: {} })).isError, true)
      assert.equal(store.outbound.size, 0)
    } finally { await client.close(); await server.close(); await tools.close() }
  })
})

test('standalone bridges cannot share a live state directory', async () => {
  await withTempWorkspace(async root => {
    const unlock = lockA2aDirectory(root)
    assert.throws(() => lockA2aDirectory(root), /EEXIST/)
    unlock()
    lockA2aDirectory(root)()
  })
})

test('the real MCP CLI speaks clean stdio and unlocks its state directory on EOF', { timeout: 15_000 }, async () => {
  await withTempWorkspace(async root => {
    const path = join(root, 'mcp.json')
    const stateDirectory = join(root, 'state')
    await writeFile(path, JSON.stringify({ projectId: 'p', owner: 'fixture', stateDirectory, agents: {} }))
    const client = new Client({ name: 'stdio-fixture', version: '1.0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('./mcp-cli.ts', import.meta.url)), '--config', path],
      cwd: process.cwd(),
      stderr: 'pipe',
    })
    try {
      await client.connect(transport)
      assert.equal((await client.listTools()).tools.length, 6)
      assert(existsSync(join(stateDirectory, '.lock')))
    } finally { await client.close() }
    assert.equal(existsSync(join(stateDirectory, '.lock')), false)
  })
})
