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

test('sidebar remote action opens the existing draft picker without allocating or changing routing ownership', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const workspace = readFileSync(new URL('./components/ChatWorkspace.vue', import.meta.url), 'utf8')
  assert.match(sidebar, /action.id !== 'remote' \|\| props.remoteFolders/)
  assert.match(sidebar, /id === 'remote'.*emit\('remote'\)/)
  assert.match(chat, /:remote-folders="installation.mode === 'main'"/)
  assert.match(chat, /@remote="createNewWebChat\(undefined, true, true\)"/)
  const createDraft = chat.slice(chat.indexOf('function createNewWebChat('), chat.indexOf('function clearPendingAttachments('))
  assert.match(createDraft, /emit\('primary-change', ''\)/)
  assert.match(createDraft, /router.replace\(\{ name: 'chat', params: \{ projectId: props.projectId \} \}\)/)
  assert.match(createDraft, /if \(props.managed\) emit\('navigate', ''\)/)
  assert.match(createDraft, /if \(openRemotePicker\) await executionLocationSelector.value\?\.openRemote\(\)/)
  assert.match(createDraft, /else chatInput.value\?\.focus/)
  assert.match(createDraft, /createRemoteChatDraft\(props.apiBase, target\)/)
  assert.doesNotMatch(createDraft, /\.prepare\(|fetch\(/)
  assert.match(workspace, /@primary-change="primaryChanged"/)
  assert.match(workspace, /function primaryChanged\(\)[\s\S]*?childId.value = ''/)
})

test('direct remote picker loads only inventory, preserves offline targets, cancels and can retry errors', async t => {
  const requests: { signal: AbortSignal; finish: (body: unknown, status?: number) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, '/nodes/v1')
    assert.equal(options.method, undefined)
    return new Promise<Response>(resolve => requests.push({
      signal: options.signal!,
      finish: (body, status = 200) => resolve(Response.json(body, { status })),
    }))
  })
  const { props, state } = mount(t, 'ExecutionLocationSelector', { apiBase: 'http://localhost' })
  state().popover = { show: () => { void state().refresh() } }
  await state().openRemote()
  assert.equal(state().remoteOnly, true)
  assert.equal(state().loading, true)
  const capability = { capabilityId: 'code', kind: 'workdir', displayName: 'Code', online: true }
  requests[0]!.finish({ version: 1, nodes: [
    { nodeId: 'main', displayName: 'Main', role: 'main', connection: 'connected', capabilities: [capability] },
    { nodeId: 'child', displayName: 'Laptop', role: 'child', connection: 'offline', capabilities: [capability] },
  ] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state().nodes.length, 1)
  assert.equal(state().targets[0].available, false)
  state().closed()
  assert.equal(state().remoteOnly, false)
  await state().openRemote()
  state().closed()
  assert.equal(requests[1]!.signal.aborted, true)
  requests[1]!.finish({ version: 1, nodes: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state().nodes.length, 1)
  await state().openRemote()
  requests[2]!.finish({}, 503)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(state().error, /503/)
  assert.equal(state().nodes.length, 0)
  assert.equal(state().loading, false)
  const retry = state().refresh()
  assert.equal(state().error, '')
  requests[3]!.finish({ version: 1, nodes: [] })
  await retry
  assert.equal(state().loading, false)
  assert.equal(state().error, '')
  state().closed()
  props.disabled = true
  await nextTick()
  await state().openRemote()
  assert.equal(requests.length, 4)
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
