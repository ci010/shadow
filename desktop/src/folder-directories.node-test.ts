import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { IPC_CHANNELS } from './ipc-contract.js'
import { createFolderDirectoriesApi, installFolderDirectoryPicker } from './folder-directories.js'
import type { WindowControlsIpc } from './window-controls.js'

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = {
    mainFrame: {},
    isDestroyed: () => this.destroyed,
  }
  isDestroyed = () => this.destroyed
}

function fixture(pick: () => Promise<string | null>) {
  const window = new FakeWindow()
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  const dispose = installFolderDirectoryPicker({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }, window, pick)
  const invoke = (...args: unknown[]) => handlers.get(IPC_CHANNELS.selectFolderDirectory)!({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }, ...args)
  return { window, handlers, dispose, invoke }
}

test('folder picker returns a selected folder or cancellation without bootstrap mutation', async () => {
  let result: string | null = 'C:\\Folders\\Example'
  const { invoke, dispose } = fixture(async () => result)
  assert.equal(await invoke(), result)
  result = null
  assert.equal(await invoke(), null)
  dispose()
})

test('folder picker rejects foreign windows, subframes, arguments and destroyed windows', () => {
  const { window, handlers, invoke, dispose } = fixture(async () => null)
  const handler = handlers.get(IPC_CHANNELS.selectFolderDirectory)!
  assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }), /requires the Main window/)
  assert.throws(() => handler({ sender: window.webContents, senderFrame: {} }), /requires the Main window/)
  assert.throws(() => handler({ sender: window.webContents }), /requires the Main window/)
  for (const args of [[undefined], [null], [{ path: 'C:\\Other' }]]) {
    assert.throws(() => invoke(...args), /accepts no arguments/)
  }
  window.destroyed = true
  assert.throws(() => invoke(), /requires the Main window/)
  dispose()
})

test('concurrent requests share one native dialog and closing removes its handler', async () => {
  let settle!: (value: string | null) => void
  let calls = 0
  const { invoke, window, handlers, dispose } = fixture(() => {
    calls += 1
    return new Promise((resolve) => { settle = resolve })
  })
  const first = invoke()
  const second = invoke()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  window.emit('closed')
  settle('C:\\Folders\\Example')
  assert.equal(await first, null)
  assert.equal(handlers.size, 0)
  assert.equal(window.listenerCount('closed'), 0)
  dispose()
})

test('picker failures remain visible and allow a later retry', async () => {
  let fail = true
  const { invoke, dispose } = fixture(async () => {
    if (fail) throw new Error('Directory dialog unavailable')
    return '/folders/example'
  })
  await assert.rejects(Promise.resolve(invoke()), /dialog unavailable/)
  fail = false
  assert.equal(await invoke(), '/folders/example')
  dispose()
})

test('preload exposes only the frozen zero-argument picker and validates the result', async () => {
  let result: unknown = 'C:\\Folders\\Example'
  const channels: string[] = []
  const api = createFolderDirectoriesApi({
    invoke: async (channel) => { channels.push(channel); return result },
  })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(Object.keys(api), ['selectDirectory'])
  assert.equal(await api.selectDirectory(), result)
  assert.deepEqual(channels, [IPC_CHANNELS.selectFolderDirectory])
  for (const invalid of [undefined, {}, '', 'relative\\folder', 'C:\\bad\nfolder', 'x'.repeat(10_001)]) {
    result = invalid
    await assert.rejects(api.selectDirectory(), /selection is invalid/)
  }
  result = null
  assert.equal(await api.selectDirectory(), null)
})
