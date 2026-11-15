import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionTools, Tools } from './registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from './context.ts'

test('learning finish preserves receipt tool/argument capacity and denies hidden work', async () => withTempWorkspace(async workspace => {
  const base = new Tools(workspace)
  const executed: string[] = []
  for (const name of ['read', 'learning_result']) base.register({ name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true }, execute: async () => { executed.push(name); return 'ok' } })
  const tools = new SessionTools(base, workspace)
  tools.setTrustedLimits({ allowedTools: ['read', 'learning_result'], inferenceRequests: 2, toolCalls: 2, argumentBytes: 1000 })
  tools.reserveReceipt('learning_result')
  const context = { sessionId: 'fixture', tools, signal: new AbortController().signal } as ExecutionContext
  assert.match(String(await tools.execute('read', { text: 'a'.repeat(800) }, context)), /receipt capacity/)
  assert.equal(await tools.execute('read', {}, context), 'ok')
  assert.match(String(await tools.execute('read', {}, context)), /receipt capacity/)
  tools.restrictToReceipt('learning_result')
  assert.match(String(await tools.execute('read', {}, context)), /finish boundary/)
  assert.equal(await tools.execute('learning_result', { summary: 'honest partial' }, context), 'ok')
  assert.deepEqual(executed, ['read', 'learning_result'])
}))

test('reflector reallocates bounded work capacity and enforces retention paths without widening tools', async () => withTempWorkspace(async workspace => {
  const base = new Tools(workspace)
  for (const name of ['read', 'search', 'view_edit', 'learning_memory', 'log', 'learning_result']) base.register({ name, description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true }, execute: async () => 'ok' })
  const tools = new SessionTools(base, workspace)
  tools.setTrustedLimits({ allowedTools: base.names(), inferenceRequests: 6, toolCalls: 18, argumentBytes: 96000 })
  tools.reserveReceipt('learning_result'); tools.reserveReflectorRetention()
  const context = { sessionId: 'fixture', tools, signal: new AbortController().signal } as ExecutionContext
  const protectedDenial = String(await tools.execute('read', { padding: 'x'.repeat(48000) }, context))
  assert.match(protectedDenial, /protected retention\/receipt capacity/)
  assert.match(protectedDenial, /No counters were reset/)
  assert.doesNotMatch(protectedDenial, /submit learning_result|work budget exhausted/)
  for (let i = 0; i < 14; i++) assert.equal(await tools.execute('read', {}, context), 'ok')
  assert.match(String(await tools.execute('read', {}, context)), /receipt capacity/)
  tools.enterReflectorRetention()
  assert.equal(tools.executionDenial('read', { path: 'v:sessions/source/c/1.1' }), undefined)
  tools.closeReflectorSources()
  assert(!tools.getDefinitions().some(def => def.function.name === 'view_edit'))
  for (const [name, args] of [
    ['read', { path: 'v:sessions/source/full' }], ['read', { path: 'https://example.test/source' }],
    ['read', { path: 'v:memory/%2e%2e/sessions/source' }], ['read', { path: 'v:memory\\..\\sessions' }],
    ['read', { path: 'v:memory/../sessions/source' }],
    ['read', { path: 'v:memory/topics/x.md', workspace: 'other' }],
    ['search', { path: 'v:memory', handler: 'web' }], ['view_edit', {}],
  ] as const) assert.match(String(await tools.execute(name, args, context)), /retention boundary/)
  assert.equal(await tools.execute('search', { path: 'v:memory/events', handler: 'grep' }, context), 'ok')
  assert.equal(await tools.execute('learning_memory', { action: 'read_wiki' }, context), 'ok')
  assert.equal(await tools.execute('log', { draft: 'x'.repeat(40000) }, context), 'ok')
  assert.match(String(await tools.execute('log', {}, context)), /receipt capacity/)
  tools.restrictToReceipt('learning_result')
  assert.match(String(await tools.execute('learning_memory', {}, context)), /finish boundary/)
  assert.equal(await tools.execute('learning_result', {}, context), 'ok')
}))
