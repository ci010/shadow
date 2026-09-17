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

test('learning command delegates default pipeline execution and formats its result', async () => {
  await withTempWorkspace(async workspace => {
    const { sessions } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    const command = createLearnCommand(sessions)
    assert.equal(await command.execute(ctx, 'reflector'), 'Triggered reflector.')
    assert.equal(await command.execute(ctx, 'reflector'), 'No new activity for reflector.')
    assert.equal(await command.execute(ctx, 'encapsulator'), 'Triggered encapsulator. Session: spawned')
    assert.equal(await command.execute(ctx, 'soul-reflector'), 'Triggered soul-reflector. Session: spawned')
  })
})

test('learning command reports rejected or unavailable starts instead of success', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const { sessions } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    const command = createLearnCommand(sessions)
    const start = t.mock.method(sessions, 'startSession', async () => { throw new Error('Session manager stopped') })
    await assert.rejects(command.execute(ctx, 'reflector'), /Session manager stopped/)
    start.mock.mockImplementation(async () => null)
    await assert.rejects(command.execute(ctx, 'reflector'), /not accepted/)
    await assert.rejects(command.execute(ctx, 'encapsulator'), /not accepted/)
    await assert.rejects(command.execute(ctx, 'soul-reflector'), /not accepted/)
    const injected = createLearnCommand(sessions, async () => { throw new Error('Learning stopped') })
    await assert.rejects(injected.execute(ctx, 'reflector'), /Learning stopped/)
  })
})
