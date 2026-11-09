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
