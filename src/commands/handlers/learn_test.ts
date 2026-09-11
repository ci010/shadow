import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { createLearnCommand, triggerReflectorFlush } from './learn.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

interface FakeState {
  sessionId: string
  segmentIndex: number
  total: number
}

/** Minimal SessionManager fake exposing only what the flush touches. */
function fakeSessions(workspace: string, states: FakeState[]) {
  const started: Array<{ agentType?: string; task?: string }> = []
  const sessions = {
    workspace,
    listSessions: () =>
      states.map((s) => ({
        sessionId: s.sessionId,
        segmentIndex: s.segmentIndex,
      })),
    getHistory: (sessionId: string) => {
      const s = states.find((x) => x.sessionId === sessionId)
      return Promise.resolve({ messages: [], total: s?.total ?? 0 })
    },
    startSession: (opts: { agentType?: string; task?: string }) => {
      started.push(opts)
      return Promise.resolve('spawned')
    },
  } as unknown as SessionManager
  return { sessions, started }
}

test('reflector flush — first run flushes user sessions as [new]', async () => {
  await withTempWorkspace(async (workspace) => {
    const { sessions, started } = fakeSessions(workspace, [
      { sessionId: 'discord:1', segmentIndex: 0, total: 5 },
      { sessionId: 'heartbeat:x', segmentIndex: 0, total: 3 }, // internal — filtered
    ])

    const ran = await triggerReflectorFlush(sessions)
    assert(ran)
    assertEquals(started.length, 1)
    assertEquals(started[0].agentType, 'reflector')
    assert(started[0].task!.includes('[new] discord:1'))
    assert(!started[0].task!.includes('heartbeat'))
  })
})

test('reflector flush — second run with no changes does nothing', async () => {
  await withTempWorkspace(async (workspace) => {
    const states: FakeState[] = [
      { sessionId: 'discord:1', segmentIndex: 0, total: 5 },
    ]
    await triggerReflectorFlush(fakeSessions(workspace, states).sessions)

    // Same state → watermark already current → no flush.
    const second = fakeSessions(workspace, states)
    assertEquals(await triggerReflectorFlush(second.sessions), false)
    assertEquals(second.started.length, 0)
  })
})

test('reflector flush — new messages flush only the increment ([updated] + offset)', async () => {
  await withTempWorkspace(async (workspace) => {
    await triggerReflectorFlush(
      fakeSessions(workspace, [{ sessionId: 'discord:1', segmentIndex: 0, total: 5 }]).sessions,
    )

    const second = fakeSessions(workspace, [
      { sessionId: 'discord:1', segmentIndex: 0, total: 8 },
    ])
    const ran = await triggerReflectorFlush(second.sessions)
    assert(ran)
    assert(second.started[0].task!.includes('[updated] discord:1'))
    assert(second.started[0].task!.includes('index 5'))
  })
})

test('reflector flush — a compacted segment is [updated-segment]', async () => {
  await withTempWorkspace(async (workspace) => {
    await triggerReflectorFlush(
      fakeSessions(workspace, [{ sessionId: 'discord:1', segmentIndex: 0, total: 5 }]).sessions,
    )

    const second = fakeSessions(workspace, [
      { sessionId: 'discord:1', segmentIndex: 1, total: 2 },
    ])
    const ran = await triggerReflectorFlush(second.sessions)
    assert(ran)
    assert(second.started[0].task!.includes('[updated-segment] discord:1'))
  })
})

test('reflector watermark advances only after successful admission', { timeout: 5_000 }, async (t) => {
  await withTempWorkspace(async (workspace) => {
    const states = [{ sessionId: 'web:fixture', segmentIndex: 0, total: 3 }]
    const { sessions } = fakeSessions(workspace, states)
    const admission = Promise.withResolvers<string | null>()
    const start = t.mock.method(sessions, 'startSession', () => admission.promise)
    let returned = false
    const flush = triggerReflectorFlush(sessions).then((result) => { returned = true; return result })
    while (!start.mock.callCount()) await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(returned, false)
    admission.reject(new Error('Session manager stopped'))
    await assert.rejects(flush, /Session manager stopped/)

    const retry = fakeSessions(workspace, states)
    assert.equal(await triggerReflectorFlush(retry.sessions), true)
    assert.match(retry.started[0].task ?? '', /\[new\] web:fixture/)
    assert.equal(await triggerReflectorFlush(fakeSessions(workspace, states).sessions), false)
  })
})

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
    await assert.rejects(triggerReflectorFlush(sessions), /not accepted/)
    assert.equal(await triggerReflectorFlush(fakeSessions(workspace, states).sessions), true)
  })
})
