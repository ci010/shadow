import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
const { provideModelSelection } = createRequire(import.meta.url)('./model-selection.ts') as typeof import('./model-selection.ts')


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
    (id: string) => id.endsWith('/ComposerPopover.vue') ? { default: defineComponent({
      setup(_props, { slots }) { return () => h('div', [slots.trigger?.(), slots.default?.({ close() {} })]) },
    }) } : id.endsWith('/UiSelect.vue') ? { default: defineComponent({
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

function mount(t: TestContext, props: Record<string, unknown> = {}, shadowDesktop?: unknown, open: (...args: unknown[]) => void = () => {}, component?: Component) {
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
  const app = renderer.createApp(component ?? loadComponent(new URL('./ProviderSetup.vue', import.meta.url)), props)
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
      if (host !== 'github.com') assert.equal(view.nodes().find(node => node.tag === 'input' && node.props.placeholder === 'octocat')?.value, host.replace('.ghe.com', ''))
      const starting = view.click('Sign in with GitHub Copilot')
      await nextTick()
      assert.equal(select().props.disabled, true, 'host is locked while POST is outstanding')
      complete(Response.json({ loginId: posts[0]!.attemptId, state: 'pending', host,
        userCode: 'ABCD-EFGH', verificationUri: `https://${host}/login/device`, expiresAt: 4_000_000_000_000, intervalMs: 5000 }))
      await starting
      assert.equal(posts[0]?.host, host)
      assert.equal(select().props.disabled, true)
      if (host !== 'github.com') assert.equal(view.nodes().find(node => node.tag === 'input' && node.props.placeholder === 'octocat')?.props.disabled, true)
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
    if (new URL(String(input)).pathname.endsWith('/logout')) return Response.json({ authenticated: false })
    posts.push(JSON.parse(String(init?.body)))
    return Response.json({ loginId: posts.at(-1)!.attemptId, state: 'expired', host: posts.at(-1)!.host, errorCode: 'expired' })
  })
  const view = mount(t, { apiBase: 'http://fixture.invalid', status: { ...status, host: 'github.com' }, mode: 'edit' })
  const select = view.nodes().find(node => node.tag === 'select')!
  ;(select.props.onChange as (value: string) => void)('enterprise')
  await nextTick()
  const input = view.nodes().find(node => node.tag === 'input' && node.props.placeholder === 'octocat')!
  const setHost = async (value: string) => {
    ;(input.props['onUpdate:modelValue'] as (value: string) => void)(value)
    await nextTick()
  }
  for (const invalid of ['', 'github.com', 'https://octocat.ghe.com', 'octocat.ghe.com/path', 'ghe.com', 'nested.octocat.ghe.com', 'octocat.ghe.com', '-octocat', 'octocat-', 'xn--test', 'octo_cat']) {
    await setHost(invalid)
    assert.equal(view.button('Sign in with GitHub Copilot').props.disabled, true)
    assert.equal(input.props['aria-invalid'], true)
  }
  assert.equal(posts.length, 0)
  await setHost('Octocat')
  await view.click('Sign in with GitHub Copilot')
  assert.equal(posts[0]?.host, 'octocat.ghe.com')
  assert.equal(input.value, 'Octocat')
  await view.click('Retry GitHub Copilot login')
  assert.equal(posts[1]?.host, 'octocat.ghe.com')
  await view.click('Sign out of GitHub Copilot')
  assert.match(view.text(), /Remove provider .* and its saved Copilot sign-in on github.com/)
  assert.match(view.text(), /Other instances, including accounts on the same host/)
  await view.click('Sign out of GitHub Copilot')
  await flush()
  assert.match(view.text(), /Signed out of Copilot instance .* on github.com/)
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


for (const provider of ['agnes', 'deepseek', 'openai', 'anthropic', 'openrouter', 'gemini', 'groq']) {
  test(`${provider} built-in connection hides URL and leaves endpoint selection to Main`, async t => {
    let body: Record<string, unknown> | undefined
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ provider, authMode: 'api-key', ready: true, hasApiKey: true, model: 'fixture-model' })
    })
    const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: {
      provider, authMode: 'api-key', ready: true, hasApiKey: true, model: 'fixture-model',
      baseUrl: 'https://existing-gateway.invalid/v1',
    } })
    assert.ok(!view.nodes().some(node => node.tag === 'input' && node.props.type === 'url'))
    const form = view.nodes().find(node => node.tag === 'form')!
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
    assert.equal(body?.provider, provider)
    assert.ok(body && !('baseUrl' in body), 'omitting the endpoint preserves an existing override and uses defaults for new connections')
  })
}

test('custom connection still exposes and submits its required endpoint', async t => {
  let body: Record<string, unknown> | undefined
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ provider: 'local', authMode: 'none', ready: true, hasApiKey: false, model: 'local-model' })
  })
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: {
    provider: 'local', authMode: 'none', ready: true, hasApiKey: false, model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1',
  } })
  const input = view.nodes().find(node => node.tag === 'input' && node.props.type === 'url')!
  assert.ok(input)
  assert.equal(input.props.required, true)
  const form = view.nodes().find(node => node.tag === 'form')!
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
  assert.equal(body?.baseUrl, 'http://127.0.0.1:11434/v1')
})


test('Agnes permission denial is distinct from invalid credentials in the save failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ provider: 'agnes', authMode: 'api-key', ready: false, hasApiKey: true, model: 'agnes-3.0-flash', reason: 'permission_denied' }))
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: {
    provider: 'agnes', authMode: 'api-key', ready: true, hasApiKey: true, model: 'agnes-3.0-flash',
  } })
  const form = view.nodes().find(node => node.tag === 'form')!
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
  await nextTick()
  assert.match(view.text(), /provider denied access/i)
  assert.doesNotMatch(view.text(), /Credentials were rejected/)
})


test('named DeepSeek edit keeps stable identity, type and key while renaming', async t => {
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ provider: 'work', type: 'deepseek', authMode: 'api-key', ready: true, hasApiKey: true, model: 'deepseek-flash@work' })
  })
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: {
    provider: 'work', type: 'deepseek', name: 'Work account', authMode: 'api-key', ready: true, hasApiKey: true, model: 'deepseek-flash@work',
  } })
  const name = view.nodes().find(node => node.tag === 'input' && node.props.maxlength === '100')!
  ;(name.props['onUpdate:modelValue'] as (value: string) => void)('Renamed')
  await nextTick()
  await view.click('Rename')
  assert.deepEqual(bodies[0], { provider: 'work', type: 'deepseek', name: 'Renamed' })
  const form = view.nodes().find(node => node.tag === 'form')!
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
  assert.equal(bodies[1].provider, 'work')
  assert.equal(bodies[1].type, 'deepseek')
  assert.equal(bodies[1].apiKey, undefined)
  assert.equal(bodies[1].model, 'deepseek-flash@work')
})


test('adding the same provider type twice generates distinct stable instance IDs', async t => {
  const ids: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const input = JSON.parse(String(init?.body))
    assert.equal(input.type, 'deepseek')
    ids.push(input.provider)
    return Response.json({ provider: input.provider, type: input.type, authMode: 'api-key', ready: true, hasApiKey: true, model: 'deepseek-flash' })
  })
  for (let i = 0; i < 2; i++) await t.test(`connection ${i}`, async child => {
    const view = mount(child, { apiBase: 'http://fixture.invalid', mode: 'add', status: null, excludedProviders: ['deepseek'] })
    const select = view.nodes().find(node => node.tag === 'select')!
    const handlers = Array.isArray(select.props.onChange) ? select.props.onChange : [select.props.onChange]
    for (const handler of handlers) (handler as (value: string) => void)('deepseek')
    await nextTick()
    const form = view.nodes().find(node => node.tag === 'form')!
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
  })
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  assert.match(ids[0], /^account-/)
})


test('rendered model menu distinguishes same-type accounts and renames without changing selection', async t => {
  const current = ref('same@account-a')
  const providers = ref([{ id: 'account-a', type: 'deepseek', name: 'Personal' }, { id: 'account-b', type: 'deepseek', name: 'Work' }])
  const selector = loadComponent(new URL('./components/ModelSelector.vue', import.meta.url))
  const wrapper = defineComponent({ setup() {
    provideModelSelection({ current, providers, options: ref(['same@account-a', 'same@account-b']),
      disabled: ref(false), loading: ref(false), error: ref(''), async select(value) { current.value = value } })
    return () => h(selector)
  } })
  const view = mount(t, {}, undefined, undefined, wrapper)
  assert.match(view.text(), /Personal · DeepSeek/)
  assert.match(view.text(), /Work · DeepSeek/)
  const search = view.nodes().find(node => node.tag === 'input' && node.props.type === 'search')!
  ;(search.props['onUpdate:modelValue'] as (value: string) => void)('work')
  await nextTick()
  const options = () => view.nodes().filter(node => node.tag === 'button' && String(node.props.class).includes('model-option'))
  assert.equal(options().length, 1)
  await (options()[0].props.onClick as () => Promise<void>)()
  await nextTick()
  assert.equal(current.value, 'same@account-b')
  providers.value[1].name = 'Office'
  ;(search.props['onUpdate:modelValue'] as (value: string) => void)('office')
  await nextTick()
  assert.equal(current.value, 'same@account-b')
  assert.equal(options().length, 1)
  assert.match(view.text(), /Office · DeepSeek/)
  assert.match(view.text(), /account-b/)
})

test('named Copilot title and sign-out identify the instance and preserve same-host accounts', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ authenticated: false }))
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: {
    ...status, provider: 'account-work', type: 'copilot', name: 'Work GitHub', host: 'github.com',
  } })
  assert.match(view.text(), /Work GitHub · GitHub Copilot settings/)
  await view.click('Sign out of GitHub Copilot')
  assert.match(view.text(), /Remove provider .* \(account-work\) and its saved Copilot sign-in on github.com/)
  assert.match(view.text(), /Other instances, including accounts on the same host/)
  await view.click('Sign out of GitHub Copilot')
  assert.match(view.text(), /Signed out of Copilot instance Work GitHub/)
})


test('new Copilot connection registers explicit v2 before login and keeps its stable ID', async t => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body))
    posts.push({ url: String(url), body })
    if (String(url).includes('/api/provider/instances')) return Response.json({ ok: true })
    return Response.json({ loginId: body.attemptId, host: 'github.com', state: 'succeeded' })
  })
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'add', status: null })
  await view.click('GitHub Copilot')
  assert.match(view.text(), /v2/)
  assert.match(view.text(), /only the copilot scope/)
  assert.match(view.text(), /official app rather than Shadow/)
  await view.click('Sign in with GitHub Copilot')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].body.type, 'copilot-v2')
  assert.match(String(posts[0].body.provider), /^account-.*-copilot$/)
  assert.equal(new URL(posts[1].url).searchParams.get('provider'), posts[0].body.provider)
  assert.equal(posts[1].body.reauthenticate, true)
})

test('explicit rollback form shows v1 without changing the connection ID', t => {
  const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'edit', status: { ...status, type: 'copilot-v1' } })
  assert.match(view.text(), /v1/)
  assert.doesNotMatch(view.text(), /v2/)
  assert.doesNotMatch(view.text(), /only the copilot scope/)
})


for (const type of ['copilot', 'copilot-v1', 'copilot-v2']) {
  test(`setup retry preserves immutable existing ${type} when registering a display name`, async t => {
    const bodies: Record<string, unknown>[] = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return Response.json(String(url).includes('/api/provider/instances') ? { ok: true }
        : { loginId: body.attemptId, host: 'github.com', state: 'succeeded' })
    })
    const view = mount(t, { apiBase: 'http://fixture.invalid', mode: 'setup', status: { ...status, type, name: 'Existing' } })
    await view.click('Sign in with GitHub Copilot')
    assert.equal(bodies[0].type, type)
    assert.equal(bodies[0].provider, 'copilot')
  })
}
