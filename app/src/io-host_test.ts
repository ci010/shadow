import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, nextTick, watch, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createIoBridge } from './io/bridge.ts'
import { IoExecution } from './io/execution.ts'
import type { LiveStatus } from './live-client.ts'
import { parseIoDefinition } from '../../src/io/contracts.ts'

const run = {
  version: 1 as const, id: 'run', projectId: 'default', sessionId: 'web:test', revision: 'a'.repeat(64),
  definition: parseIoDefinition({ version: 1, title: 'Synthetic input', purpose: 'Host test', endpoint: 'ws://127.0.0.1:1/test',
    sources: [{ id: 'mic', kind: 'microphone' }], limits: { durationMs: 10000, maxBytes: 8192 } }),
  status: 'awaiting_consent' as const, createdAt: new Date().toISOString(), bytes: 0, artifacts: [],
}

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
  t.mock.method(IoExecution.prototype, 'connect', () => {})
  let phase!: (status: LiveStatus) => void
  let live!: { event: () => void; reset: () => void; reconnected: () => void }
  const calls: { path: string; init: RequestInit }[] = []
  let register = async () => Response.json({ clientToken: 'synthetic-client' })
  let prepareResponse = async () => Response.json({ leaseToken: 'synthetic-lease', run: { ...run, status: 'running' } })
  let heartbeat = async () => Response.json({ ok: true })
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const path = new URL(input).pathname
    calls.push({ path, init })
    if (path.endsWith('/details')) return Response.json({ sessionId: run.sessionId, name: null, workdir: { kind: 'local', displayPath: '/synthetic' }, usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
    if (path.endsWith('/prepare')) return prepareResponse()
    if (path.endsWith('/runs/run')) return Response.json(run)
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
    if (id.endsWith('/io/execution.ts')) return { IoExecution }
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
    observeHost: (_base: string, callback: typeof phase) => { phase = callback; callback({ phase: 'live' }); return () => {} },
    client: () => ({ subscribe: (_topic: unknown, observer: typeof live) => { live = observer; return { close() {}, ready: async () => {} } } }),
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
    live: () => live,
    phase: (value: LiveStatus['phase']) => phase({ phase: value }),
    prepare: () => bridge.actions.value!.prepare(run, base),
    polls: () => calls.filter(call => call.path.endsWith('/runs')),
    prepareResponse: (next: typeof prepareResponse) => { prepareResponse = next },
    heartbeat: (next: typeof heartbeat) => { heartbeat = next },
    register: (next: typeof register) => { register = next },
    registrations: () => calls.filter(call => call.path.endsWith('/clients')),
  }
}

const expired = () => Promise.resolve(Response.json({
  error: 'client_expired', message: 'The I/O client expired; reconnect explicitly',
}, { status: 403 }))

test('idle discovery uses live invalidation and a slower fallback without registering or heartbeating', async t => {
  const f = fixture(t)
  await settle()
  assert.equal(f.polls().length, 1)
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(f.polls().length, 1)
  f.live().event()
  await settle()
  assert.equal(f.polls().length, 2)
  f.live().reset()
  await settle()
  assert.equal(f.polls().length, 3)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(f.polls().length, 3)
  f.phase('reconnecting')
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(f.polls().length, 4)
  f.phase('live')
  f.live().reconnected()
  await settle()
  assert.equal(f.polls().length, 5)
  assert.equal(f.registrations().length, 0)
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 0)
})

test('hidden idle views do not poll; becoming visible immediately refreshes without registration', async t => {
  const f = fixture(t)
  await settle()
  f.document.hidden = true
  t.mock.timers.tick(30_000)
  f.live().event()
  await settle()
  assert.equal(f.polls().length, 1)
  f.document.hidden = false
  f.document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(f.polls().length, 2)
  assert.equal(f.registrations().length, 0)
})

test('prepare registers on demand and active hidden capture still heartbeats', async t => {
  const f = fixture(t)
  await settle()
  await f.prepare()
  assert.deepEqual(f.errors, [])
  assert.equal(f.registrations().length, 1)
  assert.ok(f.bridge.execution.value)
  f.document.hidden = true
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 1)
})

test('expired active credentials fail capture and never silently register replacements on wake', async t => {
  const f = fixture(t)
  await settle()
  await f.prepare()
  const execution = f.bridge.execution.value!
  f.heartbeat(expired)
  f.document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(execution.phase, 'closed')
  assert.match(execution.error!, /Capture connection lost:.*client expired/)
  t.mock.timers.tick(30_000)
  f.document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(f.registrations().length, 1)
  assert.equal(f.calls.filter(call => call.path.endsWith('/prepare')).length, 1)
})

test('malformed on-demand credentials are reported without preparing capture', async t => {
  const f = fixture(t)
  await settle()
  f.register(async () => Response.json({ clientToken: null }))
  await f.prepare()
  assert.ok(f.errors.includes('Invalid capture client registration'))
  assert.equal(f.bridge.execution.value, undefined)
})

test('navigation aborts pending on-demand registration and discards late credentials', async t => {
  const f = fixture(t)
  await settle()
  let release!: (value: Response) => void
  f.register(() => new Promise(resolve => { release = resolve }))
  const preparing = f.prepare()
  await settle()
  const pending = f.registrations()[0]!
  f.bridge.views.value = new Map()
  await settle()
  assert.equal(pending.init.signal!.aborted, true)
  release(Response.json({ clientToken: 'obsolete' }))
  await preparing
  assert.equal(f.bridge.execution.value, undefined)
  assert.equal(f.calls.filter(call => call.path.endsWith('/prepare')).length, 0)
})

test('a new prepare after an idle gap obtains a fresh identity, not expired cached credentials', async t => {
  const f = fixture(t)
  await settle()
  await f.prepare()
  await f.bridge.execution.value!.cancel()
  t.mock.timers.tick(60_000)
  await settle()
  const pulses = f.calls.filter(call => call.path.endsWith('/heartbeat')).length
  assert.equal(pulses, 0)
  await f.prepare()
  assert.equal(f.registrations().length, 2)
  assert.notEqual(JSON.parse(String(f.registrations()[0]!.init.body)).id, JSON.parse(String(f.registrations()[1]!.init.body)).id)
  assert.deepEqual(f.errors, [])
})

test('a slow prepare retains client heartbeats without registering another identity', async t => {
  const f = fixture(t)
  await settle()
  let release!: (response: Response) => void
  f.prepareResponse(() => new Promise(resolve => { release = resolve }))
  const preparing = f.prepare()
  await settle()
  t.mock.timers.tick(16_000)
  await settle()
  assert.ok(f.calls.some(call => call.path.endsWith('/heartbeat')))
  assert.equal(f.registrations().length, 1)
  release(Response.json({ leaseToken: 'synthetic-lease', run: { ...run, status: 'running' } }))
  await preparing
  assert.deepEqual(f.errors, [])
})
