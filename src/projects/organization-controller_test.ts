import assert from 'node:assert/strict'
import test from 'node:test'
import { OrganizationController } from './organization-controller.ts'
import { createProjectScope } from './scope.ts'

test('independent organizer has no automatic admission, and disable/stop abort explicit full or delta work', async () => {
  const scope = createProjectScope('fixture')
  let calls = 0
  const controller = new OrganizationController({ scope, changed() {}, organize: async (_mode, signal) => {
    calls++
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } })
  try {
    assert.equal(calls, 0)
    controller.update(false)
    await assert.rejects(controller.organize(new AbortController().signal), /organization_disabled/)
    assert.equal(calls, 0)
    controller.update(true)
    const full = controller.organize(new AbortController().signal, 'full')
    assert.equal(calls, 1)
    assert.equal(controller.status().running, true)
    await assert.rejects(controller.organize(new AbortController().signal, 'delta'), /already running/)
    const disabled = assert.rejects(full, /organization_disabled/)
    controller.update(false)
    await disabled
    assert.equal(controller.status().running, false)
    controller.update(true)
    assert.equal(calls, 1, 're-enabling never replays observation or organization')
    const delta = controller.organize(new AbortController().signal, 'delta')
    const stopped = assert.rejects(delta, /organization_stopped/)
    await controller.stop()
    await stopped
    assert.equal(calls, 2)
    await assert.rejects(controller.organize(new AbortController().signal), /organization_stopped/)
    assert.equal(calls, 2)
  } finally { await controller.stop(); scope.close() }
})
