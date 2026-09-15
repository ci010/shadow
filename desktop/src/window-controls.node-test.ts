import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { IPC_CHANNELS } from './ipc-contract.js'
import {
  framelessWindowOptions,
  installWindowControls,
  removeNativeMenus,
  type WindowControlTarget,
  type WindowControlsIpc,
} from './window-controls.js'
import { createWindowControlsApi } from './window-controls-preload.js'

class FakeWindow extends EventEmitter implements WindowControlTarget {
  maximized = false
  destroyed = false
  minimized = 0
  closed = 0
  readonly messages: unknown[] = []
  readonly webContents = {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
    send: (channel: string, state: unknown) => { this.messages.push({ channel, state }) },
  }
  isDestroyed = () => this.destroyed
  isMaximized = () => this.maximized
  minimize = () => { this.minimized += 1 }
  maximize = () => { this.maximized = true; this.emit('maximize') }
  unmaximize = () => { this.maximized = false; this.emit('unmaximize') }
  close = () => { this.closed += 1 }
}

class FakeIpc implements WindowControlsIpc {
  readonly handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  handle: WindowControlsIpc['handle'] = (channel, handler) => { this.handlers.set(channel, handler) }
  removeHandler = (channel: string) => { this.handlers.delete(channel) }
  invoke(channel: string, window: FakeWindow, ...args: unknown[]) {
    return this.handlers.get(channel)!({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }, ...args)
  }
}

test('desktop windows are frameless with no overlay or native application menu', () => {
  const options = framelessWindowOptions('C:\\test\\preload.cjs')
  assert.equal(options.frame, false)
  assert.equal(options.titleBarOverlay, undefined)
  assert.equal(options.autoHideMenuBar, undefined)
  assert.equal(options.icon, fileURLToPath(new URL('../assets/icon.ico', import.meta.url)))
  assert.deepEqual(options.webPreferences, {
    preload: 'C:\\test\\preload.cjs',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  })
  const calls: unknown[] = []
  removeNativeMenus(
    { setApplicationMenu: (menu) => { calls.push(['application-menu', menu]) } },
    { removeMenu: () => { calls.push(['remove-window-menu']) } },
  )
  assert.deepEqual(calls, [['application-menu', null], ['remove-window-menu']])
})

test('validated Main window commands minimize, maximize, restore and close', () => {
  const window = new FakeWindow()
  const ipc = new FakeIpc()
  const dispose = installWindowControls(ipc, window)
  assert.deepEqual(ipc.invoke(IPC_CHANNELS.windowGetState, window), { maximized: false })
  assert.equal(ipc.invoke(IPC_CHANNELS.windowMinimize, window), undefined)
  assert.equal(window.minimized, 1)
  assert.deepEqual(ipc.invoke(IPC_CHANNELS.windowToggleMaximize, window), { maximized: true })
  assert.deepEqual(ipc.invoke(IPC_CHANNELS.windowToggleMaximize, window), { maximized: false })
  assert.equal(ipc.invoke(IPC_CHANNELS.windowClose, window), undefined)
  assert.equal(window.closed, 1)
  assert.deepEqual(window.messages, [
    { channel: IPC_CHANNELS.windowStateChanged, state: { maximized: true } },
    { channel: IPC_CHANNELS.windowStateChanged, state: { maximized: false } },
  ])
  dispose()
})

test('every window command rejects another sender, subframe, destroyed window and extra arguments', () => {
  const window = new FakeWindow()
  const ipc = new FakeIpc()
  installWindowControls(ipc, window)
  for (const [channel, handler] of ipc.handlers) {
    assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }), /requires the Main window/)
    assert.throws(() => handler({ sender: window.webContents, senderFrame: {} }), /requires the Main window/)
    assert.throws(() => handler({ sender: window.webContents }), /requires the Main window/)
    for (const args of [[undefined], [null], [{ target: 'another-window' }]]) {
      assert.throws(() => ipc.invoke(channel, window, ...args), /accepts no arguments/)
    }
    window.destroyed = true
    assert.throws(() => ipc.invoke(channel, window), /requires the Main window/)
    window.destroyed = false
  }
  assert.equal(window.minimized, 0)
  assert.equal(window.closed, 0)
  assert.equal(window.maximized, false)
})

test('native maximize events publish state and window close removes handlers and listeners', () => {
  const window = new FakeWindow()
  const ipc = new FakeIpc()
  const dispose = installWindowControls(ipc, window)
  window.maximize()
  window.unmaximize()
  assert.equal(window.messages.length, 2)
  window.destroyed = true
  window.emit('maximize')
  assert.equal(window.messages.length, 2)
  window.emit('closed')
  dispose()
  assert.equal(ipc.handlers.size, 0)
  for (const event of ['maximize', 'unmaximize', 'closed']) assert.equal(window.listenerCount(event), 0)
})

test('preload forwards only narrow commands and validates returned state', async () => {
  const channels: string[] = []
  let result: unknown = { maximized: true }
  const ipc = {
    invoke: async (channel: string) => { channels.push(channel); return result },
    on: () => undefined,
    removeListener: () => undefined,
  }
  const api = createWindowControlsApi(ipc)
  assert.equal(Object.isFrozen(api), true)
  assert.deepEqual(await api.getState(), { maximized: true })
  assert.deepEqual(await api.toggleMaximize(), { maximized: true })
  assert.equal(await api.minimize(), undefined)
  assert.equal(await api.close(), undefined)
  assert.deepEqual(channels, [
    IPC_CHANNELS.windowGetState,
    IPC_CHANNELS.windowToggleMaximize,
    IPC_CHANNELS.windowMinimize,
    IPC_CHANNELS.windowClose,
  ])
  for (const invalid of [null, {}, { maximized: 'true' }, { maximized: true, secret: 'ignored' }]) {
    result = invalid
    await assert.rejects(api.getState(), /window state is invalid/)
    await assert.rejects(api.toggleMaximize(), /window state is invalid/)
  }
})

test('preload subscriptions expose only validated state and unsubscribe without leaking listeners', () => {
  const events = new EventEmitter()
  const api = createWindowControlsApi({
    invoke: async () => undefined,
    on: (channel, listener) => events.on(channel, listener),
    removeListener: (channel, listener) => events.removeListener(channel, listener),
  })
  const states: unknown[] = []
  const otherStates: unknown[] = []
  const unsubscribe = api.onStateChanged((state) => { states.push(state) })
  const unsubscribeOther = api.onStateChanged((state) => { otherStates.push(state) })
  const emit = (state: unknown) => events.emit(IPC_CHANNELS.windowStateChanged, { sender: 'private' }, state)
  emit({ maximized: true })
  emit(null)
  emit({ maximized: false, extra: true })
  unsubscribe()
  unsubscribe()
  emit({ maximized: false })
  assert.deepEqual(states, [{ maximized: true }])
  assert.deepEqual(otherStates, [{ maximized: true }, { maximized: false }])
  assert.equal(events.listenerCount(IPC_CHANNELS.windowStateChanged), 1)
  unsubscribeOther()
  assert.equal(events.listenerCount(IPC_CHANNELS.windowStateChanged), 0)
  assert.throws(() => api.onStateChanged(null as never), /must be a function/)
})
