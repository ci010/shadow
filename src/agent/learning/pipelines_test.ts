import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { learningJob, learningTask, triggerLearningPipeline, triggerReflectorFlush } from './pipelines.ts'
import { LEARNING_AUTOMATIONS } from '../../cron/contracts.ts'
import { fakeSessions, type FakeState } from './test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

test('reflector flush rejects unavailable starts without advancing the watermark', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const states = [{ sessionId: 'web:fixture', segmentIndex: 0, total: 3 }]
    const { sessions } = fakeSessions(workspace, states)
    t.mock.method(sessions, 'startSession', async () => null)
    await assert.rejects(triggerReflectorFlush(sessions), /not accepted/)
    assert.equal(await triggerReflectorFlush(fakeSessions(workspace, states).sessions), true)
  })
})

test('reflector cancellation during history diff prevents admission and watermark advancement', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const { sessions, started } = fakeSessions(workspace, [{ sessionId: 'same-session', segmentIndex: 0, total: 5 }])
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    t.mock.method(sessions, 'getHistory', async () => {
      entered.resolve()
      await release.promise
      return { messages: [], total: 5 }
    })
    const pending = triggerReflectorFlush(sessions, controller.signal)
    const rejected = assert.rejects(pending, /learning disabled/)
    await entered.promise
    controller.abort(new Error('learning disabled'))
    release.resolve()
    await rejected
    assert.equal(started.length, 0)
    await assert.rejects(readFile(join(workspace, 'memory', '.reflect-watermark.json')), { code: 'ENOENT' })
    await assert.rejects(triggerReflectorFlush(sessions, controller.signal), /learning disabled/)
    assert.equal(started.length, 0)
  })
})

test('same-session reflector watermarks and admission signals remain independent across projects', async () => {
  await withTempWorkspace(async (root) => {
    const homes = [join(root, 'a'), join(root, 'b')]
    const projects = homes.map((home, i) => fakeSessions(home, [
      { sessionId: 'same-session', segmentIndex: 0, total: i ? 7 : 5 },
    ]))
    const controllers = [new AbortController(), new AbortController()]
    assert.deepEqual(await Promise.all(projects.map(({ sessions }, i) =>
      triggerReflectorFlush(sessions, controllers[i].signal))), [true, true])
    for (let i = 0; i < projects.length; i++) {
      assert.equal(projects[i].started[0].signal, controllers[i].signal)
      const watermark = JSON.parse(await readFile(join(homes[i], 'memory', '.reflect-watermark.json'), 'utf8'))
      assert.equal(watermark.sessions['same-session'].messageCount, i ? 7 : 5)
      assert.equal(await triggerReflectorFlush(projects[i].sessions), false)
    }
    controllers[0].abort(new Error('project stopped'))
    await assert.rejects(triggerReflectorFlush(projects[0].sessions, controllers[0].signal), /project stopped/)
    const updated = fakeSessions(homes[1], [{ sessionId: 'same-session', segmentIndex: 0, total: 8 }])
    assert.equal(await triggerReflectorFlush(updated.sessions, controllers[1].signal), true)
    assert.match(updated.started[0].task!, /index 7/)
  })
})

test('learning jobs and dated tasks preserve the automation contract', (t) => {
  const now = new Date('2026-09-16T04:00:00Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  for (const pipeline of Object.keys(LEARNING_AUTOMATIONS) as Array<keyof typeof LEARNING_AUTOMATIONS>) {
    assert.deepEqual(learningJob(pipeline), {
      ...LEARNING_AUTOMATIONS[pipeline], source: 'learning', session: 'fresh',
      schedule: 'manual', createdAt: now.toISOString(),
    })
  }
  assert.equal(learningTask('encapsulator'),
    'Encapsulate: read event log at memory/events/2026-09-16.jsonl and referenced wiki items. Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.')
  assert.equal(learningTask('soulReflector'),
    'Soul Reflect: read event log at memory/events/2026-09-16.jsonl and identity wiki items under memory/identities/. Refine SOUL.md based on stable interaction patterns.')
})

test('learning pipeline dispatch selects the reflector flush or dated downstream task', async () => {
  await withTempWorkspace(async (workspace) => {
    const { sessions, started } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    assert.equal(await triggerLearningPipeline(sessions, 'reflector'), true)
    assert.equal(await triggerLearningPipeline(sessions, 'reflector'), false)
    assert.equal(await triggerLearningPipeline(sessions, 'encapsulator'), 'spawned')
    assert.equal(await triggerLearningPipeline(sessions, 'soulReflector'), 'spawned')
    assert.deepEqual(started.map(s => s.agentType), ['reflector', 'encapsulator', 'soul-reflector'])
    assert.match(started[1].task!, /^Encapsulate: read event log at memory\/events\/\d{4}-\d{2}-\d{2}\.jsonl/)
    assert.match(started[2].task!, /^Soul Reflect: read event log at memory\/events\/\d{4}-\d{2}-\d{2}\.jsonl/)
  })
})

test('reflector filters learning automation sessions but retains ordinary cron sessions', async (t) => {
  await withTempWorkspace(async (workspace) => {
    const { sessions, started } = fakeSessions(workspace, [
      { sessionId: 'sleep:fixture', segmentIndex: 0, total: 3 },
      { sessionId: 'cron:learning', segmentIndex: 0, total: 3 },
      { sessionId: 'cron:ordinary', segmentIndex: 0, total: 3 },
    ])
    t.mock.method(sessions, 'getSessionState', (sessionId: string) => ({
      sessionId, automationVersion: 1,
      automation: {
        jobId: sessionId === 'cron:learning' ? 'learning:reflector' : 'ordinary',
        name: 'Fixture', runId: sessionId, startedAt: '2026-09-16T04:00:00Z',
        contextMode: 'fresh',
        config: { source: sessionId === 'cron:learning' ? 'learning' : 'cron', schedule: 'manual' },
      },
    } as NonNullable<ReturnType<typeof sessions.getSessionState>>))
    assert.equal(await triggerReflectorFlush(sessions), true)
    assert.equal(started[0].task, 'Reflect: review the following sessions.\n\n- [new] cron:ordinary — read from the beginning')
    const watermark = JSON.parse(await readFile(join(workspace, 'memory', '.reflect-watermark.json'), 'utf8'))
    assert.deepEqual(watermark.sessions, { 'cron:ordinary': { segmentIndex: 0, messageCount: 3 } })
  })
})

test('reflector treats an invalid JSON watermark as a first run', async () => {
  await withTempWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'memory'))
    await writeFile(join(workspace, 'memory', '.reflect-watermark.json'), '{invalid')
    const { sessions, started } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    assert.equal(await triggerReflectorFlush(sessions), true)
    assert.match(started[0].task!, /\[new\] web:fixture/)
  })
})

test('reflector custom dispatch must succeed without cancellation before advancing watermark', async () => {
  await withTempWorkspace(async (workspace) => {
    const { sessions, started } = fakeSessions(workspace, [
      { sessionId: 'web:fixture', segmentIndex: 0, total: 3 },
    ])
    const controller = new AbortController()
    let task = ''
    await assert.rejects(triggerReflectorFlush(sessions, undefined, async () => ''), /not accepted/)
    await assert.rejects(triggerReflectorFlush(sessions, undefined, async () => {
      throw new Error('dispatch rejected')
    }), /dispatch rejected/)
    await assert.rejects(triggerReflectorFlush(sessions, controller.signal, async value => {
      task = value
      controller.abort(new Error('learning disabled'))
      return 'accepted'
    }), /learning disabled/)
    await assert.rejects(readFile(join(workspace, 'memory', '.reflect-watermark.json')), { code: 'ENOENT' })
    assert.match(task, /\[new\] web:fixture/)
    assert.equal(await triggerReflectorFlush(sessions, undefined, async value => {
      assert.equal(value, task)
      return 'accepted'
    }), true)
    assert.equal(await triggerReflectorFlush(sessions), false)
    assert.equal(started.length, 0)
  })
})
