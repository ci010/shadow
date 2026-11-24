import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import { CHILD_MCP_OPERATION, ChildMcpService } from './child-service.ts'

test('Child MCP resolves local source, binds discovery and invocation to owner, and releases', async () => {
  const actions: string[] = []
  const service = new ChildMcpService(async (_request, source, action) => {
    actions.push(action)
    assert.equal(source, 'fixture')
    return { config: { name: source, transport: 'streamable-http', url: 'https://example.invalid/mcp' } }
  }, () => ({
    connect: async () => { actions.push('connect') },
    listTools: async () => [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    callTool: async (_tool, args) => JSON.stringify(args),
    disconnect: async () => { actions.push('disconnect') },
  }))
  const request: ExecutionRequestV2 = { version: 2, operation: CHILD_MCP_OPERATION, jobId: 'job', idempotencyKey: 'key', turnId: 'turn', nodeId: 'child', projectScope: 'project', sessionId: 'session', workdirId: 'workdir', createdAt: '', deadlineAt: '', args: {} }
  const run = (args: unknown, patch: Partial<ExecutionRequestV2> = {}) => service.execute({ ...request, ...patch, args }, new AbortController().signal)
  await assert.rejects(run({ action: 'initialize', source: 'fixture', command: 'not-allowed' }))
  const { binding, tools } = JSON.parse(await run({ action: 'initialize', source: 'fixture' }))
  assert.equal(tools[0].name, 'echo')
  const call = { action: 'call', binding, tool: 'echo', args: { value: 42 } }
  for (const patch of [{ sessionId: 'other' }, { projectScope: 'other' }, { workdirId: 'other' }]) await assert.rejects(run(call, patch), /binding unavailable/)
  assert.deepEqual(JSON.parse(await run(call)), { result: '{"value":42}' })
  assert.deepEqual(JSON.parse(await run({ action: 'release', binding })), { released: true })
  await assert.rejects(run(call), /binding unavailable/)
  assert.deepEqual(actions, ['initialize', 'connect', 'call', 'release', 'disconnect'])
  const later = JSON.parse(await run({ action: 'initialize', source: 'fixture' }))
  await service.reset()
  await assert.rejects(run({ ...call, binding: later.binding }), /binding unavailable/)
  assert.equal(actions.at(-1), 'disconnect')
})
