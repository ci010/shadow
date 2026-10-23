import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, reactive } from 'vue'
import { parseComputerStatus, useComputer, type ComputerSource } from './computer-use.ts'

const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const observationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const target = { id: targetId, title: 'Synthetic application', app: 'fixture', pid: 42, bounds: { x: 0, y: 0, width: 500, height: 300 } }
const makeStatus = (shared = false, pending = false) => ({
  projectId: 'project-a', sessionId: 'web:fixture', available: true, busy: false,
  grant: shared ? { target, expiresAt: new Date(Date.now() + 600_000).toISOString() } : null,
  pending: pending ? { id: requestId, targetId, observationId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    action: { kind: 'set_value', elementId: '0', value: 'Synthetic value' }, element: { name: 'Input', role: 'ControlType.Edit' } } : null,
  executing: false, lastAction: null,
})
const makePointerStatus = () => ({
  ...makeStatus(true),
  pending: { ...makeStatus(true, true).pending!, action: { kind: 'drag', x: 10, y: 20, toX: 100, toY: 200 },
    element: null, frame: { width: 500, height: 300 } },
})
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness(t: TestContext) {
  const requests: Array<{ url: string; init: RequestInit; finish: (response: Response) => void; reject: (error: Error) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) =>
    new Promise<Response>((finish, reject) => requests.push({ url, init, finish, reject })))
  const source = reactive<ComputerSource>({
    apiBase: 'http://127.0.0.1:3123/projects/project-a', projectId: 'project-a', sessionId: 'web:fixture',
    active: true, canSubmit: true, stage: 'tool',
  })
  let state!: ReturnType<typeof useComputer>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({ setup() { state = useComputer(() => source); return () => null } }))
  app.mount({})
  t.after(() => app.unmount())
  return { requests, source, state }
}

test('desktop status is scoped and refuses mismatched target reviews', () => {
  assert.deepEqual(parseComputerStatus(makeStatus(), makeStatus()), makeStatus())
  assert.throws(() => parseComputerStatus({ ...makeStatus(), projectId: 'other' }, makeStatus()), /scope/)
  assert.throws(() => parseComputerStatus(makeStatus(false, true), makeStatus()), /target/)
  assert.throws(() => parseComputerStatus({ ...makeStatus(), rawScreenshot: 'private' }, makeStatus()))
})

test('status discovery never enumerates or shares windows', async t => {
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true)))
  await settle()
  assert.equal(requests.length, 1)
  assert.equal('findWindows' in state, false)
  assert.equal('share' in state, false)
})

test('passive availability failures stay silent and tool-stage discovery can recover', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { state, requests } = harness(t)
  requests[0].finish(new Response(null, { status: 503 }))
  await settle()
  assert.equal(state.error.value, '')
  assert.equal(state.needsReload.value, false)
  t.mock.timers.tick(1000)
  requests[1].finish(Response.json(makeStatus()))
  await settle()
  assert.equal(state.error.value, '')
  assert.equal(state.status.value?.available, true)
})

test('status failures during shared desktop access remain visible even with collapsed controls', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true)))
  await settle()
  t.mock.timers.tick(1000)
  assert.equal(requests.length, 2)
  requests[1].reject(new Error('offline'))
  await settle()
  assert.match(state.error.value, /Could not load computer use/)
  assert.equal(state.needsReload.value, true)
})

test('approval submits only the immutable request ID and decision, not a replacement action', async t => {
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true, true)))
  await settle()
  const approval = state.decide(true)
  assert.match(requests[1].url, new RegExp(`/decisions/${requestId}$`))
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), { approved: true })
  requests[1].finish(Response.json({ accepted: true, requestId }))
  await settle()
  requests[2].finish(Response.json(makeStatus(true)))
  assert.equal(await approval, true)
  assert.equal(state.status.value?.pending, null)
})

test('an uncertain decision requires reload and Stop remains available during a write', async t => {
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true, true)))
  await settle()
  const approval = state.decide(true)
  const stop = state.stop()
  assert.equal(requests[1].init.signal?.aborted, true)
  assert.match(requests[2].url, /\/api\/computer\/stop$/)
  requests[1].reject(new Error('aborted'))
  assert.equal(await approval, false)
  requests[2].finish(Response.json({ stopped: true }))
  await settle()
  requests[3].finish(Response.json(makeStatus()))
  assert.equal(await stop, true)
  assert.equal(state.status.value?.grant, null)
})

test('failed decisions are not retried and do not render server payloads', async t => {
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true, true)))
  await settle()
  const approval = state.decide(true)
  requests[1].finish(Response.json({ error: 'PRIVATE SERVER DATA' }, { status: 500 }))
  assert.equal(await approval, false)
  assert.equal(state.needsReload.value, true)
  assert.doesNotMatch(state.error.value, /PRIVATE/)
  assert.equal(await state.decide(true), false)
  assert.equal(requests.length, 2)
})

test('session changes abort old writes and cannot import their approvals into another conversation', async t => {
  const { state, requests, source } = harness(t)
  requests[0].finish(Response.json(makeStatus(true, true)))
  await settle()
  const approval = state.decide(true)
  source.sessionId = 'web:other'
  assert.equal(requests[1].init.signal?.aborted, true)
  assert.equal(state.status.value, null)
  requests[1].finish(Response.json({ accepted: true, requestId }))
  assert.equal(await approval, false)
  requests[2].finish(Response.json({ ...makeStatus(), sessionId: 'web:other' }))
  await settle()
  assert.equal(state.status.value?.sessionId, 'web:other')
  source.active = false
  assert.equal(state.status.value, null)
})

test('foreground reviews require a matching target and structurally consistent exact frames', () => {
  const value = makePointerStatus()
  assert.equal(parseComputerStatus(value, value).pending?.action.kind, 'drag')
  assert.throws(() => parseComputerStatus({ ...value, pending: { ...value.pending, frame: undefined } }, value), /frame/)
  assert.throws(() => parseComputerStatus({ ...value, pending: { ...value.pending, element: { name: 'Wrong', role: 'ControlType.Edit' } } }, value), /frame/)
  assert.throws(() => parseComputerStatus({ ...value, pending: { ...value.pending, action: { kind: 'move', x: 500, y: 0 } } }, value), /outside frame/)
})

test('coordinate approval waits for the exact decoded image and revokes its Blob URL on decision', async t => {
  const { state, requests } = harness(t)
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', () => 'blob:synthetic-frame')
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  requests[0].finish(Response.json(makePointerStatus()))
  await settle()
  assert.match(requests[1].url, new RegExp(`/decisions/${requestId}/frame$`))
  assert.equal(requests[1].init.cache, 'no-store')
  assert.equal(requests[1].init.redirect, 'error')
  assert.equal(await state.decide(true), false)
  requests[1].finish(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }))
  await settle()
  assert.equal(state.frameState.value, 'loading')
  assert.equal(state.canApprove.value, false)
  state.frameLoaded('blob:not-the-review', 500, 300)
  assert.equal(state.canApprove.value, false)
  state.frameLoaded(state.frameUrl.value, 500, 300)
  assert.equal(state.canApprove.value, true)
  const decision = state.decide(true)
  assert.equal(state.frameUrl.value, '')
  assert.deepEqual(revoked, ['blob:synthetic-frame'])
  requests[2].finish(Response.json({ accepted: true, requestId }))
  await settle()
  requests[3].finish(Response.json(makeStatus(true)))
  assert.equal(await decision, true)
})

test('failed or incorrectly sized images disable approval without preventing rejection', async t => {
  const { state, requests } = harness(t)
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', () => 'blob:wrong-size')
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  requests[0].finish(Response.json(makePointerStatus()))
  await settle()
  requests[1].finish(Response.json({ error: 'PRIVATE IMAGE ERROR' }, { status: 500 }))
  await settle()
  assert.equal(state.frameState.value, 'error')
  assert.equal(state.needsReload.value, false)
  assert.equal(await state.decide(true), false)
  assert.doesNotMatch(state.error.value, /PRIVATE/)
  const reload = state.reloadFrame()
  requests[2].finish(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }))
  await reload
  state.frameLoaded(state.frameUrl.value, 1, 1)
  assert.equal(state.frameState.value, 'error')
  assert.equal(state.frameUrl.value, '')
  assert.deepEqual(revoked, ['blob:wrong-size'])
  const denial = state.decide(false)
  assert.deepEqual(JSON.parse(String(requests[3].init.body)), { approved: false })
  requests[3].finish(Response.json({ accepted: true, requestId }))
  await settle()
  requests[4].finish(Response.json(makeStatus(true)))
  assert.equal(await denial, true)
})

test('late frame reads cannot cross conversations and an inactive view drops its loaded review', async t => {
  const { state, requests, source } = harness(t)
  let created = 0
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', () => `blob:frame-${++created}`)
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  requests[0].finish(Response.json(makePointerStatus()))
  await settle()
  source.sessionId = 'web:other'
  assert.equal(requests[1].init.signal?.aborted, true)
  requests[1].finish(new Response(new Uint8Array([137]), { headers: { 'content-type': 'image/png' } }))
  requests[2].finish(Response.json({ ...makePointerStatus(), sessionId: 'web:other' }))
  await settle()
  assert.equal(created, 0)
  requests[3].finish(new Response(new Uint8Array([137]), { headers: { 'content-type': 'image/png' } }))
  await settle()
  assert.equal(created, 1)
  source.active = false
  assert.equal(state.frameUrl.value, '')
  assert.deepEqual(revoked, ['blob:frame-1'])
})

test('review expiry drops its image and cannot leave an enabled approval button', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  const { state, requests } = harness(t)
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', () => 'blob:expiring-frame')
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  requests[0].finish(Response.json(makePointerStatus()))
  await settle()
  requests[1].finish(new Response(new Uint8Array([137]), { headers: { 'content-type': 'image/png' } }))
  await settle()
  state.frameLoaded(state.frameUrl.value, 500, 300)
  assert.equal(state.canApprove.value, true)
  t.mock.timers.tick(60_001)
  assert.equal(state.remaining.value, 0)
  assert.equal(state.frameUrl.value, '')
  assert.equal(await state.decide(true), false)
  assert.deepEqual(revoked, ['blob:expiring-frame'])
})


test('release removes desktop access without leaving a manual setup state', async t => {
  const { state, requests } = harness(t)
  requests[0].finish(Response.json(makeStatus(true)))
  await settle()
  const release = state.refresh()
  requests[1].finish(Response.json(makeStatus()))
  await release
  assert.equal(state.status.value?.grant, null)
  assert.equal('enableForeground' in state, false)
  assert.equal('expanded' in state, false)
})
