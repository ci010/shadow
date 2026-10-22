import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createInstallationContextProvider, useInstallationContext } from './composables/useInstallationContext.ts'
import { createFoldersClient } from './folders-client.ts'

function mount(t: TestContext, client: object, localNodeId?: string) {
  const url = new URL('./components/FolderDialog.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'folder-picker' }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => id.endsWith('useInstallationContext.ts') ? { useInstallationContext } : id.endsWith('.vue') ? {} : require(id), module, module.exports)
  module.exports.default.render = () => null
  const events: unknown[] = []
  let instance: any
  const props = reactive({ mode: null as string | null, client })
  const renderer = createRenderer<object, object>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp(defineComponent({ setup: () => () => h(module.exports.default, { ...props,
    onRegistered: (folder: unknown) => events.push(folder), onClose: () => { props.mode = null }, ref: (value: unknown) => { instance = value } }) }))
  if (localNodeId) app.use(createInstallationContextProvider({ version: 1, mode: 'child', localNodeId, mainConnection: 'connected', mainLatencyMs: null, apiBase: 'http://localhost' }))
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
  app.mount({})
  t.after(() => {
    app.unmount()
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document')
    if (originalElement) Object.defineProperty(globalThis, 'HTMLElement', originalElement); else Reflect.deleteProperty(globalThis, 'HTMLElement')
  })
  return { props, state: () => instance.$.setupState, events }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const devices = [
  { nodeId: 'main-id', name: 'Main', role: 'main', online: true, supported: true },
  { nodeId: 'child-id', name: 'Child', role: 'child', online: true, supported: true },
  { nodeId: 'offline', name: 'Offline', role: 'child', online: false, supported: true },
]
const folder = { id: 'folder', name: 'Main folder', path: '/picked', createdAt: '2026-10-22' }

test('soft picker selects device, browses home and parent, accepts manual paths, retries errors and registers without creating a chat', async t => {
  const calls: unknown[][] = []
  let fail = false
  const client = {
    pickerDevices: async () => devices,
    browseDirectory: async (node: string, path: string) => {
      calls.push(['browse', node, path]); if (fail) throw new Error('offline retry')
      return { path: path || '/home', parent: '/', directories: [{ name: '项目', path: '/home/项目' }], truncated: false }
    },
    selectDirectory: async (...args: unknown[]) => { calls.push(['select', ...args]); return folder },
  }
  const { props, state, events } = mount(t, client)
  props.mode = 'remote'; await tick()
  assert.equal(state().nodeId, 'child-id')
  assert.equal(state().devices.length, 3, 'Offline nodes remain visible')
  assert.deepEqual(calls[0], ['browse', 'child-id', ''])
  state().nodeId = 'main-id'; state().deviceChanged(); await tick()
  assert.deepEqual(calls[1], ['browse', 'main-id', ''])
  await state().browse(state().listing.parent)
  assert.equal(state().path, '/')
  fail = true; await state().browse('/bad')
  assert.equal(state().listing, undefined)
  assert.equal(state().error, 'offline retry')
  fail = false; await state().browse('/retry')
  assert.equal(state().error, '')
  state().path = '/manual/path'; await state().submit(); await nextTick()
  assert.equal(calls.at(-1)![0], 'select')
  assert.equal(calls.at(-1)![1], 'main-id')
  assert.equal(calls.at(-1)![2], '/manual/path')
  assert.deepEqual(events, [folder])
  assert.equal(props.mode, null)
})

test('soft picker cancels pending browsing and discards late directory results', async t => {
  let finish: ((value: unknown) => void) | undefined
  let pendingSignal: AbortSignal | undefined
  const { props, state, events } = mount(t, {
    pickerDevices: async () => devices,
    browseDirectory: (_node: string, _path: string, signal: AbortSignal) => { pendingSignal = signal; return new Promise(resolve => { finish = resolve }) },
  })
  props.mode = 'open'; await tick()
  assert.equal(state().busy, true)
  await state().close(); await nextTick()
  assert.equal(pendingSignal!.aborted, true)
  finish!({ path: '/stale', parent: '/', directories: [], truncated: false }); await tick()
  assert.equal(state().listing, undefined)
  assert.deepEqual(events, [])
})

test('clone parent uses the same soft Main picker but preserves clone request semantics', async t => {
  const calls: unknown[][] = []
  const { props, state } = mount(t, {
    pickerDevices: async () => devices,
    browseDirectory: async (node: string) => { calls.push(['browse', node]); return { path: '/parent', parent: '/', directories: [], truncated: false } },
    start: async (input: unknown) => { calls.push(['clone', input]); return { id: 'x', state: 'failed', destination: '/parent/repo', error: 'fixture' } },
  })
  props.mode = 'clone'; await tick()
  assert.deepEqual(calls[0], ['browse', 'main-id'])
  state().url = 'https://example.invalid/repo.git'; state().directoryName = 'repo'
  await state().submit()
  assert.equal(calls[1]![0], 'clone')
  assert.equal((calls[1]![1] as { parentPath: string }).parentPath, '/parent')
})

test('picker client keeps node identity separate from opaque paths and validates remote listings', async () => {
  const requests: { path: string; body: unknown }[] = []
  const client = createFoldersClient('http://localhost/projects/p/', async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json(path.endsWith('/devices') ? { devices } : path.endsWith('/browse')
      ? { listing: { path: 'Z:\\远端', parent: 'Z:\\', directories: [], truncated: false } } : { folder })
  })
  assert.equal((await client.pickerDevices()).length, 3)
  assert.equal((await client.browseDirectory('child-id', 'Z:\\远端')).path, 'Z:\\远端')
  await client.selectDirectory('main-id', '/picked')
  assert.deepEqual(requests[1], { path: '/projects/p/api/folders/picker/browse', body: { nodeId: 'child-id', path: 'Z:\\远端' } })
  assert.deepEqual(requests[2].body, { nodeId: 'main-id', path: '/picked' })
  const invalid = createFoldersClient('http://localhost/', async () => Response.json({ listing: { path: '/a', parent: null, directories: [{ name: '../escape', path: '/escape' }], truncated: false } }))
  await assert.rejects(invalid.browseDirectory('child-id', '/a'))
})


test('current Child identity is preferred for Open and other devices for Remote; device select participates in focus trap', async t => {
  const { props, state } = mount(t, {
    pickerDevices: async () => devices,
    browseDirectory: async () => ({ path: '/home', parent: '/', directories: [], truncated: false }),
  }, 'child-id')
  props.mode = 'open'; await tick()
  assert.equal(state().nodeId, 'child-id')
  props.mode = 'remote'; await tick()
  assert.equal(state().nodeId, 'main-id')
  let selected = false
  let firstFocused = false
  let prevented = false
  const first = { focus() { firstFocused = true } }
  const select = { focus() { selected = true } }
  state().dialog = { querySelectorAll: (selector: string) => {
    assert.ok(selector.includes('select:not(:disabled)'))
    assert.ok(selector.includes('textarea:not(:disabled)'))
    return [first, select]
  } }
  Object.assign(document, { activeElement: first })
  state().dialogKeydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(selected, true)
  Object.assign(document, { activeElement: select }); prevented = false
  state().dialogKeydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(firstFocused, true)
})
