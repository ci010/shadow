import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component, type ComponentPublicInstance } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver, LiveStatus } from './live-client.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const log = (id: number) => ({ id, time: 1000 + id, body: `log ${id}`, attributes: '[]' })
const span = (id: number, traceId = 'trace-a') => ({
  id, trace_id: traceId, span_id: `span-${id}`, name: `span ${id}`, start_time: 1000 + id,
  attributes: '[]', events: '[]',
})

function mountTelemetry(t: TestContext, name: 'LogsTab' | 'SpansTab', timeoutMs = 15_000) {
  const requests: Array<{ url: URL; signal: AbortSignal; finish: (value: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: new URL(String(input)), signal: init.signal!, finish: (value, status = 200) => resolve(Response.json(value, { status })) })
  }))
  const subscriptions: Array<{ base: string; topic: unknown; observer: LiveObserver; closed: boolean }> = []
  const observers = new Set<(statuses: readonly LiveStatus[]) => void>()
  const pool = {
    client: (base: string) => ({
      subscribe: (topic: unknown, observer: LiveObserver) => {
        const subscription = { base, topic, observer, closed: false }
        subscriptions.push(subscription)
        return { ready: async () => {}, close: () => { subscription.closed = true } }
      },
    }),
    observe: (observer: (statuses: readonly LiveStatus[]) => void) => {
      observers.add(observer)
      observer([{ phase: 'live' }])
      return () => observers.delete(observer)
    },
  }
  const props = reactive({ apiBase: 'http://fixture/projects/a' })
  const url = new URL(`./components/${name}.vue`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: name })
  const template = compileTemplate({ source: descriptor.template!.content, filename: url.pathname, id: name,
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [], 'SFC template compiles')
  const { outputText, diagnostics } = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  })
  assert.deepEqual(diagnostics, [])
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id.endsWith('.vue')) return {}
    if (id === '../composables/useLiveClient.ts') return {
      useLiveClientPool: () => pool, liveProjectId: (base: string) => new URL(base).pathname.split('/').at(-1),
    }
    if (id === '../live-refresh.ts') return {
      createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0, timeoutMs }),
    }
    return require(id)
  }, module, module.exports)
  module.exports.default.render = () => null
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  let instance: ComponentPublicInstance | null = null
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(module.exports.default, { ...props, ref: (value: ComponentPublicInstance | null) => { instance = value } }),
  }))
  app.mount({})
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  t.after(unmount)
  const state = () => {
    assert.ok(instance)
    return Reflect.get(instance.$, 'setupState')
  }
  const event = (value: unknown) => subscriptions.at(-1)!.observer.event({
    type: 'event', payload: value,
  } as Parameters<LiveObserver['event']>[0])
  return { props, requests, subscriptions, observers, state, event, unmount }
}

test('logs merge live records into the initial snapshot, dedupe, paginate and retry failures', async t => {
  const view = mountTelemetry(t, 'LogsTab')
  await settle()
  assert.deepEqual(view.subscriptions[0].topic, { kind: 'logs', projectId: 'a' })
  view.event(log(21))
  view.requests[0].finish({ entries: Array.from({ length: 20 }, (_, i) => log(21 - i)), total: 40 })
  await settle()
  assert.equal(view.state().logEntries.length, 20)
  assert.equal(view.state().logEntries[0].dbId, 21)
  view.event(log(21))
  assert.equal(view.state().logEntries.length, 20)
  const page = view.state().loadMoreLogs()
  assert.equal(view.requests[1].url.searchParams.get('beforeId'), '2')
  view.requests[1].finish({}, 503)
  await page
  assert.match(view.state().error, /older logs/)
  view.state().retryLogs()
  view.requests[2].finish({ entries: [log(1)], total: 40 })
  await settle()
  assert.equal(view.state().logEntries.at(-1).dbId, 1)
  assert.equal(view.state().hasMore, false)
  assert.equal(view.state().error, '')
})

test('logs preserve historical pages and selection when automatic accumulation reaches its cap', async t => {
  const view = mountTelemetry(t, 'LogsTab')
  await settle()
  view.requests[0].finish({ entries: [log(20)], total: 20 })
  await settle()
  const page = view.state().loadMoreLogs()
  view.requests[1].finish({ entries: [log(1)], total: 20 })
  await page
  view.state().selectLog(view.state().logEntries.at(-1))
  for (let id = 21; id < 1100; id++) view.event(log(id))
  assert.equal(view.state().logEntries.length, 1001)
  assert.equal(view.state().logEntries.at(-1).dbId, 1)
  assert.equal(view.state().selectedLog.dbId, 1)
  assert.equal(view.state().windowFull, true)
  view.state().refreshLogs()
  await settle()
  view.requests[2].finish({ entries: [], total: 0 })
  await settle()
  assert.equal(view.state().logEntries.length, 0)
  assert.equal(view.state().windowFull, false)
  assert.equal(view.state().selectedLog.dbId, 1, 'Explicit selection survives a snapshot')
})

for (const name of ['LogsTab', 'SpansTab'] as const) {
  test(`${name} closes old scopes, aborts snapshots, rejects malformed live records and suppresses late unmount results`, async t => {
    const view = mountTelemetry(t, name)
    await settle()
    view.props.apiBase = 'http://fixture/projects/b'
    await nextTick()
    assert.equal(view.subscriptions[0].closed, true)
    assert.equal(view.requests[0].signal.aborted, true)
    await settle()
    const key = name === 'LogsTab' ? 'logEntries' : 'spans'
    view.requests[0].finish({ entries: [name === 'LogsTab' ? log(1) : span(1)], total: 1 })
    view.requests[1].finish({ entries: [], total: 0 })
    await settle()
    assert.equal(view.state()[key].length, 0)
    assert.match(String(view.requests[1].url), /projects\/b/)
    view.event({ unexpected: true })
    assert.match(view.state().error, /live/)
    view.subscriptions[1].observer.reset('subscription')
    await settle()
    const state = view.state()
    view.unmount()
    assert.equal(view.requests[2].signal.aborted, true)
    assert.equal(view.subscriptions[1].closed, true)
    assert.equal(view.observers.size, 0)
    view.requests[2].finish({ entries: [name === 'LogsTab' ? log(2) : span(2)], total: 1 })
    await settle()
    assert.equal(state[key].length, 0)
    assert.equal(view.subscriptions.length, 2)
  })

  test(`${name} reset reads are serialized and snapshot errors remain retryable`, async t => {
    const view = mountTelemetry(t, name)
    await settle()
    for (let i = 0; i < 10; i++) view.subscriptions[0].observer.reset('subscription')
    await settle()
    assert.equal(view.requests.length, 1)
    view.requests[0].finish({}, 500)
    await settle()
    assert.match(view.state().error, /saved/)
    assert.equal(view.requests.length, 2)
    view.event(name === 'LogsTab' ? log(3) : span(3))
    view.requests[1].finish({ entries: [], total: 0 })
    await settle()
    assert.equal(view.state()[name === 'LogsTab' ? 'logEntries' : 'spans'].length, 1)
    assert.equal(view.state().error, '')
  })
}

test('spans dedupe updates, bound retention, and retain selected trace while other traces arrive', async t => {
  const view = mountTelemetry(t, 'SpansTab')
  await settle()
  view.event({ ...span(1), end_time: 2000 })
  view.requests[0].finish({ entries: [span(1)], total: 1 })
  await settle()
  assert.equal(view.state().spans.length, 1)
  assert.equal(view.state().spans[0].endTime, 2000)
  view.state().selectTrace('trace-a')
  await settle()
  view.requests[1].finish({ entries: [span(1)], total: 1 })
  view.requests[2].finish({ entries: [{ ...log(1), span_id: 'span-1' }], total: 1 })
  await settle()
  assert.equal(view.state().spanLogs.length, 1)
  for (let id = 2; id < 1050; id++) view.event(span(id, 'trace-b'))
  assert.equal(view.state().spans.length, 1000)
  assert.equal(view.state().selectedSpan.spanId, 'span-1')
  assert.equal(view.state().windowFull, true)
  view.state().selectTrace('trace-b')
  await settle()
  const oldDetails = view.requests.slice(3, 5)
  view.state().selectTrace('trace-c')
  await nextTick()
  assert.ok(oldDetails.every(request => request.signal.aborted))
  for (const request of oldDetails) request.finish({ entries: [], total: 0 })
  await settle()
  assert.equal(view.state().selectedTraceId, 'trace-c')
  assert.equal(view.state().spanLogs.length, 0)
})

test('malformed nested telemetry and failed trace details are visible rather than empty success', async t => {
  const view = mountTelemetry(t, 'SpansTab')
  await settle()
  view.requests[0].finish({ entries: [span(1)], total: 1 })
  await settle()
  view.event({ ...span(2), events: '[null]' })
  assert.match(view.state().error, /live span/)
  assert.equal(view.state().spans.length, 1)
  view.state().selectTrace('trace-a')
  await settle()
  view.requests[1].finish({ entries: [span(1)], total: 1 })
  view.requests[2].finish({}, 503)
  await settle()
  assert.match(view.state().detailError, /trace and its logs/)
  assert.equal(view.state().detailsLoading, false)
  view.state().refreshDetails()
  await settle()
  view.requests[3].finish({ entries: [span(1)], total: 1 })
  view.requests[4].finish({ entries: [], total: 0 })
  await settle()
  assert.equal(view.state().detailError, '')
})

test('replacing log history aborts its request and malformed snapshots do not become empty success', async t => {
  const view = mountTelemetry(t, 'LogsTab')
  await settle()
  view.requests[0].finish({ entries: [log(2)], total: 2 })
  await settle()
  const page = view.state().loadMoreLogs()
  view.subscriptions[0].observer.reset('subscription')
  assert.equal(view.requests[1].signal.aborted, true)
  view.requests[1].finish({ entries: [log(1)], total: 2 })
  await page
  await settle()
  view.requests[2].finish({ entries: [{ ...log(3), attributes: '{}' }], total: 3 })
  await settle()
  assert.match(view.state().error, /saved logs/)
  assert.equal(view.state().logEntries.length, 1)
  assert.equal(view.state().logEntries[0].dbId, 2)
})

test('timed-out snapshots suppress their late results and expose retryable state', async t => {
  const view = mountTelemetry(t, 'LogsTab', 5)
  await settle()
  if (!view.requests[0].signal.aborted) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Snapshot did not time out')), 1000)
      view.requests[0].signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  assert.equal(view.requests[0].signal.aborted, true)
  view.requests[0].finish({ entries: [log(1)], total: 1 })
  await settle()
  assert.equal(view.state().logEntries.length, 0)
  assert.match(view.state().error, /saved logs/)
})
