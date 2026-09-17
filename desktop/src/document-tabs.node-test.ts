import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Input } from 'electron'
import { DOCUMENT_TAB_CHANNEL, installDocumentTabShortcuts, receiveDocumentTabShortcuts } from './document-tabs.js'

class FakeWindow extends EventEmitter {
  destroyed = false
  messages: unknown[] = []
  webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => this.destroyed,
    send: (channel: string, direction: number | 'close' | 'close-all') => { this.messages.push([channel, direction]) },
  })
  isDestroyed = () => this.destroyed
}

const input: Input = {
  type: 'keyDown', key: 'Tab', code: 'Tab', control: true, shift: false,
  alt: false, meta: false, isAutoRepeat: false, isComposing: false,
  location: 0, modifiers: ['control'],
}

test('native Ctrl+Tab dispatches one direction and suppresses duplicate DOM handling', () => {
  const window = new FakeWindow()
  const dispose = installDocumentTabShortcuts(window)
  let prevented = 0
  const event = { preventDefault: () => { prevented++ } }
  for (const patch of [{}, { shift: true }, { isAutoRepeat: true }]) {
    window.webContents.emit('before-input-event', event, { ...input, ...patch })
  }
  assert.equal(prevented, 3)
  assert.deepEqual(window.messages, [
    [DOCUMENT_TAB_CHANNEL, 1], [DOCUMENT_TAB_CHANNEL, -1], [DOCUMENT_TAB_CHANNEL, 1],
  ])
  dispose()
  dispose()
  assert.equal(window.webContents.listenerCount('before-input-event'), 0)
  assert.equal(window.listenerCount('closed'), 0)
})

test('native dispatch preserves other modifiers, plain Tab, key-up and composition', () => {
  const window = new FakeWindow()
  installDocumentTabShortcuts(window)
  const event = { preventDefault: () => { assert.fail('unrelated key consumed') } }
  for (const patch of [
    { control: false }, { control: false, shift: true }, { alt: true }, { meta: true },
    { isComposing: true }, { type: 'keyUp' }, { type: 'char' }, { key: 'Process' }, { key: 'A' },
  ]) window.webContents.emit('before-input-event', event, { ...input, ...patch })
  assert.deepEqual(window.messages, [])
  window.destroyed = true
  window.webContents.emit('before-input-event', event, input)
  assert.deepEqual(window.messages, [])
  window.emit('closed')
  assert.equal(window.webContents.listenerCount('before-input-event'), 0)
})

test('preload only relays validated directions and removes its listener on disposal', () => {
  const ipc = new EventEmitter()
  const directions: Array<number | 'close' | 'close-all'> = []
  const dispose = receiveDocumentTabShortcuts(ipc, direction => { directions.push(direction) })
  for (const value of [1, -1, 'close', 'close-all', 'delete', 0, '1', null, {}, true, undefined]) {
    ipc.emit(DOCUMENT_TAB_CHANNEL, {}, value)
  }
  assert.deepEqual(directions, [1, -1, 'close', 'close-all'])
  dispose()
  dispose()
  ipc.emit(DOCUMENT_TAB_CHANNEL, {}, 1)
  assert.deepEqual(directions, [1, -1, 'close', 'close-all'])
  assert.equal(ipc.listenerCount(DOCUMENT_TAB_CHANNEL), 0)
})

test('closed cleanup does not read webContents from a destroyed BrowserWindow', () => {
  const window = new FakeWindow()
  const contents = window.webContents
  Object.defineProperty(window, 'webContents', {
    get: () => {
      if (window.destroyed) throw new Error('Object has been destroyed')
      return contents
    },
  })
  const dispose = installDocumentTabShortcuts(window)
  window.destroyed = true
  assert.doesNotThrow(() => window.emit('closed'))
  assert.doesNotThrow(dispose)
  assert.equal(contents.listenerCount('before-input-event'), 0)
  assert.equal(window.listenerCount('closed'), 0)
})

test('native Ctrl+W closes one document and suppresses the window accelerator including repeats', () => {
  const window = new FakeWindow()
  installDocumentTabShortcuts(window)
  let prevented = 0
  const event = { preventDefault: () => { prevented++ } }
  window.webContents.emit('before-input-event', event, { ...input, key: 'w', code: 'KeyW' })
  window.webContents.emit('before-input-event', event, { ...input, key: 'W', code: 'KeyW', isAutoRepeat: true })
  assert.equal(prevented, 2)
  assert.deepEqual(window.messages, [[DOCUMENT_TAB_CHANNEL, 'close']])
  for (const patch of [{ meta: true }, { alt: true }, { control: false }, { isComposing: true }, { type: 'keyUp' }]) {
    window.webContents.emit('before-input-event', { preventDefault: () => assert.fail('unrelated shortcut consumed') },
      { ...input, key: 'w', code: 'KeyW', ...patch })
  }
  window.emit('closed')
  assert.equal(window.webContents.listenerCount('before-input-event'), 0)
})

test('native Ctrl+Shift+W closes all files once without triggering window close', () => {
  const window = new FakeWindow()
  const dispose = installDocumentTabShortcuts(window)
  let prevented = 0
  for (const isAutoRepeat of [false, true]) {
    window.webContents.emit('before-input-event', { preventDefault: () => { prevented++ } },
      { ...input, key: 'W', code: 'KeyW', shift: true, isAutoRepeat })
  }
  assert.equal(prevented, 2)
  assert.deepEqual(window.messages, [[DOCUMENT_TAB_CHANNEL, 'close-all']])
  dispose()
})
