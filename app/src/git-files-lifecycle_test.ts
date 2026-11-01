import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, nextTick, reactive, ref } from 'vue'
import { createWorkdirGitReaders, useWorkdirGit } from './composables/useWorkdirGit.ts'

test('Git polling cancels old identities and hidden panes, preserving explicit failure state', async t => {
  const requests: { url: URL; signal: AbortSignal; finish: (response: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL, init?: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ url, signal: init!.signal!, finish: resolve })))
  const source = reactive({ apiBase: 'http://main', sessionId: '', folderId: 'first' })
  const active = ref(true)
  let state!: ReturnType<typeof useWorkdirGit>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = useWorkdirGit(() => source, active); return () => null },
  }))
  app.mount({})
  t.after(() => app.unmount())
  assert.equal(requests[0]!.url.pathname, '/api/folders/first/git/status')
  source.folderId = 'second'
  await nextTick()
  assert.equal(requests[0]!.signal.aborted, true)
  requests[1]!.finish(Response.json({ available: true, entries: [{ path: 'current.ts', status: 'modified' }] }))
  await new Promise(resolve => setImmediate(resolve))
  requests[0]!.finish(Response.json({ available: true, entries: [{ path: 'stale.ts', status: 'modified' }] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.status.value?.entries[0]!.path, 'current.ts')
  const pending = state.refresh()
  requests[2]!.finish(Response.json({ message: 'Git unavailable' }, { status: 503 }))
  await pending
  assert.equal(state.error.value, 'Git unavailable')
  assert.equal(state.status.value?.entries[0]!.path, 'current.ts')
  const recovered = state.refresh()
  requests[3]!.finish(Response.json({ available: false, reason: 'not_repository', entries: [] }))
  await recovered
  assert.equal(state.error.value, '', 'An ordinary folder clears any prior Git failure')
  assert.deepEqual(state.status.value, { available: false, reason: 'not_repository', entries: [] })
  const failedAgain = state.refresh()
  requests[4]!.finish(Response.json({ message: 'Git unavailable' }, { status: 503 }))
  await failedAgain
  assert.equal(state.error.value, 'Git unavailable', 'A real failure must remain visible after a non-repository result')
  void state.refresh()
  assert.equal(state.error.value, 'Git unavailable', 'Retain the error while retrying rather than flickering clean')
  active.value = false
  await nextTick()
  assert.equal(requests[5]!.signal.aborted, true)
  assert.equal(state.loading.value, false)
  source.folderId = 'third'
  await nextTick()
  assert.equal(requests.length, 6, 'Hidden workdirs must not start Git reads')
  assert.equal(state.status.value, undefined)
})

test('Git offline retry and reconnection do not leak results across projects or sources', async t => {
  const requests: { url: URL; signal: AbortSignal; finish: (response: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL, init?: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ url, signal: init!.signal!, finish: resolve })))
  const source = reactive({ apiBase: 'http://fixture/projects/one', sessionId: 'remote', folderId: '' })
  const active = ref(true)
  let state!: ReturnType<typeof useWorkdirGit>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = useWorkdirGit(() => source, active); return () => null },
  }))
  app.mount({})
  t.after(() => app.unmount())
  const offline = () => Response.json({ error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', workdirId: 'folder' }, { status: 503 })
  requests[0]!.finish(offline())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.offline.value, true)
  assert.equal(state.error.value, '')
  const retry = state.refresh()
  assert.equal(state.offline.value, true)
  requests[1]!.finish(Response.json({ available: true, entries: [] }))
  await retry
  assert.equal(state.offline.value, false)
  assert.equal(state.status.value?.available, true)
  void state.refresh()
  source.apiBase = 'http://fixture/projects/two'
  await nextTick()
  requests[2]!.finish(offline())
  requests[3]!.finish(Response.json({ error: 'remote_filesystem_failed' }, { status: 503 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.offline.value, false)
  assert.match(state.error.value, /Could not load Git/)
  assert.equal(state.status.value, undefined)
  assert.equal(requests[2]!.signal.aborted, true)
  void state.refresh()
  source.sessionId = 'another'
  await nextTick()
  requests[4]!.finish(Response.json({ available: true, entries: [{ path: 'previous.ts', status: 'modified' }] }))
  requests[5]!.finish(offline())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.offline.value, true)
  assert.equal(state.status.value, undefined)
})


test('shared Git reader coalesces requests, backs off, resets on change/refresh and disposes', async t => {
  const requests: { signal: AbortSignal; finish: (response: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (_url: URL, init?: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ signal: init!.signal!, finish: resolve })))
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let id = 0
  const readers = createWorkdirGitReaders({
    setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id },
    clearTimeout(timer) { timers.delete(timer as number) },
  })
  const source = { apiBase: 'http://fixture/projects/one/', sessionId: 'one', folderId: 'shared' }
  let revision = 0
  const first = readers.acquire(source, value => { revision = value.revision })
  const second = readers.acquire({ ...source, apiBase: 'http://fixture/projects/one', sessionId: 'two', sessionWorkspace: true }, () => {})
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const body = (changed = false) => Response.json({ available: true, entries: changed ? [{ path: 'a.ts', status: 'modified' }] : [] })
  const tick = (delay: number) => {
    assert.equal(timers.size, 1)
    const [key, timer] = [...timers][0]!
    assert.equal(timer.delay, delay)
    timers.delete(key)
    timer.callback()
  }
  assert.equal(requests.length, 1, 'folder identity ignores session and workspace flags')
  const manualDuringRead = second.refresh()
  assert.equal(requests.length, 1, 'explicit refresh joins the in-flight read')
  requests[0]!.finish(body())
  await manualDuringRead
  assert.equal(revision, 1)
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000].entries()) {
    tick(delay)
    requests[index + 1]!.finish(body())
    await flush()
    assert.equal(revision, index + 2, 'backed-off probes still detect content changes in already-modified files')
  }
  tick(60000)
  requests[6]!.finish(body(true))
  await flush()
  assert.equal(revision, 7)
  assert.equal([...timers.values()][0]!.delay, 5000, 'external change restores fast probing')
  const manual = first.refresh()
  assert.equal(timers.size, 0, 'manual refresh bypasses the scheduled probe')
  requests[7]!.finish(body(true))
  await manual
  assert.equal(revision, 8, 'explicit refresh invalidates diffs even with unchanged status')
  tick(5000)
  first.release()
  assert.equal(requests[8]!.signal.aborted, false, 'another active observer still owns the request')
  second.release()
  assert.equal(requests[8]!.signal.aborted, true)
  assert.equal(timers.size, 0)
  const fresh = readers.acquire(source, value => { assert.equal(value.error, '') })
  assert.equal(requests.length, 10, 'last-observer cleanup does not retain stale cache')
  requests[8]!.finish(body())
  await flush()
  assert.equal(timers.size, 0, 'late aborted completion cannot rearm polling')
  fresh.release()
  const otherProject = readers.acquire({ ...source, apiBase: 'http://fixture/projects/two' }, () => {})
  const otherHost = readers.acquire({ ...source, apiBase: 'http://other/projects/two' }, () => {})
  assert.equal(requests.length, 12, 'project and host identities never share')
  otherProject.release()
  otherHost.release()
})


test('document visibility suspends readers and resume performs a fresh read', async t => {
  const requests: AbortSignal[] = []
  t.mock.method(globalThis, 'fetch', (_url: URL, init?: RequestInit) => {
    requests.push(init!.signal!)
    return new Promise<Response>(() => {})
  })
  const events = new EventTarget()
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() {
      useWorkdirGit(() => ({ apiBase: 'http://visibility', sessionId: 's' }), ref(true))
      return () => null
    },
  }))
  app.mount({})
  t.after(() => app.unmount())
  assert.equal(requests.length, 1)
  documentStub.visibilityState = 'hidden'
  events.dispatchEvent(new Event('visibilitychange'))
  await nextTick()
  assert.equal(requests[0]!.aborted, true)
  documentStub.visibilityState = 'visible'
  events.dispatchEvent(new Event('visibilitychange'))
  await nextTick()
  assert.equal(requests.length, 2)
  app.unmount()
  assert.equal(requests[1]!.aborted, true)
  events.dispatchEvent(new Event('visibilitychange'))
  await nextTick()
  assert.equal(requests.length, 2, 'unmounted observers do not react to document events')
})
