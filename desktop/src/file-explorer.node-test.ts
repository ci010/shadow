import { createHmac } from 'node:crypto'
import { desktopMediaKey } from './media-reveal-key.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { FILE_EXPLORER_CHANNEL, createFileExplorerApi } from './file-explorer-contract.js'
import { installFileExplorer } from './file-explorer.js'

test('file explorer preload exposes only a frozen reveal capability', async () => {
  const calls: unknown[][] = []
  const api = createFileExplorerApi({ invoke: async (...args) => { calls.push(args) } })
  assert(Object.isFrozen(api))
  assert.deepEqual(Object.keys(api), ['attachment', 'showInFolder'])
  await api.showInFolder('/project/a.txt')
  assert.deepEqual(calls, [[FILE_EXPLORER_CHANNEL, '/project/a.txt']])
})

test('file explorer validates sender, document, path and existence and cleans up', async () => {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { mainFrame: { url: 'http://127.0.0.1:1234/' }, isDestroyed: () => false }),
  })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const shown: string[] = []
  installFileExplorer({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: channel => { handlers.delete(channel) },
  }, window as unknown as BrowserWindow, {
    kind: 'url', url: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234',
  }, path => { shown.push(path) })
  const handler = handlers.get(FILE_EXPLORER_CHANNEL)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
  const path = fileURLToPath(import.meta.url)
  const expires = Date.now() + 60_000
  const proof = { path, expires, signature: createHmac('sha256', desktopMediaKey).update(JSON.stringify([path, expires])).digest('hex') }
  assert.equal(await handler(event, { proof, reveal: false }), true)
  assert.deepEqual(shown, [])
  assert.equal(await handler(event, { proof: { ...proof, path: path + '.other' }, reveal: true }), false)
  assert.equal(await handler(event, { proof: { ...proof, signature: '0'.repeat(64) }, reveal: true }), false)
  assert.equal(await handler(event, { proof: { ...proof, expires: 0 }, reveal: true }), false)
  assert.equal(await handler(event, { proof: { path }, reveal: true }), false)
  assert.deepEqual(shown, [])
  assert.equal(await handler(event, { proof, reveal: true }), true)
  assert.deepEqual(shown, [path])
  for (const args of [[], [null], ['relative.txt'], [path, path], [`${path}\0`]]) {
    await assert.rejects(handler(event, ...args), /Invalid/)
  }
  await assert.rejects(handler(event, `${path}.missing`), /ENOENT/)
  await assert.rejects(handler({ ...event, senderFrame: null }, path), /trusted Main/)
  await assert.rejects(handler({ ...event, sender: {} } as IpcMainInvokeEvent, path), /trusted Main/)
  const contents = window.webContents
  contents.mainFrame.url = 'http://127.0.0.1:1234/projects/example/files?view=tree'
  contents.emit('did-navigate-in-page', {}, contents.mainFrame.url, true)
  await handler(event, path)
  assert.deepEqual(shown, [path, path])
  // A full navigation to an arbitrary same-origin page is not history routing.
  contents.emit('did-start-navigation', {}, 'http://127.0.0.1:1234/untrusted', false, true)
  contents.mainFrame.url = 'http://127.0.0.1:1234/untrusted'
  contents.emit('did-navigate', {}, contents.mainFrame.url)
  await assert.rejects(handler(event, path), /trusted Main/)
  contents.mainFrame.url = 'http://127.0.0.1:1234/'
  contents.emit('did-navigate', {}, contents.mainFrame.url)
  window.webContents.mainFrame.url = 'https://example.test/'
  await assert.rejects(handler(event, path), /trusted Main/)
  window.webContents.mainFrame.url = 'http://127.0.0.1:1234/'
  const pending = handler(event, path)
  window.emit('closed')
  await assert.rejects(pending, /no longer available/)
  assert.equal(handlers.size, 0)
  assert.equal(window.listenerCount('closed'), 0)
  for (const name of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) {
    assert.equal(contents.listenerCount(name), 0)
  }
  assert.deepEqual(shown, [path, path])
})
