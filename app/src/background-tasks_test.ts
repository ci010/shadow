import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component, type ComponentPublicInstance } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { fetchBackgroundTasks } from './background-tasks.ts'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver } from './live-client.ts'

const sessionId = 'web:chat-process'
const task = (id = 'one') => ({ id, sessionId, kind: 'process', title: `exec: server ${id}`, status: 'running', createdAt: '2026-09-16T00:00:00Z' })
const snapshot = (tasks = [task()]) => ({ sessionId, total: tasks.length, tasks })
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('background task client preserves scope, validates ownership/counts and drops non-summary fields', async () => {
  const signal = new AbortController().signal
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://fixture/projects/a/api/sessions/web%3Achat-process/background-tasks')
    assert.equal(init?.signal, signal)
    assert.equal(init?.cache, 'no-store')
    const record = { ...task(), output: 'synthetic private output' }
    return Response.json(snapshot([record]))
  }
  const value = await fetchBackgroundTasks('http://fixture/projects/a', sessionId, signal, request)
  assert.equal(JSON.stringify(value).includes('private'), false)
  for (const value of [
    { ...snapshot(), sessionId: 'other' }, { ...snapshot(), total: 5 },
    snapshot([task(), task()]), snapshot([{ ...task(), sessionId: 'other' }]),
    snapshot([{ ...task(), status: 'completed' }]), snapshot([{ ...task(), createdAt: 'bad' }]),
    snapshot([{ ...task(), kind: 'unknown' }]),
  ]) await assert.rejects(fetchBackgroundTasks('http://fixture', sessionId, signal, async () => Response.json(value)), /invalid background task/)
})

test('inventory limits and explicit authorization/upgrade failures are preserved', async () => {
  const signal = new AbortController().signal
  const data = { ...snapshot(Array.from({ length: 100 }, (_, id) => task(String(id)))), total: 105 }
  assert.equal((await fetchBackgroundTasks('http://fixture', sessionId, signal, async () => Response.json(data))).total, 105)
  for (const [response, message] of [
    [Response.json({}, { status: 403 }), /denied/],
    [Response.json({ error: 'session_not_found' }, { status: 404 }), /conversation is no longer/],
    [new Response('Not Found', { status: 404 }), /Restart Main/],
    [Response.json(snapshot(Array.from({ length: 101 }, (_, id) => task(String(id))))), /invalid background task/],
  ] as const) await assert.rejects(fetchBackgroundTasks('http://fixture', sessionId, signal, async () => response), message)
})

function mount(t: TestContext, active = true) {
  const requests: Array<{ url: URL; signal: AbortSignal; finish: (value: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: new URL(String(input)), signal: init.signal!, finish: (value, status = 200) => resolve(Response.json(value, { status })) })
  }))
  const subscriptions: Array<{ base: string; observer: LiveObserver; closed: boolean }> = []
  const props = reactive({ apiBase: 'http://fixture/projects/a', sessionId, active })
  const url = new URL('./components/BackgroundTasks.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: 'background-tasks' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: url.pathname, id: 'background-tasks',
    compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { outputText, diagnostics } = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  })
  assert.deepEqual(diagnostics, [])
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id === '../composables/useLiveClient.ts') return {
      liveProjectId: (base: string) => new URL(base).pathname.split('/').at(-1),
      useLiveClientPool: () => ({ client: (base: string) => ({
        subscribe: (_topic: unknown, observer: LiveObserver) => {
          const entry = { base, observer, closed: false }
          subscriptions.push(entry)
          return { ready: async () => {}, close: () => { entry.closed = true } }
        },
      }) }),
    }
    if (id === '../live-refresh.ts') return {
      createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0 }),
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
  t.after(() => app.unmount())
  const state = () => { assert.ok(instance); return Reflect.get(instance.$, 'setupState') }
  const invalidate = (id = sessionId) => subscriptions.at(-1)!.observer.event({
    type: 'event', cursor: 'fixture:1', topic: { kind: 'sessions', projectId: 'a' }, payload: { event: 'invalidate', sessionId: id },
  })
  return { props, requests, subscriptions, state, invalidate }
}

test('running tasks update through shared invalidations and disappear after completion', async t => {
  const view = mount(t)
  await settle()
  view.requests[0].finish(snapshot([task(), task('two')]))
  await settle()
  assert.equal(view.state().total, 2)
  view.invalidate('another-session')
  await settle()
  assert.equal(view.requests.length, 1)
  for (let i = 0; i < 20; i++) view.invalidate()
  await settle()
  assert.equal(view.requests.length, 2)
  view.requests[1].finish(snapshot([]))
  await settle()
  assert.equal(view.state().tasks.length, 0)
  assert.equal(view.state().error, '')
})

test('scope changes abort stale reads and never reuse another project task data', async t => {
  const view = mount(t)
  await settle()
  view.props.apiBase = 'http://fixture/projects/b'
  await nextTick()
  await settle()
  assert.equal(view.requests[0].signal.aborted, true)
  assert.equal(view.subscriptions[0].closed, true)
  view.requests[1].finish(snapshot([task('b')]))
  await settle()
  view.requests[0].finish(snapshot([task('a')]))
  await settle()
  assert.deepEqual(view.state().tasks.map((task: { id: string }) => task.id), ['b'])
})

test('hidden views release subscriptions and retain their disclosure state', async t => {
  const view = mount(t, false)
  await settle()
  assert.equal(view.requests.length, 0)
  view.props.active = true
  await nextTick()
  await settle()
  view.requests[0].finish(snapshot())
  await settle()
  view.state().expanded = true
  view.props.active = false
  await nextTick()
  assert.equal(view.subscriptions[0].closed, true)
  view.props.active = true
  await nextTick()
  await settle()
  assert.equal(view.state().expanded, true)
  assert.equal(view.requests.length, 2)
})

test('failed reads show a retryable status rather than claiming zero running tasks', async t => {
  const view = mount(t)
  await settle()
  view.requests[0].finish({}, 503)
  await settle()
  assert.match(view.state().error, /unavailable/)
  view.state().refresh()
  await settle()
  view.requests[1].finish(snapshot())
  await settle()
  assert.equal(view.state().error, '')
  assert.equal(view.state().total, 1)
  view.invalidate()
  await settle()
  view.requests[2].finish({}, 503)
  await settle()
  assert.equal(view.state().tasks.length, 0)
  assert.match(view.state().error, /unavailable/)
})

test('an unadmitted draft never fetches task inventory', async t => {
  const view = mount(t, false)
  view.props.sessionId = ''
  view.props.active = true
  await nextTick()
  await settle()
  assert.equal(view.requests.length, 0)
  assert.equal(view.subscriptions.length, 0)
})
