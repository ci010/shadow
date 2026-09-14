import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, nextTick, reactive, ref } from 'vue'
import { useWorkdirGit } from './composables/useWorkdirGit.ts'

test('Git polling cancels old identities and hidden panes, preserving explicit failure state', async t => {
  const requests: { url: URL; signal: AbortSignal; finish: (response: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: URL, init?: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ url, signal: init!.signal!, finish: resolve })))
  const source = reactive({ apiBase: 'http://main', sessionId: '', projectId: 'first' })
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
  assert.equal(requests[0]!.url.pathname, '/api/projects/first/git/status')
  source.projectId = 'second'
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
  void state.refresh()
  assert.equal(state.error.value, 'Git unavailable', 'Retain the error while retrying rather than flickering clean')
  active.value = false
  await nextTick()
  assert.equal(requests[3]!.signal.aborted, true)
  assert.equal(state.loading.value, false)
  source.projectId = 'third'
  await nextTick()
  assert.equal(requests.length, 4, 'Hidden workdirs must not start Git reads')
  assert.equal(state.status.value, undefined)
})
