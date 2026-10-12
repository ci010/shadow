import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'


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
    (id: string) => id.endsWith('/UiSelect.vue') ? { default: defineComponent({
      props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
      setup(props, { emit, slots }) {
        return () => h('select', { value: props.modelValue, disabled: props.disabled,
          onChange: (value: string) => emit('update:modelValue', value) }, slots.default?.())
      },
    }) } : id.endsWith('.vue') ? { default: loadComponent(new URL(id, url)) }
      : id.endsWith('.png') ? { default: 'fixture-logo.png' } : require(id), module, module.exports,
  )
  return module.exports.default
}

function mount(t: TestContext, props: Record<string, unknown> = {}, shadowDesktop?: unknown, open: (...args: unknown[]) => void = () => {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousDocumentType = Object.getOwnPropertyDescriptor(globalThis, 'Document')
  const previousShadowRoot = Object.getOwnPropertyDescriptor(globalThis, 'ShadowRoot')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { shadowDesktop, open, addEventListener() {}, removeEventListener() {} } })
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
  // Render the production ProviderSetup template; only the generic select widget is stubbed.
  const app = renderer.createApp(loadComponent(new URL('./ProviderSetup.vue', import.meta.url)), props)
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

const status = { provider: 'copilot', authMode: 'copilot', ready: true, hasApiKey: false, model: 'model' }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

for (const host of ['github.com', 'octocat.ghe.com']) {
  for (const desktop of [false, true]) {
    test(`${host} device flow renders selected host, locks inputs and opens the returned ${desktop ? 'desktop' : 'web'} link`, async t => {
      const posts: Record<string, unknown>[] = []
      const opened: unknown[][] = []
      let complete!: (response: Response) => void
      t.mock.method(globalThis, 'fetch', async (_input, init) => {
        if (init?.method === 'DELETE') return Response.json({ state: 'cancelled' })
        posts.push(JSON.parse(String(init?.body)))
        return await new Promise<Response>(resolve => { complete = resolve })
      })
      const view = mount(t, { apiBase: 'http://fixture.invalid', status: { ...status, host }, mode: 'edit' },
        desktop ? { copilotLoginHostSupport: true, openCopilotLogin: async (uri: string) => { opened.push([uri]) } } : undefined,
        (...args) => { opened.push(args) })
      assert.match(view.text(), new RegExp(`Current Copilot host: ${host.replaceAll('.', '\\.')}`))
      const select = () => view.nodes().find(node => node.tag === 'select')!
      assert.equal(select().props.value, host === 'github.com' ? 'github' : 'enterprise')
      if (host !== 'github.com') assert.equal(view.nodes().find(node => node.tag === 'input')?.value, host)
      const starting = view.click('Sign in with GitHub Copilot')
      await nextTick()
      assert.equal(select().props.disabled, true, 'host is locked while POST is outstanding')
      complete(Response.json({ loginId: posts[0]!.attemptId, state: 'pending', host,
        userCode: 'ABCD-EFGH', verificationUri: `https://${host}/login/device`, expiresAt: 4_000_000_000_000, intervalMs: 5000 }))
      await starting
      assert.equal(posts[0]?.host, host)
      assert.equal(select().props.disabled, true)
      if (host !== 'github.com') assert.equal(view.nodes().find(node => node.tag === 'input')?.props.disabled, true)
      await view.click(`Open ${host}/login/device`)
      assert.deepEqual(opened, desktop ? [[`https://${host}/login/device`]] : [[`https://${host}/login/device`, '_blank', 'noopener,noreferrer']])
      await view.click('Cancel login')
      assert.equal(select().props.disabled, false)
      const retry = view.click('Retry GitHub Copilot login')
      await nextTick()
      assert.equal(posts[1]?.host, host)
      complete(Response.json({ loginId: posts[1]!.attemptId, state: 'denied', host, errorCode: 'denied' }))
      await retry
      assert.equal(select().props.value, host === 'github.com' ? 'github' : 'enterprise')
      assert.match(view.text(), /authorization was denied/)
    })
  }
}

test('enterprise picker blocks invalid input, preserves it on retry, and sign-out identifies active rather than selected host', async t => {
  const posts: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).endsWith('/logout')) return Response.json({ authenticated: false })
    posts.push(JSON.parse(String(init?.body)))
    return Response.json({ loginId: posts.at(-1)!.attemptId, state: 'expired', host: posts.at(-1)!.host, errorCode: 'expired' })
  })
  const view = mount(t, { apiBase: 'http://fixture.invalid', status: { ...status, host: 'github.com' }, mode: 'edit' })
  const select = view.nodes().find(node => node.tag === 'select')!
  ;(select.props.onChange as (value: string) => void)('enterprise')
  await nextTick()
  const input = view.nodes().find(node => node.tag === 'input')!
  const setHost = async (value: string) => {
    ;(input.props['onUpdate:modelValue'] as (value: string) => void)(value)
    await nextTick()
  }
  for (const invalid of ['', 'github.com', 'https://octocat.ghe.com', 'octocat.ghe.com/path', 'ghe.com', 'nested.octocat.ghe.com']) {
    await setHost(invalid)
    assert.equal(view.button('Sign in with GitHub Copilot').props.disabled, true)
    assert.equal(input.props['aria-invalid'], true)
  }
  assert.equal(posts.length, 0)
  await setHost('Octocat.GHE.com')
  await view.click('Sign in with GitHub Copilot')
  assert.equal(posts[0]?.host, 'octocat.ghe.com')
  assert.equal(input.value, 'Octocat.GHE.com')
  await view.click('Retry GitHub Copilot login')
  assert.equal(posts[1]?.host, 'octocat.ghe.com')
  await view.click('Sign out of GitHub Copilot')
  assert.match(view.text(), /Remove the saved Copilot sign-in for github.com/)
  assert.match(view.text(), /Sign-ins on other hosts are unchanged/)
  await view.click('Sign out of GitHub Copilot')
  await flush()
  assert.match(view.text(), /Signed out of GitHub Copilot on github.com/)
})

test('provider edit mapping retains host when Copilot is not the selected provider', () => {
  const source = readFileSync(new URL('./components/ProvidersView.vue', import.meta.url), 'utf8')
  assert.match(source, /baseUrl: item\.baseUrl, host: item\.host, ready: false/)
})


for (const host of ['github.com', 'msft.ghe.com']) {
  test(`older Desktop cannot misdirect ${host} authentication by ignoring the URI`, async t => {
    let opens = 0
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
      if (init?.method === 'DELETE') return Response.json({ state: 'cancelled' })
      const request = JSON.parse(String(init?.body))
      return Response.json({ loginId: request.attemptId, state: 'pending', host,
        userCode: 'ABCD-EFGH', verificationUri: `https://${host}/login/device`, expiresAt: 4_000_000_000_000, intervalMs: 5000 })
    })
    // The old bridge accepts no URI and always opens github.com.
    const view = mount(t, { apiBase: 'http://fixture.invalid', status: { ...status, host }, mode: 'edit' },
      { openCopilotLogin: async () => { opens++ } })
    await view.click('Sign in with GitHub Copilot')
    await view.click(`Open ${host}/login/device`)
    if (host === 'github.com') assert.equal(opens, 1)
    else {
      assert.equal(opens, 0)
      assert.match(view.text(), /Could not open the browser. Open https:\/\/msft\.ghe\.com\/login\/device manually/)
    }
  })
}
