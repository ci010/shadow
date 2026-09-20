import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { IPC_CHANNELS } from './ipc-contract.js'
import { createStartupDiagnosticsApi, installStartupDiagnostics } from './startup-diagnostics-ipc.js'
import type { WindowControlsIpc } from './window-controls.js'

test('startup log reveal is confined to the active main frame and accepts no paths', async () => {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    webContents: { mainFrame: {}, isDestroyed: () => false },
  })
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  let reveals = 0
  const dispose = installStartupDiagnostics({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: channel => { handlers.delete(channel) },
  }, window, () => { reveals++ })
  const handler = handlers.get(IPC_CHANNELS.revealStartupLog)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  await handler(event)
  assert.equal(reveals, 1)
  for (const args of [['C:\\secret'], [undefined], [null], [{}]]) assert.throws(() => handler(event, ...args), /no arguments/)
  assert.throws(() => handler({ ...event, sender: {} }), /Main window/)
  assert.throws(() => handler({ ...event, senderFrame: {} }), /Main window/)
  window.destroyed = true
  assert.throws(() => handler(event), /Main window/)
  window.emit('closed')
  assert.equal(handlers.size, 0)
  assert.throws(() => handler(event), /Main window/)
  dispose()
  assert.equal(reveals, 1)
})

test('preload diagnostics has only a frozen argument-free reveal capability', async () => {
  const calls: unknown[][] = []
  const api = createStartupDiagnosticsApi({ invoke: async (...args) => { calls.push(args) } })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(Object.keys(api), ['revealStartupLog'])
  await api.revealStartupLog()
  assert.deepEqual(calls, [[IPC_CHANNELS.revealStartupLog]])
})
