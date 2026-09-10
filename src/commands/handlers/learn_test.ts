import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { triggerReflectorFlush } from './learn.ts'
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
