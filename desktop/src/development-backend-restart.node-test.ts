import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { DevelopmentBackendRestart } from './development-backend-restart.js'

test('coalesces requests, activates only successful builds, and cleans up after stop', async () => {
  const stages: string[] = []
  const entries: string[] = []
  const errors: unknown[] = []
  let finishBuild!: (error?: Error) => void
  let buildStarted!: () => void
  const controller = new DevelopmentBackendRestart(stage => new Promise((resolve, reject) => {
    stages.push(stage)
    finishBuild = error => error ? reject(error) : resolve()
    buildStarted()
  }), async (entry, activate) => { entries.push(entry); activate() }, error => errors.push(error))
  let started = new Promise<void>(resolve => { buildStarted = resolve })
  const first = controller.request()
  assert.equal(controller.request(), first)
  await started
  assert.deepEqual(entries, [])
  finishBuild()
  await first
  const entry = join(stages[0]!, 'dist', 'src', 'index.js')
  assert.deepEqual(entries, [entry])

  started = new Promise<void>(resolve => { buildStarted = resolve })
  const retry = controller.request()
  await started
  const error = new Error('compiler failed')
  finishBuild(error)
  await retry
  assert.deepEqual(errors, [error])
  assert.deepEqual(entries, [entry])
  await assert.rejects(access(stages[1]!), { code: 'ENOENT' })
  await controller.close(() => access(stages[0]!))
  await assert.rejects(access(stages[0]!), { code: 'ENOENT' })
  assert.equal(controller.request(), undefined)
})

test('quit stops the old backend without installing a pending build', async () => {
  const calls: string[] = []
  let finish!: () => void
  let stage!: string
  let buildStarted!: () => void
  const started = new Promise<void>(resolve => { buildStarted = resolve })
  const controller = new DevelopmentBackendRestart(directory => new Promise<void>(resolve => {
    stage = directory
    finish = resolve
    buildStarted()
  }), async () => { calls.push('replace') }, () => { calls.push('error') })
  controller.request()
  await started
  const closed = controller.close(async () => { calls.push('stop') })
  finish()
  await closed
  assert.deepEqual(calls, ['stop'])
  await assert.rejects(access(stage), { code: 'ENOENT' })
})
