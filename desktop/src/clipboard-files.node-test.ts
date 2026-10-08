import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { BrowserWindow, IpcMain } from 'electron'
import { readClipboardFiles, readClipboardPaths, parseClipboardPaths, installClipboardFiles } from './clipboard-files.js'
import { CLIPBOARD_FILES_CHANNEL, MAX_CLIPBOARD_BYTES, createClipboardFilesApi, parseClipboardFiles } from './clipboard-files-contract.js'

test('clipboard payload validates bytes, names, timestamps, count and total size', () => {
  const file = { name: 'file.bin', bytes: new Uint8Array([0, 255]), lastModified: 1 }
  assert.deepEqual(parseClipboardFiles([file]), [file])
  for (const value of [null, {}, [null], [{ ...file, name: '..\\file' }], [{ ...file, bytes: [1] }],
    [{ ...file, lastModified: NaN }], Array(101).fill(file)]) {
    assert.throws(() => parseClipboardFiles(value), /clipboard/i)
  }
  assert.throws(() => parseClipboardFiles([{ ...file, bytes: new Uint8Array(MAX_CLIPBOARD_BYTES + 1) }]), /100 MiB/)
})

test('preload clipboard reads are frozen, one-shot paste-only and zero-argument', async () => {
  let trusted = false
  const calls: unknown[][] = []
  const api = createClipboardFilesApi({
    invoke: async (...args) => {
      calls.push(args)
      return [{ name: 'readme.txt', bytes: new Uint8Array([1]), lastModified: 1 }]
    },
  }, () => { const value = trusted; trusted = false; return value })
  assert(Object.isFrozen(api))
  await assert.rejects(api.readFiles(), /trusted paste/)
  assert.equal(calls.length, 0)
  trusted = true
  assert.equal((await api.readFiles())[0]?.name, 'readme.txt')
  await assert.rejects(api.readFiles(), /trusted paste/)
  assert.deepEqual(calls, [[CLIPBOARD_FILES_CHANNEL]])
})

test('native clipboard file reads preserve mixed contents, empty files and order but reject folders, missing and oversized files', async t => {
  const scratch = resolve('.tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'clipboard-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, '\u6587\u6863.pdf'), second = join(root, 'empty.txt')
  await writeFile(first, new Uint8Array([0, 255, 10]))
  await writeFile(second, '')
  const files = await readClipboardFiles([first, second, first])
  assert.deepEqual(files.map(file => [file.name, [...file.bytes]]), [['\u6587\u6863.pdf', [0, 255, 10]], ['empty.txt', []]])
  assert(files.every(file => file.lastModified > 0))
  await assert.rejects(readClipboardFiles([first, join(root, 'missing')]))
  await assert.rejects(readClipboardFiles([root]))
  const large = join(root, 'large.bin')
  const handle = await open(large, 'w')
  await handle.truncate(MAX_CLIPBOARD_BYTES + 1)
  await handle.close()
  await assert.rejects(readClipboardFiles([large]), /100 MiB/)
  assert.throws(() => parseClipboardPaths(['relative.txt']), /Invalid/)
  assert.throws(() => parseClipboardPaths(Array(101).fill(first)), /100 files/)
})

test('non-Windows native file URI lists decode names and ignore network URLs, comments and plain text', async () => {
  const first = resolve('fixtures', 'a b.txt'), second = resolve('fixtures', 'empty.txt')
  const native = {
    read: async () => [{
      types: ['text/uri-list'],
      getType: async () => new Blob([`# copied files\n${pathToFileURL(first)}\nhttps://example.test/document\n${pathToFileURL(second)}\n`]),
    }, {
      types: ['text/plain'], getType: async () => new Blob(['/must/not/read.txt']),
    }],
  }
  const paths = await readClipboardPaths(native, 'linux')
  assert.deepEqual(paths, [first, second])
})

test('clipboard IPC rejects foreign frames, wrong documents and arguments, coalesces reads and discards closed-window results', async () => {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { mainFrame: { url: 'http://127.0.0.1:1234/' }, isDestroyed: () => false }),
  })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  let complete!: (files: Array<{ name: string; bytes: Uint8Array; lastModified: number }>) => void
  const read = new Promise<Array<{ name: string; bytes: Uint8Array; lastModified: number }>>(resolve => { complete = resolve })
  let reads = 0
  const dispose = installClipboardFiles({
    handle: (channel, listener) => { handlers.set(channel, listener) },
    removeHandler: channel => { handlers.delete(channel) },
  }, window as unknown as BrowserWindow, {
    kind: 'url', url: 'http://127.0.0.1:1234/', origin: 'http://127.0.0.1:1234',
  }, () => { reads++; return read })
  const handler = handlers.get(CLIPBOARD_FILES_CHANNEL)!
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (value: unknown, ...args: unknown[]) => handler(value as Electron.IpcMainInvokeEvent, ...args)
  assert.throws(() => invoke({ ...event, sender: {} }), /trusted Main/)
  assert.throws(() => invoke({ ...event, senderFrame: {} }), /trusted Main/)
  assert.throws(() => invoke(event, '/renderer-supplied-path'), /no arguments/)
  window.webContents.mainFrame.url = 'https://foreign.example/'
  assert.throws(() => invoke(event), /trusted Main/)
  window.webContents.mainFrame.url = 'http://127.0.0.1:1234/'
  window.webContents.mainFrame.url = 'http://127.0.0.1:1234/chat/session'
  window.webContents.emit('did-navigate-in-page', {}, window.webContents.mainFrame.url, true)
  const first = invoke(event)
  assert.equal(invoke(event), first)
  assert.equal(reads, 1)
  window.emit('closed')
  complete([{ name: 'private.txt', bytes: new Uint8Array([1]), lastModified: 1 }])
  await assert.rejects(first, /no longer available/)
  assert.equal(handlers.size, 0)
  assert.equal(window.listenerCount('closed'), 0)
  assert.equal(window.webContents.listenerCount('did-navigate-in-page'), 0)
  dispose()
})

test('clipboard IPC preserves trusted history routes and reloads but rejects replacement documents and stale reads', async () => {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'http://127.0.0.1:1234/' }, isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents })
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  let complete!: (files: []) => void
  const dispose = installClipboardFiles({
    handle: (channel, listener) => { handlers.set(channel, listener) },
    removeHandler: channel => { handlers.delete(channel) },
  }, window as unknown as BrowserWindow, {
    kind: 'url', url: contents.mainFrame.url, origin: 'http://127.0.0.1:1234',
  }, () => new Promise(resolve => { complete = resolve }))
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as Electron.IpcMainInvokeEvent
  const invoke = () => handlers.get(CLIPBOARD_FILES_CHANNEL)!(event)
  contents.mainFrame.url = 'http://127.0.0.1:1234/chat/other'
  assert.throws(invoke, /trusted Main/)
  contents.emit('did-navigate-in-page', {}, contents.mainFrame.url, true)
  const old = invoke()
  contents.emit('did-start-navigation', {}, contents.mainFrame.url, false, true)
  assert.throws(invoke, /trusted Main/)
  contents.emit('did-navigate', {}, contents.mainFrame.url)
  complete([])
  await assert.rejects(old, /no longer available/)
  const fresh = invoke()
  complete([])
  assert.deepEqual(await fresh, [])
  contents.emit('did-start-navigation', {}, 'http://127.0.0.1:1234/foreign', false, true)
  contents.mainFrame.url = 'http://127.0.0.1:1234/foreign'
  contents.emit('did-navigate', {}, contents.mainFrame.url)
  assert.throws(invoke, /trusted Main/)
  contents.emit('did-navigate-in-page', {}, 'http://127.0.0.1:1234/', true)
  assert.throws(invoke, /trusted Main/)
  dispose()
})
