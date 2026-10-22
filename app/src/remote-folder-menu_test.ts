import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

function mount(t: TestContext, name: string, initial: Record<string, unknown>) {
  const url = new URL(`./components/${name}.vue`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: name }).content
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? {} : require(id), module, module.exports,
  )
  module.exports.default.render = () => null
  const props = reactive({ ...initial })
  let instance: any
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(module.exports.default, { ...props, ref: (value: unknown) => { instance = value } }),
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { props, state: () => instance.$.setupState }
}

test('sidebar remote action opens a registration dialog on every UI instead of creating a remote chat draft', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const dialog = readFileSync(new URL('./components/FolderDialog.vue', import.meta.url), 'utf8')
  assert.match(sidebar, /const folderActions = computed\(\(\) => FOLDER_ACTIONS\)/)
  assert.match(sidebar, /id === 'remote'\) dialogMode.value = 'remote'/)
  assert.doesNotMatch(sidebar, /id === 'remote'.*emit\('remote'\)/)
  assert.match(dialog, /props.client.selectDirectory\(nodeId.value, path.value.trim\(\), current.signal\)/)
  assert.doesNotMatch(dialog, /shadowDesktop|selectDirectory\?\./)
})

test('direct picker loads scoped folders and node inventory, preserves offline targets, cancels and can retry errors', async t => {
  const requests: { path: string; signal: AbortSignal; finish: (body: unknown, status?: number) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL | string, options: RequestInit) => {
    const path = new URL(url).pathname
    assert.ok(['/nodes/v1', '/projects/a/api/folders', '/projects/b/api/folders'].includes(path))
    assert.equal(options.method, undefined)
    return new Promise<Response>(resolve => requests.push({
      path, signal: options.signal!,
      finish: (body, status = 200) => resolve(Response.json(body, { status })),
    }))
  })
  const { props, state } = mount(t, 'ExecutionLocationSelector', { apiBase: 'http://localhost/projects/a/', projectId: 'a' })
  state().popover = { show: () => { state().menuOpened() } }
  await state().openRemote()
  assert.equal(state().loading, true)
  const capability = { capabilityId: 'code', kind: 'workdir', displayName: 'Code', online: true }
  requests[0]!.finish({ version: 1, nodes: [
    { nodeId: 'main', displayName: 'Main', role: 'main', connection: 'connected', capabilities: [capability] },
    { nodeId: 'child', displayName: 'Laptop', role: 'child', connection: 'offline', capabilities: [capability] },
  ] })
  const local = { id: 'local', projectId: 'a', name: 'Local', path: 'C:\\fixture\\local', createdAt: '2026-09-17' }
  requests[1]!.finish({ folders: [local] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state().nodes.length, 2)
  assert.equal(state().targets[0].available, false)
  assert.equal(state().folderTargets[0].folder.id, 'local', 'Programmatic opening includes local folders too')
  state().closed()
  await state().openRemote()
  state().closed()
  assert.equal(requests[2]!.signal.aborted, true)
  assert.equal(requests[3]!.signal.aborted, true)
  requests[2]!.finish({ version: 1, nodes: [] })
  requests[3]!.finish({ folders: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state().nodes.length, 2)
  await state().openRemote()
  requests[4]!.finish({}, 503)
  requests[5]!.finish({ folders: [local] })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(state().error, /503/)
  assert.equal(state().nodes.length, 0)
  assert.equal(state().loading, false)
  const retry = state().refresh()
  assert.equal(state().error, '')
  requests[6]!.finish({ version: 1, nodes: [] })
  requests[7]!.finish({ folders: [local] })
  await retry
  assert.equal(state().loading, false)
  assert.equal(state().error, '')
  const pending = state().refresh()
  props.projectId = 'b'
  props.apiBase = 'http://localhost/projects/b/'
  await nextTick()
  assert.equal(requests[8]!.signal.aborted, true)
  assert.equal(state().folderTargets.length, 0, 'Switching projects immediately drops previous project options')
  requests[8]!.finish({ version: 1, nodes: [] })
  requests[9]!.finish({ folders: [local] })
  await pending
  assert.equal(state().folderTargets.length, 0, 'Late responses cannot restore previous project folders')
  const last = requests.length - 2
  requests[last]!.finish({ version: 1, nodes: [] })
  requests[last + 1]!.finish({ folders: [{ ...local, id: 'b-local', projectId: 'b' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state().folderTargets[0].folder.id, 'b-local')
  state().closed()
  const count = requests.length
  props.disabled = true
  await nextTick()
  await state().openRemote()
  assert.equal(requests.length, count)
})

test('programmatic popover opening focuses its panel and Escape restores the trigger', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {},
  } })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  let panelFocused = false
  let triggerFocused = false
  const { state } = mount(t, 'ComposerPopover', { label: 'Open remote folder' })
  state().trigger = {
    getBoundingClientRect: () => ({ left: 300, top: 250, bottom: 282 }),
    focus: () => { triggerFocused = true },
  }
  state().panel = { querySelector: () => null, focus: () => { panelFocused = true } }
  await state().show()
  assert.equal(state().open, true)
  assert.equal(panelFocused, true)
  let prevented = false
  state().keydown({ key: 'Escape', preventDefault: () => { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, true)
  assert.equal(state().open, false)
  assert.equal(triggerFocused, true)
})
