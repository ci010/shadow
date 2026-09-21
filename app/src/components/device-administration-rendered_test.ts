import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createInstallationContextProvider, useInstallationContext } from '../composables/useInstallationContext.ts'
import { createLocalMainAdminContext, type InstallationContextV1 } from '../installation-context.ts'
import type { NodeInventoryEntry } from '../node-inventory.ts'
import type { DeviceNetwork, PendingDevice } from './device-administration.ts'

interface Element {
  tag: string
  tagName: string
  text: string
  props: Record<string, unknown>
  children: Element[]
  parent?: Element
  checked: boolean
  options: Element[]
  addEventListener: (name: string, handler: Function) => void
  removeEventListener: () => void
}
const element = (tag: string, text = ''): Element => ({
  tag, tagName: tag.toUpperCase(), text, props: {}, children: [], checked: false,
  get options() { return this.children.filter(child => child.tag === 'option') },
  addEventListener() {}, removeEventListener() {},
})
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')
const compiled = new Map<string, Component>()
function loadComponent(url: URL): Component {
  const cached = compiled.get(url.href)
  if (cached) return cached
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: url.pathname, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? { default: loadComponent(new URL(id, url)) }
      : id.endsWith('/useInstallationContext.ts') ? { useInstallationContext } : require(id),
    module, module.exports,
  )
  compiled.set(url.href, module.exports.default)
  return module.exports.default
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

function mount(t: TestContext, name = 'DeviceAdministration', context?: InstallationContextV1) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener() {}, removeEventListener() {} } })
  const renderer = createRenderer<Element, Element>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = element('root')
  const props = reactive({ apiBase: 'http://127.0.0.1:3123/projects/example/', nodes: [] as NodeInventoryEntry[] })
  const app = renderer.createApp(defineComponent({ setup: () => () => h(loadComponent(new URL(`./${name}.vue`, import.meta.url)), props) }))
  if (context) app.use(createInstallationContextProvider(context))
  app.mount(root)
  let unmounted = false
  const unmount = () => {
    if (unmounted) return
    app.unmount()
    unmounted = true
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
  t.after(unmount)
  const nodes = (node: Element = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
  const find = (tag: string, label: string): Element => {
    const result = nodes().find(node => node.tag === tag && text(node).includes(label))
    assert.ok(result, `Missing ${tag}: ${label}`)
    return result
  }
  const button = (label: string) => find('button', label)
  const click = async (label: string) => {
    const target = button(label)
    assert.notEqual(target.props.disabled, true, `Disabled: ${label}`)
    assert.ok(typeof target.props.onClick === 'function')
    await target.props.onClick()
    await flush()
  }
  const check = async (label: string, value = true) => {
    const input = find('label', label).children.find(node => node.tag === 'input')!
    assert.ok(input)
    assert.notEqual(input.props.disabled, true)
    const update = input.props['onUpdate:modelValue']
    assert.ok(typeof update === 'function')
    update(value)
    await nextTick()
  }
  const submit = async () => {
    const form = nodes().find(node => node.tag === 'form')!
    assert.ok(typeof form.props.onSubmit === 'function')
    await form.props.onSubmit({ preventDefault() {} })
    await flush()
  }
  return { props, nodes, button, click, check, submit, unmount, text: () => text(root) }
}

const disabledNetwork: DeviceNetwork = {
  version: 1, enabled: false, host: '127.0.0.1', port: 3124, allowInsecureLocalTransport: false,
  state: 'disabled', endpoint: null, error: null,
  addresses: [{ name: 'loopback', address: '127.0.0.1' }, { name: 'LAN', address: '192.168.1.12' }],
}
const listeningNetwork: DeviceNetwork = {
  ...disabledNetwork, enabled: true, host: '192.168.1.12', allowInsecureLocalTransport: true,
  state: 'listening', endpoint: 'http://192.168.1.12:3124',
}
const pending: PendingDevice = {
  version: 1, pendingId: 'pending-1', deviceId: 'device-1', nodeId: 'node-1', credentialId: 'credential-1',
  displayName: 'Workshop Child', deviceIdentityFingerprint: 'a'.repeat(64), requestedAt: '2026-09-20T12:00:00Z',
}
function backend(t: TestContext, network = disabledNetwork, devices: PendingDevice[] = []) {
  const calls: Array<{ path: string; method: string; body?: any; signal?: AbortSignal | null }> = []
  const state = { network: structuredClone(network), pending: structuredClone(devices), offerExpiry: Date.now() + 300_000, fail: false, failListener: false, denied: false }
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body, signal: init?.signal })
    if (state.denied && path !== '/nodes/v1' && path !== '/local/v1/nodes') return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (state.fail) return Response.json({ error: 'synthetic' }, { status: 503 })
    if (path === '/nodes/v1/network') {
      if (method === 'PUT') state.network = { ...state.network, ...body, state: body.enabled ? 'listening' : 'disabled', endpoint: body.enabled ? `http://${body.host}:${body.port}` : null, error: null }
      if (method === 'PUT' && body.enabled && state.failListener) {
        state.network = { ...state.network, state: 'error', endpoint: null, error: 'The device port is already in use. Choose a different port.' }
        return Response.json({ error: 'device_listener_failed', message: state.network.error, network: state.network }, { status: 503 })
      }
      return Response.json(state.network)
    }
    if (path === '/nodes/v1/pending') return Response.json({ version: 1, pending: state.pending })
    if (path === '/pair/v1/offers') return Response.json({ version: 1, offerId: 'offer-1', pin: '000012', expiresAt: new Date(state.offerExpiry).toISOString() })
    if (path === '/nodes/v1/pending/pending-1/approve') {
      state.pending = []
      return Response.json({ version: 1, deviceId: pending.deviceId, nodeId: pending.nodeId, credentialId: pending.credentialId })
    }
    if (path === '/local/v1/nodes' || path === '/nodes/v1') return Response.json({ version: 1, nodes: [] })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { calls, state }
}

test('rendered Main requires explicit HTTP acknowledgement, creates an invitation, and stops the listener', async t => {
  const { calls } = backend(t)
  const view = mount(t)
  await flush()
  assert.match(view.text(), /gateway stays on loopback/)
  assert.equal(view.button('Enable device connection').props.disabled, true)
  assert.equal(view.nodes().filter(node => node.tag === 'input' && node.props.type === 'checkbox')[0]?.checked, false)
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0)
  await view.check('I understand this HTTP')
  assert.equal(view.button('Enable device connection').props.disabled, false)
  await view.submit()
  assert.deepEqual(calls.find(call => call.method === 'PUT')?.body, {
    version: 1, enabled: true, host: '192.168.1.12', port: 3124, allowInsecureLocalTransport: true,
  })
  await view.click('Create invitation')
  assert.match(view.text(), /http:\/\/192\.168\.1\.12:3124/)
  assert.match(view.text(), /offer-1/)
  assert.match(view.text(), /000012/)
  assert.match(view.text(), /Single use/)
  await view.click('Turn off listener')
  assert.match(view.text(), /Device listener is off/)
  assert.doesNotMatch(view.text(), /000012/)
  assert.equal(view.button('Enable device connection').props.disabled, true)
  assert.equal(calls.filter(call => call.method === 'PUT')[1]?.body.enabled, false)
})

test('rendered approval requires identity verification and execution consent; only live registry status is connected', async t => {
  const { calls } = backend(t, listeningNetwork, [pending])
  const view = mount(t)
  await flush()
  assert.match(view.text(), new RegExp(pending.deviceIdentityFingerprint))
  assert.match(view.text(), /Commands run with the Child’s OS-account permissions; a workdir is not a sandbox/)
  assert.equal(view.button('Approve device').props.disabled, true)
  await view.check('I checked the fingerprint')
  assert.equal(view.button('Approve device').props.disabled, true)
  await view.check('I trust this device')
  await view.click('Approve device')
  assert.deepEqual(calls.find(call => call.path.endsWith('/approve'))?.body, { version: 1, expectedDeviceIdentityFingerprint: pending.deviceIdentityFingerprint })
  assert.match(view.text(), /approved, but not connected/)
  assert.doesNotMatch(view.text(), /Workshop Child is connected/)
  view.props.nodes = [{ nodeId: pending.nodeId, displayName: pending.displayName, role: 'child', connection: 'connected', capabilities: [] }]
  await nextTick()
  assert.match(view.text(), /Workshop Child is connected/)
  view.props.nodes[0]!.connection = 'offline'
  await nextTick()
  assert.match(view.text(), /approved, but not connected/)
  view.props.nodes[0]!.connection = 'revoked'
  await nextTick()
  assert.match(view.text(), /has been revoked/)
})

test('rendered listener failure retains editable settings and offers disabling the saved listener', async t => {
  const { state } = backend(t)
  state.failListener = true
  const view = mount(t)
  await flush()
  assert.equal(view.nodes().find(node => node.props.id === 'device-port')?.props.min, '1024')
  await view.check('I understand this HTTP')
  await view.submit()
  assert.match(view.text(), /listener could not start/)
  assert.match(view.text(), /port is already in use/)
  assert.equal(view.button('Turn off listener').props.disabled, false)
  assert.equal(view.button('Enable device connection').props.disabled, true)
  assert.doesNotMatch(view.text(), /Create invitation/)
  await view.click('Turn off listener')
  assert.match(view.text(), /Device listener is off/)
})

test('rendered pending identity changes reset consent and failed refresh prevents approving stale data', async t => {
  const { state } = backend(t, listeningNetwork, [pending])
  const view = mount(t)
  await flush()
  await view.check('I checked the fingerprint')
  await view.check('I trust this device')
  state.pending = [{ ...pending, deviceIdentityFingerprint: 'b'.repeat(64) }]
  await view.click('Refresh pairing')
  assert.equal(view.button('Approve device').props.disabled, true)
  state.fail = true
  await view.click('Refresh pairing')
  assert.match(view.text(), /failed \(503\)/)
  assert.equal(view.button('Approve device').props.disabled, true)
})

test('rendered expired invitation hides its PIN and disables copying while allowing retry', async t => {
  const { state } = backend(t, listeningNetwork)
  state.offerExpiry = Date.now() - 1
  const view = mount(t)
  await flush()
  await view.click('Create invitation')
  assert.match(view.text(), /invitation expired/)
  assert.doesNotMatch(view.text(), /000012/)
  assert.equal(view.button('Copy PIN').props.disabled, true)
  assert.equal(view.button('Copy pairing invitation').props.disabled, true)
  assert.equal(view.nodes().find(node => node.props.id === 'device-invitation-text')?.props.value, '')
  assert.equal(view.button('Create another invitation').props.disabled, false)
})

test('rendered Child and unprivileged Main retain read-only inventory without admin requests', async t => {
  for (const context of [
    { ...createLocalMainAdminContext('http://127.0.0.1:3123'), mode: 'child' as const },
    { ...createLocalMainAdminContext('http://127.0.0.1:3123'), uiScopes: [] },
  ]) {
    const { calls } = backend(t)
    const view = mount(t, 'NodesView', context)
    await flush()
    assert.match(view.text(), /Read only/)
    assert.doesNotMatch(view.text(), /Pair a Child|Create invitation|Enable device connection/)
    assert.deepEqual(calls.map(call => call.path), [context.mode === 'child' ? '/local/v1/nodes' : '/nodes/v1'])
    view.unmount()
  }
})

test('browser-mode Main scopes do not grant administration without the desktop launch credential', async t => {
  const { state, calls } = backend(t, listeningNetwork, [pending])
  state.denied = true
  const view = mount(t, 'NodesView', createLocalMainAdminContext('http://127.0.0.1:3123'))
  await flush()
  assert.match(view.text(), /Device pairing needs desktop access/)
  assert.match(view.text(), /Browser sign-in does not grant device administration access/)
  assert.match(view.text(), /Open Nodes there/)
  assert.doesNotMatch(view.text(), /Create invitation|Enable device connection|Approve device|Turn off listener/)
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0)
  assert.equal(view.button('Retry desktop access').props.disabled, false)
  state.denied = false
  await view.click('Retry desktop access')
  assert.match(view.text(), /Pair a Child device/)
  assert.equal(view.button('Create invitation').props.disabled, false)
})

test('losing desktop authorization clears invitation secrets and pending approval controls', async t => {
  const { state } = backend(t, listeningNetwork, [pending])
  const view = mount(t)
  await flush()
  await view.click('Create invitation')
  assert.match(view.text(), /000012/)
  state.denied = true
  await view.click('Refresh pairing')
  assert.match(view.text(), /Device pairing needs desktop access/)
  assert.doesNotMatch(view.text(), /000012|Approve device|Copy PIN|Create invitation/)
})

test('rendered unmount aborts in-flight administration reads', async t => {
  const signals: AbortSignal[] = []
  t.mock.method(globalThis, 'fetch', async (_input: string | URL, init?: RequestInit) => {
    signals.push(init!.signal!)
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
  })
  const view = mount(t)
  assert.equal(signals.length, 2)
  view.unmount()
  assert.equal(signals.every(signal => signal.aborted), true)
  await flush()
})

test('canceling an invitation waits for a fresh read and ignores a late mutation response', async t => {
  let completeOffer: ((response: Response) => void) | undefined
  let offerSignal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/nodes/v1/network') return Response.json(listeningNetwork)
    if (path === '/nodes/v1/pending') return Response.json({ version: 1, pending: [] })
    assert.equal(path, '/pair/v1/offers')
    offerSignal = init!.signal!
    return await new Promise<Response>(resolve => { completeOffer = resolve })
  })
  const view = mount(t)
  await flush()
  const pendingClick = view.click('Create invitation')
  await flush()
  assert.match(view.text(), /Request in progress/)
  await view.click('Cancel waiting')
  assert.equal(offerSignal?.aborted, true)
  assert.match(view.text(), /Main may still have applied the request/)
  completeOffer!(Response.json({ version: 1, offerId: 'late', pin: '000012', expiresAt: new Date(Date.now() + 300_000).toISOString() }))
  await pendingClick
  assert.doesNotMatch(view.text(), /000012/)
  assert.equal(view.button('Create invitation').props.disabled, false)
})
