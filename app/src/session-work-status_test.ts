import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionWorkStatus } from './session-work-status.ts'

const empty = { records: [], effects: [] }

test('session work missing is terminal for revisions, but explicit retry and new identity recover', async () => {
  let requests = 0
  let available = false
  const request: typeof fetch = async () => {
    requests++
    return available ? Response.json(empty) : Response.json({ error: 'session_not_found' }, { status: 404 })
  }
  const snapshot = createSessionWorkStatus('http://fixture/projects/a', 'web:draft', request, 0)
  try {
    await snapshot.autoRefresh()
    assert.match(snapshot.state.error, /conversation is no longer/)
    for (let i = 0; i < 10; i++) await snapshot.autoRefresh()
    snapshot.pause()
    await snapshot.autoRefresh()
    assert.equal(requests, 1)
    available = true
    await snapshot.refresh()
    assert.equal(snapshot.state.error, '')
    assert.deepEqual(snapshot.state.value, empty)
    await snapshot.autoRefresh()
    assert.equal(requests, 3)
  } finally { snapshot.dispose() }
  const next = createSessionWorkStatus('http://fixture/projects/b', 'web:other', request, 0)
  try { await next.autoRefresh(); assert.equal(requests, 4) } finally { next.dispose() }
})

test('queued revisions and late aborted missing replies never cause extra HTTP reads', async () => {
  let requests = 0
  let finish!: (response: Response) => void
  const request: typeof fetch = async () => { requests++; return new Promise(resolve => { finish = resolve }) }
  const snapshot = createSessionWorkStatus('http://fixture', 'web:test', request, 0)
  try {
    const first = snapshot.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    const queued = snapshot.autoRefresh()
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await Promise.all([first, queued])
    assert.equal(requests, 1)
  } finally { snapshot.dispose() }
  const next = createSessionWorkStatus('http://fixture', 'web:test', request, 0)
  try {
    const pending = next.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    next.pause()
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await pending
    await new Promise(resolve => setTimeout(resolve, 10))
    const retry = next.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(requests, 3)
    finish(Response.json(empty))
    await retry
    assert.equal(next.state.error, '')
  } finally { next.dispose() }
})

for (const [status, body] of [[404, { error: 'unknown_route' }], [403, {}], [500, {}], [200, {}]] as const) {
  test(`session work non-terminal ${status} errors remain visible and retryable`, async () => {
    let requests = 0
    const snapshot = createSessionWorkStatus('http://fixture', 'web:test', async () => {
      requests++
      return Response.json(body, { status })
    }, 0)
    try {
      await snapshot.autoRefresh()
      assert.notEqual(snapshot.state.error, '')
      await snapshot.autoRefresh()
      assert.equal(requests, 2)
    } finally { snapshot.dispose() }
  })
}

test('session work empty draft identity does not discover', async () => {
  let requests = 0
  const snapshot = createSessionWorkStatus('http://fixture', '', async () => { requests++; return Response.json(empty) }, 0)
  try { await snapshot.autoRefresh(); assert.equal(requests, 0) } finally { snapshot.dispose() }
})

test('a matching completed turn reconciles an initially unpersisted draft once', async () => {
  let requests = 0
  let available = false
  const snapshot = createSessionWorkStatus('http://fixture', 'web:draft', async () => {
    requests++
    return available ? Response.json(empty) : Response.json({ error: 'session_not_found' }, { status: 404 })
  }, 0)
  try {
    await snapshot.autoRefresh()
    for (const payload of [
      { event: 'invalidate', sessionId: 'other', completedTurnId: 'turn-1' },
      { event: 'invalidate', sessionId: 'web:draft' },
      { event: 'invalidate', sessionId: 'web:draft', completedTurnId: '' },
      { event: 'activity', sessionId: 'web:draft', completedTurnId: 'turn-1' },
    ]) await snapshot.reconcile(payload)
    assert.equal(requests, 1)
    const completed = { event: 'invalidate', sessionId: 'web:draft', completedTurnId: 'turn-1' }
    await snapshot.reconcile(completed)
    await snapshot.reconcile(completed)
    assert.equal(requests, 2)
    available = true
    await snapshot.reconcile({ ...completed, completedTurnId: 'turn-2' })
    assert.equal(requests, 3)
    assert.equal(snapshot.state.error, '')
  } finally { snapshot.dispose() }
})

test('completed turn during an in-flight draft 404 schedules a fresh persisted read', async () => {
  let requests = 0
  let finish!: (response: Response) => void
  const snapshot = createSessionWorkStatus('http://fixture', 'web:draft', async () => {
    requests++
    if (requests > 1) return Response.json(empty)
    return new Promise(resolve => { finish = resolve })
  }, 0)
  try {
    const first = snapshot.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    const reconciled = snapshot.reconcile({ event: 'invalidate', sessionId: 'web:draft', completedTurnId: 'turn-1' })
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await Promise.all([first, reconciled])
    assert.equal(requests, 2)
    assert.equal(snapshot.state.error, '')
  } finally { snapshot.dispose() }
})

test('mounted work status gates initial ready and ignores graph revisions, but recovers relevant events and scopes', async t => {
  const Vue = await import('vue')
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const { parse, compileScript } = await import('vue/compiler-sfc')
  const ts = await import('typescript')
  const { createInitialLiveSnapshot } = await import('./initial-live-snapshot.ts')
  const subscriptions: Array<{ observer: import('./live-client.ts').LiveObserver; ready: () => void; closed: boolean }> = []
  let requests = 0
  let finish: (() => void) | undefined
  const request: typeof fetch = async () => {
    requests++
    if (finish) await new Promise<void>(resolve => { finish = resolve })
    return Response.json(empty)
  }
  const pool = { client: () => ({ subscribe(_topic: unknown, observer: import('./live-client.ts').LiveObserver) {
    let ready!: () => void
    const promise = new Promise<void>(resolve => { ready = resolve })
    const entry = { observer, ready, closed: false }
    subscriptions.push(entry)
    queueMicrotask(() => observer.reset('subscription'))
    return { ready: () => promise, close() { entry.closed = true } }
  } }) }
  const url = new URL('./components/SessionWorkStatus.vue', import.meta.url)
  const script = compileScript(parse(readFileSync(url, 'utf8')).descriptor, { id: 'work-test' })
  const module = { exports: {} as { default: import('vue').Component & { render?: () => null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((id: string) => {
    if (id === 'vue') return Vue
    if (id === '../composables/useLiveClient.ts') return { useLiveClientPool: () => pool, liveProjectId: () => 'a' }
    if (id === '../initial-live-snapshot.ts') return { createInitialLiveSnapshot }
    if (id === '../session-work-status.ts') return { createSessionWorkStatus: (base: string, id: string) => createSessionWorkStatus(base, id, request, 0) }
    return require(id)
  }, module, module.exports)
  module.exports.default.render = () => null
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const props = Vue.reactive({ apiBase: 'http://fixture/projects/a', sessionId: 'web:one', active: true, revision: 0 })
  const app = renderer.createApp({ setup: () => () => Vue.h(module.exports.default, props) })
  app.mount({})
  t.after(() => app.unmount())
  const tick = () => new Promise(resolve => setTimeout(resolve, 10))
  await tick()
  assert.equal(requests, 0)
  subscriptions[0].ready()
  await tick()
  props.revision++ // graph/activity application after ready is not a work event
  await Vue.nextTick(); await tick()
  assert.equal(requests, 1)
  const event = (index: number, sessionId: string, kind = 'invalidate') => subscriptions[index].observer.event({ type: 'event', cursor: 'x:1', topic: { kind: 'sessions', projectId: 'a' }, payload: { event: kind, sessionId } })
  event(0, 'web:other'); await tick()
  assert.equal(requests, 1)
  event(0, 'web:one', 'activity'); await tick()
  event(0, 'web:one', 'unrelated'); await tick()
  assert.equal(requests, 1, 'pure activity and unrelated event kinds never refresh Work')
  finish = () => {}
  event(0, 'web:one'); await tick()
  assert.equal(requests, 2)
  event(0, 'web:one') // an event during HTTP must queue another read
  const resolve = finish!; finish = undefined; resolve()
  await tick(); await tick()
  assert.equal(requests, 3)
  subscriptions[0].observer.reset('epoch'); await tick()
  assert.equal(requests, 4)
  props.sessionId = 'web:two'; await Vue.nextTick(); await tick()
  assert.equal(subscriptions[0].closed, true)
  assert.equal(requests, 4)
  subscriptions[1].ready(); await tick()
  assert.equal(requests, 5)
  props.active = false; await Vue.nextTick()
  assert.equal(subscriptions[1].closed, true)
  event(1, 'web:two'); await tick()
  assert.equal(requests, 5)
})
