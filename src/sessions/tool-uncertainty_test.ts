import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExecutionContext } from '../tools/context.ts'
import type { ToolCall } from '../providers/provider.ts'
import { toolInvocationKey, toolUncertaintyResult, uncertainInvocations } from './tool-uncertainty.ts'

const context = { projectId: 'one', folderId: 'folder', cwd: '/fixture' } as ExecutionContext
const call: ToolCall = { id: 'a', name: 'fixture', arguments: { b: [2, 1], a: { x: 1, y: 2 } } }

test('uncertainty keys normalize JSON key order and lazy invocation, not target or argument changes', () => {
  const key = toolInvocationKey(call, context)
  const args = { a: { y: 2, x: 1 }, b: [2, 1] }
  assert.equal(toolInvocationKey({ ...call, id: 'new', arguments: args }, context), key)
  assert.equal(toolInvocationKey({ id: 'lazy', name: 'invoke_tool', arguments: { name: 'fixture', args } }, context), key)
  assert.notEqual(toolInvocationKey({ ...call, arguments: { ...args, b: [1, 2] } }, context), key)
  assert.notEqual(toolInvocationKey(call, { ...context, projectId: 'two' }), key)
  assert.notEqual(toolInvocationKey(call, { ...context, cwd: '/other' }), key)
  assert.notEqual(toolInvocationKey({ id: 'browser', name: 'invoke_tool', arguments: { name: 'fixture', args, instance: 'other' } }, context), key)
})

test('remote identity never serializes executor state and survives replacement of executor instances', () => {
  const cycle: any = {}; cycle.self = cycle
  const remote = { ...context, remoteWorkdir: { nodeId: 'device', workdirId: 'directory', executor: cycle } }
  const key = toolInvocationKey(call, remote)
  assert.equal(toolInvocationKey(call, { ...remote, remoteWorkdir: { ...remote.remoteWorkdir, executor: {} as any } }), key)
  assert.notEqual(toolInvocationKey(call, { ...remote, remoteWorkdir: { ...remote.remoteWorkdir, nodeId: 'other' } }), key)
})

test('only versioned uncertainty tool results restore the duplicate guard; legacy text remains unchanged', () => {
  const key = toolInvocationKey(call, context)
  const receipt = toolUncertaintyResult(key, call.id, 'Missing evidence')
  const blocked = toolUncertaintyResult(key, call.id, 'Not dispatched', true)
  assert.deepEqual([...uncertainInvocations([
    { role: 'tool', content: 'Error: legacy failure' },
    { role: 'assistant', content: receipt },
    { role: 'tool', content: '{bad JSON' },
    { role: 'tool', content: JSON.stringify({ ...JSON.parse(receipt), retryAllowed: true }) },
  ])], [])
  assert.deepEqual([...uncertainInvocations([{ role: 'tool', content: receipt }, { role: 'tool', content: blocked }])], [[key, call.id]])
})
