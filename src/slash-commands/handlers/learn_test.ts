import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLearnCommand } from './learn.ts'
import type { SlashCommandContext } from '../index.ts'
import { fakeSessions } from '../../agent/learning/test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

const ctx: SlashCommandContext = {
  sessionId: 'web:fixture',
  msg: {
    channel: 'web', chatId: 'fixture', senderId: 'fixture', messageId: 'fixture',
    content: '/learn reflector', timestamp: '2026-09-16T04:00:00Z',
  },
  admin: true,
  llm: { model: 'fixture', contextWindow: 4096, temperature: 0 },
}

test('learning command describes usage and rejects unknown names without triggering', async () => {
  const { sessions } = fakeSessions('.', [])
  const command = createLearnCommand(sessions, async () => assert.fail('must not trigger'))
  assert.equal(command.name, 'learn')
  assert.equal(command.adminOnly, true)
  assert.equal(command.description, 'Trigger a learning pipeline. Usage: /learn <reflector|encapsulator|soul-reflector>')
  assert.equal(await command.execute(ctx, '  '),
    'Usage: /learn <reflector|encapsulator|soul-reflector>\n\nPipelines:\n  - reflector\n  - encapsulator\n  - soul-reflector')
  assert.equal(await command.execute(ctx, ' Unknown '),
    'Unknown pipeline "unknown". Available: reflector, encapsulator, soul-reflector')
})

test('learning command normalizes names and adapts trigger outcomes', async () => {
  const { sessions, started } = fakeSessions('.', [])
  const calls: string[] = []
  const results: unknown[] = [false, 'accepted-session', true, undefined]
  const command = createLearnCommand(sessions, async pipeline => {
    calls.push(pipeline)
    return results.shift()
  })
  assert.equal(await command.execute(ctx, ' REFLECTOR '), 'No new activity for reflector.')
  assert.equal(await command.execute(ctx, ' Encapsulator '), 'Triggered encapsulator. Session: accepted-session')
  assert.equal(await command.execute(ctx, ' SOUL-REFLECTOR '), 'Triggered soul-reflector.')
  assert.equal(await command.execute(ctx, 'reflector'), 'Triggered reflector.')
  assert.deepEqual(calls, ['reflector', 'encapsulator', 'soulReflector', 'reflector'])
  assert.equal(started.length, 0)
})

test('learning command cannot bypass the durable learning service', async () => {
  await withTempWorkspace(async workspace => {
    const { sessions } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    const command = createLearnCommand(sessions)
    for (const pipeline of ['reflector', 'encapsulator', 'soul-reflector']) {
      await assert.rejects(command.execute(ctx, pipeline), /unavailable/)
    }
  })
})

test('learning command reports rejected triggers instead of success', async () => {
  await withTempWorkspace(async (workspace) => {
    const { sessions } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    const injected = createLearnCommand(sessions, async () => { throw new Error('Learning stopped') })
    await assert.rejects(injected.execute(ctx, 'reflector'), /Learning stopped/)
  })
})
