import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, nextTick, watch, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createIoBridge } from './io/bridge.ts'
import { IoExecution } from './io/execution.ts'
import { parseIoDefinition } from '../../src/io/contracts.ts'

const base = 'http://fixture/projects/default/'
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
interface RenderNode { children: RenderNode[]; parent?: RenderNode }
const node = (): RenderNode => ({ children: [] })

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const document = Object.assign(new EventTarget(), { hidden: false })
  const restore: Array<() => void> = []
  for (const [key, value] of [['document', document], ['window', new EventTarget()]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restore.push(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) })
  }
  const calls: { path: string; init: RequestInit }[] = []
  let register = async () => Response.json({ clientToken: 'synthetic-client' })
  let heartbeat = async () => Response.json({ ok: true })
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const path = new URL(input).pathname
    calls.push({ path, init })
    if (path.endsWith('/clients')) return register()
    if (path.endsWith('/heartbeat')) return heartbeat()
    if (path.endsWith('/stop')) return Response.json({ run: { status: 'failed' } })
    assert.equal(path.endsWith('/runs'), true, `Unexpected capture request: ${path}`)
    return Response.json({ runs: [] })
  })
  const url = new URL('./components/io/IoHost.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'io-host', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id.endsWith('.vue')) return { default: defineComponent({ setup: () => () => null }) }
    if (id.endsWith('/io/adapters.ts')) return { browserIoCapabilities: () => [] }
    return require(id)
  }, module, module.exports)
  const bridge = createIoBridge()
  bridge.views.value = new Map([['chat', { apiBase: base, sessionId: 'web:test', remote: false }]])
  const errors: string[] = []
  const stop = watch(bridge.errors, values => { errors.push(...values.values()) }, { flush: 'sync' })
  const renderer = createRenderer<RenderNode, RenderNode>({
    createElement: node, createText: node, createComment: node,
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child)
      else parent.children.splice(index, 0, child)
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      delete child.parent
    },
    setText() {}, setElementText() {}, patchProp() {},
    parentNode: child => child.parent ?? null,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  })
  const app = renderer.createApp(module.exports.default, { bridge })
  app.provide(Symbol.for('shadow.live-client-pool'), {
    client: () => ({ subscribe: () => ({ close() {}, ready: async () => {} }) }),
  })
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  app.mount(node())
  t.after(() => {
    try { unmount(); stop() }
    finally { for (const reset of restore) reset() }
  })
  return {
    bridge, calls, errors, document, unmount,
    heartbeat: (next: typeof heartbeat) => { heartbeat = next },
    register: (next: typeof register) => { register = next },
    registrations: () => calls.filter(call => call.path.endsWith('/clients')),
  }
}

const expired = () => Promise.resolve(Response.json({
  error: 'client_expired', message: 'The I/O client expired; reconnect explicitly',
}, { status: 403 }))

test('idle client expiry renews registration without flashing an error or starting capture', async t => {
  const f = fixture(t)
  await settle()
  assert.equal(f.registrations().length, 1)
  f.heartbeat(expired)
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.registrations().length, 2)
  assert.notEqual(JSON.parse(String(f.registrations()[0]!.init.body)).id, JSON.parse(String(f.registrations()[1]!.init.body)).id)
  assert.deepEqual(f.errors, [])
  assert.equal(f.bridge.execution.value, undefined)
  assert.ok(f.calls.every(call => !/prepare|start|events/.test(call.path)))
})

test('authorization failures and failed re-registration remain visible rather than being mistaken for expiry', async t => {
  const f = fixture(t)
  await settle()
  f.heartbeat(async () => Response.json({ error: 'forbidden', message: 'Access denied' }, { status: 403 }))
  t.mock.timers.tick(5000)
  await settle()
  assert.ok(f.errors.includes('Access denied'))
  assert.equal(f.registrations().length, 1)
  f.heartbeat(expired)
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(f.registrations().length, 2)
  f.register(async () => Response.json({ error: 'unavailable', message: 'Main unavailable' }, { status: 503 }))
  t.mock.timers.tick(3000)
  await settle()
  assert.ok(f.errors.includes('Main unavailable'))
})

test('an active capture fails on expiry and never silently gets replacement credentials', async t => {
  const f = fixture(t)
  await settle()
  const execution = new IoExecution({
    base,
    run: {
      version: 1, id: 'run', projectId: 'default', sessionId: 'web:test', revision: 'a'.repeat(64),
      definition: parseIoDefinition({
        version: 1, title: 'Synthetic input', purpose: 'Expiry test', endpoint: 'ws://127.0.0.1:1/test',
        sources: [{ id: 'mic', kind: 'microphone' }], limits: { durationMs: 10000, maxBytes: 8192 },
      }),
      status: 'running', createdAt: new Date().toISOString(), bytes: 0, artifacts: [],
    },
    grant: { clientId: 'synthetic-client', clientToken: 'synthetic-token', leaseToken: 'synthetic-lease' },
    change() {},
  })
  let failure: Error | undefined
  const fail = execution.fail.bind(execution)
  t.mock.method(execution, 'fail', async (error: Error) => { failure = error; await fail(error) })
  f.bridge.executionBase.value = base
  f.bridge.execution.value = execution
  f.heartbeat(expired)
  t.mock.timers.tick(5000)
  await settle()
  assert.match(failure!.message, /Capture connection lost:.*client expired/)
  assert.equal(f.registrations().length, 1)
  assert.equal(execution.phase, 'closed')
})

test('leaving a Project discards its cached client and returning obtains a fresh identity', async t => {
  const f = fixture(t)
  await settle()
  f.bridge.views.value = new Map()
  await settle()
  t.mock.timers.tick(20_000)
  await settle()
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 0)
  f.bridge.views.value = new Map([['chat', { apiBase: base, sessionId: 'web:test', remote: false }]])
  await settle()
  assert.equal(f.registrations().length, 2)
  assert.deepEqual(f.errors, [])
})

test('late registration cannot survive navigation and unmount aborts its replacement', async t => {
  const f = fixture(t)
  await settle()
  let release!: (value: Response) => void
  f.register(() => new Promise(resolve => { release = resolve }))
  f.bridge.views.value = new Map()
  await settle()
  f.bridge.views.value = new Map([['chat', { apiBase: base, sessionId: 'web:test', remote: false }]])
  await settle()
  const pending = f.registrations()[1]!
  f.bridge.views.value = new Map()
  await settle()
  assert.equal(pending.init.signal!.aborted, true)
  release(Response.json({ clientToken: 'obsolete' }))
  await settle()
  assert.deepEqual(f.errors, [])
  f.bridge.views.value = new Map([['chat', { apiBase: base, sessionId: 'web:test', remote: false }]])
  await settle()
  assert.equal(f.registrations().length, 3)
  f.unmount()
  assert.equal(f.registrations()[2]!.init.signal!.aborted, true)
  release(Response.json({ clientToken: 'also-obsolete' }))
  await settle()
  assert.deepEqual(f.errors, [])
})

test('returning to a visible window renews expired idle registration before refreshing requests', async t => {
  const f = fixture(t)
  await settle()
  f.heartbeat(expired)
  f.document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(f.registrations().length, 2)
  assert.deepEqual(f.errors, [])
})

test('a late heartbeat rejection cannot discard a newly registered client after navigation', async t => {
  const f = fixture(t)
  await settle()
  let release!: (value: Response) => void
  f.heartbeat(() => new Promise(resolve => { release = resolve }))
  t.mock.timers.tick(5000)
  await settle()
  f.bridge.views.value = new Map()
  await settle()
  f.bridge.views.value = new Map([['chat', { apiBase: base, sessionId: 'web:test', remote: false }]])
  await settle()
  assert.equal(f.registrations().length, 2)
  release(await expired())
  await settle()
  assert.equal(f.registrations().length, 2)
  assert.deepEqual(f.errors, [])
})

test('malformed replacement credentials are reported instead of pretending recovery succeeded', async t => {
  const f = fixture(t)
  await settle()
  f.heartbeat(expired)
  f.register(async () => Response.json({ clientToken: null }))
  t.mock.timers.tick(5000)
  await settle()
  assert.ok(f.errors.includes('Invalid capture client registration'))
  assert.equal(f.bridge.execution.value, undefined)
})
