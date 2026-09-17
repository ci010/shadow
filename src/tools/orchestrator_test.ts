import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SearchTool } from './search.ts'
import { InitiativeTool } from './initiative.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import { McpConnection } from '../mcp/client.ts'

test('coordinator cannot activate dynamic tools; topics retain lazy Initiative access', async t => {
  const agent = (await getBuiltinAgentTypes()).find(agent => agent.name === 'orchestrator')
  assert(agent)
  const base = new Tools('.')
  const initiative = new InitiativeTool({ query: () => [{ id: 'fixture' }] }, 'p', 'synthetic schema')
  const importer = new ImportTool(new Map([
    ['initiative', initiative],
  ]), '.')
  await importer.updateMcpServers([{ name: 'fixture', transport: 'stdio', command: 'never-execute' }])
  base.register(initiative)
  base.register(new InvokeTool(importer))
  base.register(new SearchTool('.', undefined, undefined, importer))
  for (const name of ['exec', 'write', 'subagent', 'read', 'topic', 'message']) {
    base.register({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => name })
  }
  const tools = new SessionTools(base, '.', agent.allowedTools, agent.blockedTools)
  const context: ExecutionContext = {
    projectId: 'p', sessionId: 'web:orchestrator', physicalSessionId: 'orchestrator-0',
    channel: 'web', chatId: 'orchestrator', senderId: 'user', messageId: 'input',
    signal: new AbortController().signal, tools,
  }
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => { throw new Error('unexpected connection') })
  assert.deepEqual(tools.getDefinitions().map(definition => definition.function.name).sort(), ['initiative', 'message', 'read', 'search', 'topic'])
  assert.match(await tools.execute('search', { space: 'tools:fixture' }, context), /not available/)
  assert.match(await tools.execute('invoke_tool', { name: 'fixture__execute', args: {} }, context), /not found|not available|not allowed/i)
  assert.equal(connect.mock.callCount(), 0)
  const borrowed = tools.snapshot()
  assert.equal(borrowed.has('invoke_tool'), false)
  assert.equal(borrowed.canUseDynamic('fixture__execute'), false)
  assert.equal(borrowed.has('initiative'), true)
  assert.equal(JSON.parse(await tools.execute('initiative', { query: 'SELECT id FROM initiatives' }, context))[0].id, 'fixture')
  const ordinary = new SessionTools(base, '.')
  assert.equal(ordinary.getDefinitions().some(definition => definition.function.name === 'initiative'), false)
  const ordinaryContext = { ...context, sessionId: 'web:topic', tools: ordinary }
  assert.equal(JSON.parse(await ordinary.execute('invoke_tool', { name: 'initiative', args: { query: 'SELECT id FROM initiatives' } }, ordinaryContext))[0].id, 'fixture')
  ordinary.resetDynamic()
  tools.resetDynamic()
})
