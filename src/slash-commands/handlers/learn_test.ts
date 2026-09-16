import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLearnCommand } from './learn.ts'
import { fakeSessions } from '../../agent/learning/test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

test('learning command reports rejected or unavailable starts instead of success', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const states = [{ sessionId: 'web:fixture', segmentIndex: 0, total: 3 }]
    const { sessions } = fakeSessions(workspace, states)
    const command = createLearnCommand(sessions)
    const ctx = {
      sessionId: 'web:fixture',
      msg: {
        channel: 'web', chatId: 'fixture', senderId: 'fixture', messageId: 'fixture',
        content: '/learn reflector', timestamp: new Date().toISOString(),
      },
      admin: true,
      llm: { model: 'fixture', contextWindow: 4096, temperature: 0 },
    }
    const start = t.mock.method(sessions, 'startSession', async () => { throw new Error('Session manager stopped') })
    await assert.rejects(command.execute(ctx, 'reflector'), /Session manager stopped/)
    start.mock.mockImplementation(async () => null)
    await assert.rejects(command.execute(ctx, 'reflector'), /not accepted/)
  })
})
