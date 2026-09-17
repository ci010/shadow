import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, nextTick, reactive, ref } from 'vue'
import { useWorkdirGit } from './composables/useWorkdirGit.ts'

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
  const offline = () => Response.json({ error: 'workdir_unavailable', reason: 'node-offline', nodeId: 'child', capabilityId: 'folder' }, { status: 503 })
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
