import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { ConfigSchema } from '../config/schema.ts'
import { startMainRuntime } from './main/start.ts'
import { EventService } from '../events/service.ts'
import { SessionManager } from '../sessions/session-manager.ts'

test('Main runtime supports a relative workspace, readiness, idempotent shutdown, and completion', async () => {
  const workspace = await createTempWorkspace()
  const originalCwd = process.cwd()
  try {
    process.chdir(workspace)
    const config = ConfigSchema.parse({
      agent: { workspace: '.' },
      channels: {},
      mcp: {},
    })

    const runtime = await startMainRuntime(config, {
      gateway: { host: '127.0.0.1', port: 0 },
    })

    await runtime.ready
    assertEquals(await Promise.all([runtime.shutdown(), runtime.shutdown()]), [
      undefined,
      undefined,
    ])
    await runtime.finished
    assertEquals(
      JSON.parse(
        await readFile(`${workspace}/.cluster/registry.v1.json`, 'utf8'),
      ).version,
      1,
    )
  } finally {
    process.chdir(originalCwd)
    await rm(workspace, { recursive: true })
    await rm(`${workspace}.organizations`, { recursive: true, force: true })
  }
})

test('Main finishes remaining cleanup and surfaces producer shutdown failures', { timeout: 10_000 }, async (t) => {
  const workspace = await createTempWorkspace()
  const originalCwd = process.cwd()
  const stopSessions = SessionManager.prototype.stop
  t.mock.method(SessionManager.prototype, 'stop', async function (this: SessionManager) {
    await stopSessions.call(this)
    throw new Error('Fixture session cleanup failure')
  })
  const stopEvents = t.mock.method(EventService.prototype, 'stop')
  try {
    process.chdir(workspace)
    const config = ConfigSchema.parse({ agent: { workspace: '.' }, channels: {}, mcp: {} })
    const runtime = await startMainRuntime(config, { gateway: { host: '127.0.0.1', port: 0 } })
    await runtime.ready
    await assert.rejects(runtime.shutdown(), (error: unknown) => {
      assert(error instanceof AggregateError)
      assert(error.errors.some((cause) => cause instanceof Error && cause.message === 'Fixture session cleanup failure'))
      return true
    })
    await runtime.finished
    assert.equal(stopEvents.mock.callCount(), 1)
  } finally {
    process.chdir(originalCwd)
    await rm(workspace, { recursive: true, force: true })
    await rm(`${workspace}.organizations`, { recursive: true, force: true })
  }
})
