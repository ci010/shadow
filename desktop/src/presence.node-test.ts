import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { PowerMonitor } from 'electron'
import { installPresence, PRESENCE_CHANNEL } from './presence.js'
import type { WindowControlTarget, WindowControlsIpc } from './window-controls.js'

test('powerMonitor supplies only coarse idle/lock state; owning main-frame IPC and lifecycle cleanup', () => {
  const monitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 180, getSystemIdleState: () => 'idle' })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    webContents: { mainFrame: {}, isDestroyed: () => false, send: () => {} } })
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  installPresence({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } },
    window as unknown as WindowControlTarget, monitor as unknown as PowerMonitor, 'darwin')
  const read = handlers.get(PRESENCE_CHANNEL)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  assert.deepEqual(read(event), { idleSeconds: 180, locked: false })
  monitor.emit('lock-screen')
  assert.deepEqual(read(event), { idleSeconds: 180, locked: true })
  monitor.emit('unlock-screen')
  assert.deepEqual(read(event), { idleSeconds: 180, locked: false })
  assert.throws(() => read({ ...event, senderFrame: {} }), /owning window/)
  assert.throws(() => read({ ...event, sender: {} }), /owning window/)
  assert.throws(() => read(event, 'userId'), /owning window/)
  window.emit('closed')
  assert.equal(handlers.size, 0)
  assert.equal(monitor.listenerCount('lock-screen'), 0)
  assert.equal(monitor.listenerCount('unlock-screen'), 0)
})
