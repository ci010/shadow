import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFrontendLog, startFrontendLog, summarizeFrontendArgs } from './frontend-log.ts'
import { ref } from 'vue'
import { watchFrontendLogScope } from './frontend-log-scope.ts'
import { projectBase } from './api-url.ts'

test('bounded safe summaries omit secrets, URLs, accessors and cycles', () => {
  const obj: Record<string, unknown> = { token: 'fixture-secret', nested: {} }
  obj.self = obj
  Object.defineProperty(obj, 'getter', { enumerable: true, get() { throw Error('must not run') } })
  const result = summarizeFrontendArgs([obj, new Error('failure at https://example.test/?token=abc'), 'password=fixture-secret'])
  assert.doesNotMatch(result, /fixture-secret|example.test/)
  assert.match(result, /circular/)
  assert.match(result, /accessor/)
  assert.ok(summarizeFrontendArgs(['x'.repeat(10_000)]).length <= 4096)
  assert.doesNotThrow(() => summarizeFrontendArgs([new Proxy({}, { ownKeys() { throw Error('proxy') } }), 2n]))
})

test('console behavior, bounded queue, silent transport, no recursion and disposal', async () => {
  const events = new EventTarget()
  let tick: () => void = () => {}
  let calls = 0
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, function(this: unknown, ..._args: unknown[]) { assert.equal(this, logger); calls++; return 'original' }]))
  const original = logger.log
  const target = { console: logger, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setInterval(fn: () => void) { tick = fn; return 1 }, clearInterval() {} } as unknown as Window & { console: Console }
  const batches: unknown[][] = []
  const stop = installFrontendLog(target, async batch => { batches.push(batch); logger.warn!('transport console') })
  assert.equal(logger.log!('ordinary'), 'original')
  for (let i = 0; i < 50; i++) logger.info!('burst')
  tick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(batches.length, 1); assert.equal(batches[0]!.length, 20)
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches.length, 1)
  events.dispatchEvent(Object.assign(new Event('error'), { error: new Error('window failure') }))
  events.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejection' }))
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches[1]!.length, 2)
  stop(); stop(); assert.equal(logger.log, original)
  events.dispatchEvent(Object.assign(new Event('error'), { message: 'after stop' }))
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches.length, 2)
  assert.equal(calls, 53)
})

const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function fakeWindow() {
  const events = new EventTarget()
  let tick = () => {}
  const console = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (..._args: unknown[]) => {}])) as unknown as Console
  const target = { console, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setInterval(fn: () => void) { tick = fn; return 1 }, clearInterval() { tick = () => {} } } as unknown as Window & { console: Console }
  return { target, tick: () => tick() }
}

test('capture continues during slow transport; failed batches retry silently and bounded', async () => {
  const fake = fakeWindow()
  let reject!: (reason: Error) => void
  const batches: Array<Array<{ level: string; message: string }>> = []
  const stop = installFrontendLog(fake.target, batch => {
    batches.push(batch)
    if (batches.length === 1) return new Promise((_resolve, fail) => { reject = fail })
    return Promise.resolve()
  })
  fake.target.console.warn('before request')
  fake.tick(); await settle()
  fake.target.console.warn('during request')
  reject(Error('offline')); await settle()
  fake.tick(); await settle()
  assert.equal(batches.length, 2)
  assert.match(batches[1]![0]!.message, /before request/)
  assert.match(batches[1]![1]!.message, /during request/)
  stop()
})

test('startup capture precedes capability GET; failures retry, abort discards, endpoints stay scoped', async t => {
  const fake = fakeWindow()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake.target })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  let capability!: (response: Response) => void
  const requests: Array<{ url: string; options?: RequestInit }> = []
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push({ url, options })
    if (options?.method !== 'POST') return new Promise<Response>(resolve => { capability = resolve })
    return new Response('{}', { status: ++posts === 1 ? 503 : 200 })
  })
  const controller = new AbortController()
  const original = fake.target.console.warn
  const stop = startFrontendLog('https://fixture.test/projects/a/', controller.signal)
  assert.notEqual(fake.target.console.warn, original)
  fake.target.console.warn('first render')
  fake.tick(); await settle()
  assert.equal(requests.length, 1)
  capability(new Response('{"enabled":true}')); await settle()
  assert.equal(posts, 1)
  fake.tick(); await settle()
  assert.equal(posts, 2)
  assert.match(String(requests.at(-1)!.options?.body), /first render/)
  for (const request of requests) {
    assert.equal(request.url, 'https://fixture.test/projects/a/api/runtime/frontend-logs')
    assert.equal(request.options?.credentials, 'same-origin')
    assert.equal(request.options?.signal, controller.signal)
  }
  fake.target.console.warn('discard on switch')
  controller.abort(); stop()
  assert.equal(fake.target.console.warn, original)
  fake.tick(); await settle()
  assert.equal(posts, 2)
})

test('transient capability error recovers without route change; disabled backend restores hooks', async t => {
  const fake = fakeWindow()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake.target })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  let gets = 0, posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { posts++; return new Response('{}') }
    if (++gets === 1) throw Error('temporarily offline')
    return new Response('{"enabled":true}')
  })
  const stop = startFrontendLog('https://fixture.test/projects/a', new AbortController().signal)
  fake.target.console.warn('queued'); await settle()
  fake.tick(); await settle()
  assert.equal(gets, 2); assert.equal(posts, 1)
  stop()
  const original = fake.target.console.warn
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }))
  startFrontendLog('https://fixture.test/projects/a', new AbortController().signal)
  await settle()
  assert.equal(fake.target.console.warn, original)
})

test('route Project/base transitions are synchronous; unscoped routes never inherit a Project', () => {
  const project = ref<string | undefined>('a')
  const host = ref('https://fixture.test')
  const starts: Array<{ base: string; signal: AbortSignal }> = []
  let stops = 0
  const stop = watchFrontendLogScope(() => project.value ? projectBase(host.value, project.value) : undefined,
    (base, signal) => { starts.push({ base, signal }); return () => { stops++ } })
  assert.equal(starts.length, 1)
  project.value = 'b'
  assert.equal(starts.length, 2)
  assert.equal(starts[0]!.signal.aborted, true)
  assert.equal(starts[1]!.base, 'https://fixture.test/projects/b/')
  host.value = 'https://other.test'
  assert.equal(starts[1]!.signal.aborted, true)
  assert.equal(starts[2]!.base, 'https://other.test/projects/b/')
  project.value = undefined
  assert.equal(starts[2]!.signal.aborted, true)
  assert.equal(starts.length, 3)
  stop(); assert.equal(stops, 3)
})

test('wire batches respect UTF-8 byte limit; permanent POST failures do not starve new logs', async t => {
  const fake = fakeWindow()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake.target })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  const bodies: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    if (options?.method !== 'POST') return new Response('{"enabled":true}')
    bodies.push(String(options.body))
    return new Response('{}', { status: bodies.length === 1 ? 413 : 200 })
  })
  const stop = startFrontendLog('https://fixture.test/projects/a', new AbortController().signal)
  // Twenty valid summaries would exceed the backend's 96 KiB byte limit.
  for (let i = 0; i < 20; i++) fake.target.console.warn('汉'.repeat(2048))
  fake.tick(); await settle()
  fake.target.console.warn('new event after permanent failure')
  fake.tick(); await settle()
  assert.equal(bodies.length, 2)
  assert.ok(bodies.every(body => new TextEncoder().encode(body).byteLength < 96 * 1024))
  assert.match(bodies[1]!, /new event after permanent failure/)
  assert.equal(bodies.reduce((sum, body) => sum + JSON.parse(body).events.length, 0), 21)
  stop()
})

test('late capability completion cannot resurrect a collector after a Project switch', async t => {
  const fake = fakeWindow()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake.target })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  let resolveOld!: (response: Response) => void
  const posts: Array<{ url: string; body: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { posts.push({ url, body: String(options.body) }); return new Response('{}') }
    if (url.includes('/projects/a/')) return new Promise<Response>(resolve => { resolveOld = resolve })
    return new Response('{"enabled":true}')
  })
  const project = ref<string | undefined>('a')
  const stop = watchFrontendLogScope(() => project.value ? projectBase('https://fixture.test', project.value) : undefined)
  fake.target.console.warn('old project warning')
  fake.tick(); await settle()
  project.value = 'b'
  fake.target.console.warn('new project warning')
  resolveOld(new Response('{"enabled":true}')); await settle()
  fake.tick(); await settle()
  assert.equal(posts.length, 1)
  assert.match(posts[0]!.url, /\/projects\/b\//)
  assert.match(posts[0]!.body, /new project warning/)
  assert.doesNotMatch(posts[0]!.body, /old project warning/)
  project.value = undefined
  stop()
})


test('frontend log starts and sends a UUID tab ID on HTTP without crypto.randomUUID', async t => {
  const fake = fakeWindow()
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const crypto = globalThis.crypto
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake.target })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } })
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })
  const batches: Array<{ tabId: string; events: unknown[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') batches.push(JSON.parse(options.body as string))
    return Response.json({ enabled: true })
  })
  const stop = startFrontendLog('http://192.168.1.50/projects/default', new AbortController().signal)
  t.after(stop)
  await settle()
  fake.target.console.warn('HTTP startup works')
  fake.tick()
  await settle()
  assert.equal(batches.length, 1)
  assert.match(batches[0]!.tabId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(batches[0]!.events.length, 1)
})
