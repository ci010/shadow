import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createChatContextApi, installChatContextPickers } from './chat-context.js'
import { IPC_CHANNELS } from './ipc-contract.js'
import type { WindowControlsIpc } from './window-controls.js'

type Kind = 'files' | 'folders'
const channels = {
  files: IPC_CHANNELS.selectChatContextFiles,
  folders: IPC_CHANNELS.selectChatContextFolders,
}

class FakeWindow extends EventEmitter {
  destroyed = false
  contentsDestroyed = false
  readonly webContents = {
    mainFrame: {},
    isDestroyed: () => this.contentsDestroyed,
  }
  isDestroyed = () => this.destroyed
}

function fixture(pick: (kind: Kind) => Promise<string[]>) {
  const window = new FakeWindow()
  const handlers = new Map<string, Parameters<WindowControlsIpc['handle']>[1]>()
  const dispose = installChatContextPickers({
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }, window, {
    selectFiles: () => pick('files'),
    selectFolders: () => pick('folders'),
  })
  const invoke = (kind: Kind, ...args: unknown[]) => handlers.get(channels[kind])!({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }, ...args)
  return { window, handlers, dispose, invoke }
}

const invalidResults: unknown[] = [
  undefined, null, {}, 'C:\\Projects', [null], [undefined], [1], [''],
  ['relative\\file'], ['C:relative'], ['\\drive-relative'], ['\\\\'], ['\\\\server'],
  ['C:\\bad\nfile'], ['/bad\0file'], ['/bad\u007ffile'], ['/bad\u0085file'],
  ['/' + 'x'.repeat(10_000)], Array(1), Array(1_001).fill('/file'),
  ['/valid', 'relative'],
]

test('chat pickers return multiple local references unchanged or an empty cancellation', async () => {
  const selections = {
    files: ['C:\\Projects\\你好.txt', '/projects/a b.txt', '\\\\server\\share\\file.txt'],
    folders: ['C:\\Projects', '/projects', '\\\\server\\share'],
  }
  let canceled = false
  const { invoke, dispose } = fixture(async (kind) => canceled ? [] : selections[kind])
  for (const kind of ['files', 'folders'] as const) {
    const result = await invoke(kind)
    assert.deepEqual(result, selections[kind])
    assert.notEqual(result, selections[kind])
  }
  canceled = true
  assert.deepEqual(await invoke('files'), [])
  assert.deepEqual(await invoke('folders'), [])
  dispose()
})

test('both chat pickers require the Main window main frame and zero arguments', () => {
  const { window, handlers, invoke, dispose } = fixture(async () => [])
  for (const kind of ['files', 'folders'] as const) {
    const handler = handlers.get(channels[kind])!
    assert.throws(() => handler({ sender: {}, senderFrame: window.webContents.mainFrame }), /requires the Main window/)
    assert.throws(() => handler({ sender: window.webContents, senderFrame: {} }), /requires the Main window/)
    assert.throws(() => handler({ sender: window.webContents }), /requires the Main window/)
    for (const args of [[undefined], [null], ['C:\\Other'], [{ path: '/other' }]]) {
      assert.throws(() => invoke(kind, ...args), /accepts no arguments/)
    }
    window.destroyed = true
    assert.throws(() => invoke(kind), /requires the Main window/)
    window.destroyed = false
    window.contentsDestroyed = true
    assert.throws(() => invoke(kind), /requires the Main window/)
    window.contentsDestroyed = false
  }
  const retainedHandler = handlers.get(channels.files)!
  dispose()
  assert.throws(() => retainedHandler({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  }), /requires the Main window/)
  assert.equal(handlers.size, 0)
  assert.equal(window.listenerCount('closed'), 0)
  dispose()
})

test('chat picker validates and bounds native results before returning them', async () => {
  let result: unknown = []
  const { invoke, dispose } = fixture(async () => result as string[])
  for (const kind of ['files', 'folders'] as const) {
    for (const invalid of invalidResults) {
      result = invalid
      await assert.rejects(Promise.resolve(invoke(kind)), /selection is invalid/)
    }
    for (const valid of [[], ['/' + 'x'.repeat(9_999)], Array(1_000).fill('/file')]) {
      result = valid
      assert.deepEqual(await invoke(kind), valid)
    }
  }
  dispose()
})

test('repeated picks share a dialog and file/folder dialogs are serialized without mixing results', async () => {
  let settle!: (paths: string[]) => void
  const calls: Kind[] = []
  const { invoke, dispose } = fixture((kind) => {
    calls.push(kind)
    return kind === 'files'
      ? new Promise((resolve) => { settle = resolve })
      : Promise.resolve(['/folder'])
  })
  const first = invoke('files')
  assert.equal(invoke('files'), first)
  const folders = invoke('folders')
  assert.equal(invoke('folders'), folders)
  assert.notEqual(folders, first)
  await Promise.resolve()
  assert.deepEqual(calls, ['files'])
  settle(['/file.txt'])
  assert.deepEqual(await first, ['/file.txt'])
  assert.deepEqual(await folders, ['/folder'])
  assert.deepEqual(calls, ['files', 'folders'])
  dispose()
})

test('closing during a pick discards results, cancels queued dialogs, and removes both handlers', async () => {
  let settle!: (paths: string[]) => void
  let calls = 0
  const { invoke, window, handlers, dispose } = fixture(() => {
    calls += 1
    return new Promise((resolve) => { settle = resolve })
  })
  const files = invoke('files')
  const folders = invoke('folders')
  await Promise.resolve()
  window.emit('closed')
  settle(['/file.txt'])
  assert.deepEqual(await files, [])
  assert.deepEqual(await folders, [])
  assert.equal(calls, 1)
  assert.equal(handlers.size, 0)
  assert.equal(window.listenerCount('closed'), 0)
  dispose()
})

test('a window closed before the queued microtask never opens a native dialog', async () => {
  let calls = 0
  const { invoke, window, dispose } = fixture(async () => { calls += 1; return ['/file'] })
  const result = invoke('files')
  window.emit('closed')
  assert.deepEqual(await result, [])
  assert.equal(calls, 0)
  dispose()
})

test('destroyed windows or web contents discard pending results and dialog errors', async () => {
  for (const destroyedTarget of ['destroyed', 'contentsDestroyed'] as const) {
    for (const reject of [false, true]) {
      let settle!: () => void
      const { invoke, window, dispose } = fixture(() => new Promise((resolve, fail) => {
        settle = () => reject ? fail(new Error('Window destroyed')) : resolve(['/file'])
      }))
      const result = invoke('files')
      await Promise.resolve()
      window[destroyedTarget] = true
      settle()
      assert.deepEqual(await result, [])
      dispose()
    }
  }
})

test('dialog failures remain visible and do not block queued picks or retries', async () => {
  let fail = true
  const { invoke, dispose } = fixture(async (kind) => {
    if (kind === 'files' && fail) throw new Error('Native dialog unavailable')
    return [`/${kind}`]
  })
  const first = invoke('files')
  const folders = invoke('folders')
  await assert.rejects(Promise.resolve(first), /Native dialog unavailable/)
  assert.deepEqual(await folders, ['/folders'])
  fail = false
  assert.deepEqual(await invoke('files'), ['/files'])
  dispose()
})

test('preload exposes only frozen, zero-argument chat pickers and validates both result arrays', async () => {
  let result: unknown = ['/file']
  const invocations: unknown[][] = []
  const api = createChatContextApi({
    invoke: async (...args) => { invocations.push(args); return result },
  })
  assert.ok(Object.isFrozen(api))
  assert.deepEqual(Object.keys(api), ['selectFiles', 'selectFolders'])
  for (const method of ['selectFiles', 'selectFolders'] as const) {
    result = ['/file']
    const paths = await api[method]()
    assert.deepEqual(paths, result)
    assert.notEqual(paths, result)
    for (const invalid of invalidResults) {
      result = invalid
      await assert.rejects(api[method](), /selection is invalid/)
    }
    result = []
    assert.deepEqual(await api[method](), [])
  }
  assert.ok(invocations.every((args) => args.length === 1))
  assert.deepEqual([...new Set(invocations.map((args) => args[0]))], [
    IPC_CHANNELS.selectChatContextFiles,
    IPC_CHANNELS.selectChatContextFolders,
  ])
})
