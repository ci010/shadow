import assert from 'node:assert/strict'
import test from 'node:test'
import { createDevelopmentRestart, DEVELOPMENT_RESTART_MESSAGE } from './development-restart.js'

test('restart is limited to unpackaged connected dev IPC', () => {
  for (const [packaged, flag, connected] of [[true, '1', true], [false, undefined, true], [false, '1', false]] as const) {
    assert.equal(createDevelopmentRestart(packaged, { env: { SHADOW_DESKTOP_DEV_IPC: flag }, connected, send() {} }, () => {}, () => {}), undefined)
  }
})

test('restart sends once and quits only after IPC delivery; errors allow retry', () => {
  let callback!: (error: Error | null) => void
  let sends = 0; let quits = 0; let errors = 0
  const channel = { env: { SHADOW_DESKTOP_DEV_IPC: '1' }, connected: true,
    send(message: unknown, cb: typeof callback) { assert.deepEqual(message, DEVELOPMENT_RESTART_MESSAGE); sends++; callback = cb } }
  const restart = createDevelopmentRestart(false, channel, () => quits++, () => errors++)!
  restart(); restart()
  assert.equal(sends, 1); assert.equal(quits, 0)
  callback(new Error('closed'))
  restart(); callback(null); restart()
  assert.equal(errors, 1); assert.equal(sends, 2); assert.equal(quits, 1)
})
