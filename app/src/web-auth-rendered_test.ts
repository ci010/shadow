import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, nextTick, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createBrowserSession } from './web-auth.ts'

interface Element {
  tag: string
  text: string
  props: Record<string, unknown>
  style: Record<string, string>
  children: Element[]
  parent?: Element
  value?: string
  addEventListener: () => void
  getRootNode: () => { activeElement: null }
}
const element = (tag: string, text = ''): Element => ({
  tag, text, props: {}, style: {}, children: [], addEventListener() {}, getRootNode: () => ({ activeElement: null }),
})
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')

function loadComponent(url: URL): Component {
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'auth-test', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? { default: loadComponent(new URL(id, url)) }
      : id.endsWith('.png') ? { default: 'fixture-logo.png' } : require(id), module, module.exports,
  )
  return module.exports.default
}

function mount(t: TestContext, name: string, props: Record<string, unknown> = {}, shadowDesktop?: unknown) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousDocumentType = Object.getOwnPropertyDescriptor(globalThis, 'Document')
  const previousShadowRoot = Object.getOwnPropertyDescriptor(globalThis, 'ShadowRoot')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { shadowDesktop } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null } })
  Object.defineProperty(globalThis, 'Document', { configurable: true, value: class {} })
  Object.defineProperty(globalThis, 'ShadowRoot', { configurable: true, value: class {} })
  const renderer = createRenderer<Element, Element>({
    createElement: element, createText: value => element('#text', value), createComment: value => element('#comment', value),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, value) => { node.text = value },
    setElementText: (node, value) => { node.text = value; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = element('root')
  const app = renderer.createApp(loadComponent(new URL(name, import.meta.url)), props)
  app.mount(root)
  t.after(() => {
    app.unmount()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousDocumentType) Object.defineProperty(globalThis, 'Document', previousDocumentType)
    else Reflect.deleteProperty(globalThis, 'Document')
    if (previousShadowRoot) Object.defineProperty(globalThis, 'ShadowRoot', previousShadowRoot)
    else Reflect.deleteProperty(globalThis, 'ShadowRoot')
  })
  const nodes = (node: Element = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
  const button = (label: string) => {
    const result = nodes().find(node => node.tag === 'button' && (node.props['aria-label'] === label || text(node).includes(label)))
    assert.ok(result, `Missing button: ${label}`)
    return result
  }
  const click = async (label: string) => {
    const target = button(label)
    assert.notEqual(target.props.disabled, true)
    await (target.props.onClick as () => Promise<void>)()
    await nextTick()
  }
  return { root, nodes, button, click, text: () => text(root) }
}

test('browser pairing renders labeled input, clears submitted code, and announces recoverable errors', async t => {
  let requestBody: string | undefined
  const session = createBrowserSession('http://fixture', { fetch: async (_url, init) => {
    requestBody = init?.body as string | undefined
    return init?.method === 'POST'
      ? Response.json({ error: 'invalid_pairing_code' }, { status: 401 })
      : Response.json({ version: 1, required: true, authenticated: false })
  } })
  t.after(() => session.dispose())
  await session.refresh()
  const view = mount(t, './BrowserAuth.vue', { session })
  assert.match(view.text(), /Connect this browser/)
  assert.equal(view.button('Connect browser').props.disabled, true)
  assert.equal(view.nodes().find(node => node.tag === 'label')?.props.for, 'pairing-code')
  const input = view.nodes().find(node => node.tag === 'input')!
  assert.equal(input.props.autocomplete, 'off')
  ;(input.props['onUpdate:modelValue'] as (value: string) => void)('test-code')
  await nextTick()
  assert.equal(view.button('Connect browser').props.disabled, false)
  const form = view.nodes().find(node => node.tag === 'form')!
  await (form.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} })
  await nextTick()
  assert.equal(requestBody, '{"code":"test-code"}')
  assert.equal(input.value, '')
  assert.match(view.text(), /invalid or expired/)
  assert.ok(view.nodes().some(node => node.props.role === 'alert'))
  assert.doesNotMatch(view.text(), /Minimize window|Maximize window|Close window/)
})

test('unreachable bootstrap renders explicit retry rather than pairing or application content', async t => {
  let calls = 0
  const session = createBrowserSession('http://fixture', { fetch: async () => {
    if (++calls === 1) throw new TypeError('offline')
    return Response.json({ version: 1, required: true, authenticated: false })
  } })
  t.after(() => session.dispose())
  await session.refresh()
  const view = mount(t, './BrowserAuth.vue', { session })
  assert.match(view.text(), /Cannot connect to Shadow/)
  assert.equal(view.nodes().some(node => node.tag === 'input'), false)
  await view.click('Retry')
  assert.match(view.text(), /Connect this browser/)
  assert.equal(calls, 2)
})

test('PIN-enabled browser login masks and clears the PIN and offers the existing pairing flow', async t => {
  let requestBody: string | undefined
  const session = createBrowserSession('http://fixture', { fetch: async (_url, init) => {
    requestBody = init?.body as string | undefined
    return init?.method === 'POST'
      ? Response.json({ error: 'invalid_pin' }, { status: 401 })
      : Response.json({ version: 1, required: true, authenticated: false, pinAvailable: true })
  } })
  t.after(() => session.dispose())
  await session.refresh()
  const view = mount(t, './BrowserAuth.vue', { session })
  assert.match(view.text(), /Administrator PIN/)
  assert.equal(view.button('Connect browser').parent?.tag, 'form')
  assert.equal(view.button('Check session').parent?.props.class, 'auth-alternatives')
  assert.equal(view.button('Use a one-use pairing code instead').parent, view.button('Check session').parent)
  const input = view.nodes().find(node => node.tag === 'input')!
  assert.equal(input.props.type, 'password')
  ;(input.props['onUpdate:modelValue'] as (value: string) => void)('synthetic-pin')
  await nextTick()
  const form = view.nodes().find(node => node.tag === 'form')!
  await (form.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} })
  await nextTick()
  assert.equal(requestBody, '{"pin":"synthetic-pin"}')
  assert.equal(input.value, '')
  assert.match(view.text(), /PIN is incorrect/)
  assert.doesNotMatch(view.text(), /synthetic-pin/)
  await view.click('Use a one-use pairing code instead')
  assert.equal(input.props.type, 'text')
  assert.match(view.text(), /Generate a short-lived/)
})

test('browser and incomplete desktop bridges never get window controls or a draggable titlebar', async t => {
  for (const bridge of [undefined, { bootstrap: {} }]) {
    await t.test(bridge ? 'bridge without capability' : 'ordinary browser', t => {
      const view = mount(t, './DesktopFrame.vue', {}, bridge)
      assert.equal(view.nodes().filter(node => node.tag === 'button').length, 0)
      assert.ok(view.nodes().every(node => !String(node.props.class ?? '').includes('native-desktop')))
    })
  }
  const { descriptor } = parse(readFileSync(new URL('./DesktopFrame.vue', import.meta.url), 'utf8'))
  const dragRules = [...descriptor.styles[0]!.content.matchAll(/([^{}]+)\{([^{}]*-webkit-app-region:\s*drag\s*;[^{}]*)\}/g)]
  assert.equal(dragRules.length, 1)
  assert.equal(dragRules[0]![1]!.trim(), '.native-desktop .desktop-title-bar')
})

test('desktop capability retains minimize, maximize, restore and close with observer cleanup', async t => {
  let listener: ((state: { maximized: boolean }) => void) | undefined
  let minimized = 0, closed = 0, toggled = 0, unsubscribed = 0
  const view = mount(t, './DesktopFrame.vue', {}, { windowControls: {
    getState: async () => ({ maximized: false }),
    minimize: async () => { minimized++ },
    close: async () => { closed++ },
    toggleMaximize: async () => ({ maximized: ++toggled % 2 === 1 }),
    onStateChanged(callback: typeof listener) { listener = callback; return () => { unsubscribed++ } },
  } })
  assert.ok(view.nodes().some(node => String(node.props.class ?? '').includes('native-desktop')))
  await view.click('Minimize window')
  await view.click('Maximize window')
  assert.ok(view.button('Restore window'))
  listener?.({ maximized: false })
  await nextTick()
  assert.ok(view.button('Maximize window'))
  await view.click('Close window')
  assert.equal(minimized, 1)
  assert.equal(toggled, 1)
  assert.equal(closed, 1)
  t.after(() => assert.equal(unsubscribed, 1))
})
