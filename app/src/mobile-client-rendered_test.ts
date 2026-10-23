import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, ref, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createMobileSession, mobileSessionKey, type MobileSession } from './mobile-client.ts'
import * as mobileResources from './mobile-resources.ts'
import * as mobilePolicy from './io/mobile-policy.ts'
import * as ioBridge from './io/bridge.ts'

interface Element {
  tag: string
  text: string
  props: Record<string, any>
  children: Element[]
  parent?: Element
  addEventListener(): void
  removeEventListener(): void
  getRootNode(): { activeElement: null }
}
const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [], addEventListener() {}, removeEventListener() {}, getRootNode() { return globalThis.document as unknown as { activeElement: null } } })
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
function component(path: string): Component {
  const url = new URL(path, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: path, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('/mobile-resources.ts') ? mobileResources
      : id.endsWith('/mobile-policy.ts') ? mobilePolicy
      : id.endsWith('/io/bridge.ts') ? ioBridge
      : id.endsWith('.vue') ? { default: defineComponent({ render: () => null }) } : require(id), module, module.exports,
  )
  return module.exports.default
}
function mount(t: TestContext, path: string, props: Record<string, unknown>, session?: MobileSession, keepAlive = false) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const oldConstructor = Object.getOwnPropertyDescriptor(globalThis, 'Document')
  class DocumentFixture { activeElement = null }
  Object.defineProperty(globalThis, 'Document', { configurable: true, value: DocumentFixture })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new DocumentFixture() })
  const renderer = createRenderer<Element, Element>({
    createElement: element, createText: value => element('#text', value), createComment: value => element('#comment', value),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText(node, value) { node.text = value },
    setElementText(node, value) { node.text = value; node.children = [] },
    patchProp(node, key, _old, value) { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = element('root')
  const target = component(path)
  const active = ref(true)
  const app = keepAlive
    ? renderer.createApp(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(target, props) : h('span') }) }))
    : renderer.createApp(target, props)
  if (session) app.provide(mobileSessionKey, session)
  app.provide(ioBridge.ioBridgeKey, ioBridge.createIoBridge())
  app.mount(root)
  t.after(() => {
    app.unmount()
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (oldConstructor) Object.defineProperty(globalThis, 'Document', oldConstructor)
    else Reflect.deleteProperty(globalThis, 'Document')
  })
  const nodes = (node = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
  const find = (tag: string, label?: string) => {
    const node = nodes().find(node => node.tag === tag && (!label || text(node).includes(label)))
    assert.ok(node, `Missing ${tag} ${label ?? ''}`)
    return node
  }
  return { find, nodes, text: () => text(root), async setActive(value: boolean) { active.value = value; await nextTick() } }
}
function sessionFixture(t: TestContext, request?: typeof fetch) {
  let stored: string | null = null
  const session = createMobileSession({
    async get() { return { value: stored } }, async set({ value }) { stored = value }, async remove() { stored = null },
  }, request ?? (async () => Response.json({ version: 1, accessToken: 'synthetic-opaque-mobile-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })))
  t.after(() => session.dispose())
  return session
}

test('rendered mobile connection clears pairing code at submission and exposes errors without privileged fallback', async t => {
  const session = sessionFixture(t)
  await session.load()
  const view = mount(t, './MobileConnection.vue', { session })
  assert.match(view.text(), /Sessions and tasks run on your Main computer/)
  const inputs = view.nodes().filter(node => node.tag === 'input')
  inputs[0].props['onUpdate:modelValue']('http://insecure.example')
  inputs[1].props['onUpdate:modelValue']('abcdef-abcdef-abcdef-abcdef')
  await nextTick()
  await view.find('form').props.onSubmit({ preventDefault() {} })
  await flush()
  assert.equal((inputs[1] as Element & { value: string }).value, '')
  assert.equal(session.view.value, 'pairing')
  assert.match(view.text(), /HTTPS origin/)
  assert.doesNotMatch(view.text(), /Set up Main|Set up Child|Administrator PIN/)
  assert.ok(view.nodes().find(node => node.props.role === 'alert'))
})

test('rendered connected UI always offers reconnect and disconnect with remote execution explanation', async t => {
  const session = sessionFixture(t)
  await session.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
  const view = mount(t, './MobileConnection.vue', { session, connected: true })
  assert.match(view.text(), /https:\/\/main.example/)
  assert.match(view.text(), /not this device/)
  assert.ok(view.find('button', 'Retry connection').props.onClick)
  await view.find('button', 'Disconnect').props.onClick()
  assert.equal(session.view.value, 'pairing')
})

test('rendered protected attachment src/href become exact scoped tickets, never bearer queries', async t => {
  const paths: string[] = []
  const session = sessionFixture(t, async (input, init) => {
    if (String(input).endsWith('/resource-ticket')) {
      assert.match(new Headers(init?.headers).get('authorization')!, /^Bearer /)
      const path = JSON.parse(String(init?.body)).path
      paths.push(path)
      return Response.json({ version: 1, url: `https://main.example${path}&ticket=short-lived-resource`, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    return Response.json({ version: 1, accessToken: 'synthetic-opaque-mobile-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  })
  await session.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
  const view = mount(t, './components/MessageAttachments.vue', {
    apiBase: 'https://main.example/projects/p', sessionId: 'web:chat', paths: ['photo.png', 'archive.zip', 'https://cdn.example/public.png'],
  }, session)
  await flush()
  const image = view.nodes().find(node => node.tag === 'img' && node.props.alt === 'photo.png')
  assert.match(image?.props.src, /^https:\/\/main.example\/projects\/p\/api\/media\?.*ticket=short-lived-resource$/)
  const download = view.find('a')
  assert.match(download.props.href, /download=1.*ticket=/)
  assert.equal(view.nodes().find(node => node.tag === 'img' && node.props.alt === 'public.png')?.props.src, 'https://cdn.example/public.png')
  assert.equal(paths.length, 4)
  for (const node of view.nodes()) for (const attr of ['src', 'href']) {
    if (node.props[attr]) assert.doesNotMatch(node.props[attr], /synthetic-opaque-mobile-token|accessToken|Bearer/)
  }
})

test('resource failures show actionable connection feedback and do not expose bare protected URLs', async t => {
  const session = sessionFixture(t, async input => String(input).endsWith('/pair')
    ? Response.json({ version: 1, accessToken: 'synthetic-opaque-mobile-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    : new Response(null, { status: 503 }))
  await session.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
  const view = mount(t, './components/MessageAttachments.vue', {
    apiBase: 'https://main.example', sessionId: 'web:chat', paths: ['photo.png'],
  }, session)
  await flush()
  assert.match(session.resourceError.value, /could not be authorized/)
  assert.equal(view.nodes().filter(node => node.tag === 'img').length, 0)
})

test('cached inactive views pause resource renewal and refresh expired links on reactivation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let tickets = 0
  const session = sessionFixture(t, async (input, init) => {
    if (String(input).endsWith('/resource-ticket')) {
      const path = JSON.parse(String(init?.body)).path
      return Response.json({ version: 1, url: `https://main.example${path}&ticket=ticket-${++tickets}`, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }
    return Response.json({ version: 1, accessToken: 'synthetic-opaque-mobile-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  })
  await session.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
  const view = mount(t, './components/MessageAttachments.vue', {
    apiBase: 'https://main.example', sessionId: 'web:chat', paths: ['photo.png'],
  }, session, true)
  await flush()
  assert.equal(tickets, 2)
  await view.setActive(false)
  t.mock.timers.tick(65_000)
  await flush()
  assert.equal(tickets, 2)
  await view.setActive(true)
  await flush()
  assert.equal(tickets, 4)
})

test('native capture requests show unsupported state without microphone controls or a start action', async t => {
  t.after(mobilePolicy.installMobileCaptureRestriction())
  const view = mount(t, './components/io/IoRequestCard.vue', {
    base: 'https://main.example',
    run: {
      id: 'native-camera', status: 'awaiting_consent', backendStatus: 'ready', artifacts: [], revision: 'revision',
      definition: {
        title: 'Record input', purpose: 'Synthetic capture request', endpoint: 'ws://127.0.0.1:8765/io',
        sources: [{ id: 'microphone', kind: 'microphone', mode: 'recording' }],
        limits: { durationMs: 60_000, maxBytes: 1024 * 1024 }, ui: [],
      },
    },
  })
  await flush()
  assert.match(view.text(), /Camera, microphone, and screen capture are not supported by this mobile client/)
  assert.equal(view.find('button', 'Unavailable on mobile').props.disabled, true)
  assert.equal(view.nodes().some(node => node.tag === 'select'), false)
  assert.ok(view.find('button', 'Not now'))
})
