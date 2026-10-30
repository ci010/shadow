import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, reactive } from 'vue'
import { parsePublicationResponse, parsePublicationRequests, visiblePublicationRequests, usePublicationRequest, type PublicationSource } from './publication-requests.ts'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const revision = `sha256:${'a'.repeat(64)}`
const baseRevision = `sha256:${'b'.repeat(64)}`
const proposal = (projectId = 'a', requestId = id) => ({
  id: requestId, projectId, sessionId: 'web:chat-admin', revision, baseRevision,
  createdAt: '2026-09-18T05:00:00.000Z',
  files: [{ path: 'agents/support/AGENT.md', before: null, after: 'Read only.' }],
  previousBindings: [], bindings: [],
})
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness(t: TestContext, initial: Partial<PublicationSource> = {}) {
  const calls: Array<{ url: string; init: RequestInit; finish: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) =>
    new Promise<Response>(finish => calls.push({ url, init, finish })))
  const source = reactive({
    apiBase: 'http://127.0.0.1/projects/a', projectId: 'a', sessionId: 'web:chat-admin',
    active: true, canSubmit: true, stage: 'idle', ...initial,
  })
  let state!: ReturnType<typeof usePublicationRequest>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = usePublicationRequest(() => source); return () => null },
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { source, state, calls }
}

test('publication reviews enforce Project/session ownership and validate the exact wire envelope', () => {
  assert.deepEqual(parsePublicationResponse({ request: proposal() }, 'a'), proposal())
  assert.equal(parsePublicationResponse({ request: null }, 'a'), null)
  for (const value of [
    {}, { request: undefined }, { request: proposal('b') }, { request: proposal(), extra: true },
    { request: { ...proposal(), sessionId: 'qq:other' } },
    { request: { ...proposal(), revision: 'different' } },
  ]) assert.throws(() => parsePublicationResponse(value, 'a'))
})

test('only active owners fetch, including topics and idle after propose, without ever auto-approving', async t => {
  const { source, state, calls } = harness(t, { canSubmit: false })
  assert.equal(calls.length, 0)
  source.canSubmit = true
  assert.equal(calls.length, 1)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  assert.equal(state.request.value?.id, id)
  assert.equal(calls.length, 1)
  source.active = false
  assert.equal(state.request.value, null)
  source.sessionId = 'web:chat-ordinary'
  source.active = true
  assert.equal(calls.length, 2)
  calls[1]!.finish(Response.json({ request: proposal() }))
  await settle()
  assert.equal(state.request.value, null, 'Topics cannot see legacy admin-only proposals')
})

test('multi-review envelope rejects duplicate IDs and legacy mismatch; topics see only their changes', () => {
  const first = { ...proposal(), change: { id: 'change-a', title: 'Support prompts', sourceSessionId: 'web:topic' } }
  const second = { ...proposal('a', 'second'), change: { id: 'change-b', title: 'Connection access', sourceSessionId: 'web:other' } }
  const requests = parsePublicationRequests({ request: first, requests: [first, second] }, 'a')
  assert.deepEqual(visiblePublicationRequests(requests, 'web:topic'), [first])
  assert.deepEqual(visiblePublicationRequests(requests, 'web:chat-admin'), requests)
  for (const value of [
    { request: first, requests: [first, first] }, { request: second, requests: [first, second] },
    { request: null, requests: [first] }, { request: first, requests: [proposal('b')] },
  ]) assert.throws(() => parsePublicationRequests(value, 'a'))
})

test('topic approves its own change in place and a waiting receipt cannot be approved again', async t => {
  const { state, calls } = harness(t, { sessionId: 'web:topic' })
  const own = { ...proposal(), change: { id: 'change-a', title: 'Support prompts', sourceSessionId: 'web:topic' } }
  const other = { ...proposal('a', 'other'), change: { id: 'change-b', title: 'Other', sourceSessionId: 'web:other' } }
  calls[0]!.finish(Response.json({ request: own, requests: [own, other] }))
  await settle()
  assert.equal(state.requests.value.length, 1)
  const write = state.confirm()
  calls[1]!.finish(Response.json({ result: { requestId: id, revision, status: 'waiting' } }))
  assert.equal(await write, true)
  assert.equal(state.request.value?.status, 'waiting')
  assert.equal(await state.confirm(), false)
  const refresh = state.refresh()
  calls[2]!.finish(Response.json({ request: own, requests: [own] }))
  await refresh
  await settle()
  assert.equal(state.request.value?.status, 'waiting', 'Delayed snapshots cannot repeat recorded approval')
})

test('a passive read overlapping a decision cannot resurrect the old review', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const refresh = state.refresh()
  const write = state.confirm()
  assert.equal(calls[1]!.init.signal!.aborted, false, 'Shared HTTP remains available to other panes; local read consumption is cancelled')
  calls[2]!.finish(Response.json({ result: { requestId: id, revision, status: 'published' } }))
  assert.equal(await write, true)
  calls[1]!.finish(Response.json({ request: proposal() }))
  await settle()
  calls[3]!.finish(Response.json({ request: null }))
  await refresh
  await settle()
  assert.equal(state.request.value, null)
})

test('confirmation is dedicated, revision-bound, explicit and single-flight', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const answer = state.confirm()
  assert.equal(await state.confirm(), false)
  assert.equal(await state.cancel(), false)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.url, `http://127.0.0.1/projects/a/api/agent-resources/publication-requests/${id}`)
  assert.equal(calls[1]!.init.method, 'POST')
  assert.equal(calls[1]!.init.redirect, 'error')
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { revision, baseRevision })
  calls[1]!.finish(Response.json({ result: { requestId: id, revision, status: 'published' } }))
  assert.equal(await answer, true)
  assert.equal(state.request.value, null)
  assert.match(state.notice.value, /published/)
  const refresh = state.refresh()
  calls[2]!.finish(Response.json({ request: proposal() }))
  await refresh
  await settle()
  assert.equal(state.request.value, null, 'A delayed snapshot cannot restore the approved proposal')
})

test('cancellation returns a matching receipt and never invokes chat or a generic yield answer', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const answer = state.cancel()
  assert.equal(calls[1]!.init.method, 'DELETE')
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { revision, baseRevision })
  calls[1]!.finish(Response.json({ result: { requestId: id, revision, status: 'cancelled' } }))
  assert.equal(await answer, true)
  assert.match(state.notice.value, /cancelled.*draft is unchanged/)
  assert.equal(calls.length, 3, 'Successful writes refresh the shared snapshot')
})

test('stale revisions and uncertain results require explicit reload instead of repeating authorization', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const answer = state.confirm()
  calls[1]!.finish(Response.json({ error: 'stale' }, { status: 409 }))
  assert.equal(await answer, false)
  assert.equal(state.needsReload.value, true)
  assert.match(state.error.value, /changed or was already resolved/)
  assert.equal(await state.confirm(), false)
  const refresh = state.refresh()
  calls[2]!.finish(Response.json({ request: null }))
  await refresh
  await settle()
  assert.equal(state.request.value, null, 'A closed proposal cannot remain actionable')
  assert.equal(state.needsReload.value, true)
  const reload = state.reload()
  calls[3]!.finish(Response.json({ request: null }))
  await reload
  assert.equal(state.needsReload.value, false)
  assert.match(state.notice.value, /inspect the published revision/)
})

test('permission loss and Project switches abort pending writes and ignore late results', async t => {
  const { source, state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const write = state.confirm()
  source.canSubmit = false
  assert.equal(calls[1]!.init.signal!.aborted, true)
  source.projectId = 'b'
  source.apiBase = 'http://127.0.0.1/projects/b'
  source.canSubmit = true
  calls[2]!.finish(Response.json({ request: proposal('b') }))
  await settle()
  calls[1]!.finish(Response.json({ result: { requestId: id, revision, status: 'published' } }))
  assert.equal(await write, false)
  assert.equal(state.request.value?.projectId, 'b')
  assert.equal(state.notice.value, '')
})

test('mismatched success receipts are errors, never publication confirmations', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ request: proposal() }))
  await settle()
  const write = state.confirm()
  calls[1]!.finish(Response.json({ result: { requestId: id, revision: baseRevision, status: 'published' } }))
  assert.equal(await write, false)
  assert.equal(state.notice.value, '')
  assert.match(state.error.value, /Could not confirm/)
})

test('group approval surface selects only affected exact Bot/platform/conversation and resets stale reads on target changes', async t => {
  const conversation = { botInstanceId: 'bot-a', platform: 'qq', conversationId: 'group:1' }
  const { source, state, calls } = harness(t, { conversation })
  const affected = { ...proposal(), impact: { affectedBindings: [JSON.stringify(['bot-a', 'qq', 'group:1'])], permissionsChanged: true, promptsChanged: true, toolsChanged: true } }
  const sibling = { ...proposal('a', 'sibling'), impact: { affectedBindings: [JSON.stringify(['bot-b', 'qq', 'group:1'])], permissionsChanged: true, promptsChanged: false, toolsChanged: false } }
  calls[0].finish(Response.json({ request: affected, requests: [affected, sibling] }))
  await settle()
  assert.deepEqual(state.requests.value.map(item => item.id), [id])
  source.conversation = { botInstanceId: 'bot-b', platform: 'qq', conversationId: 'group:1' }
  assert.equal(state.request.value, null)
  calls[1].finish(Response.json({ request: affected, requests: [affected, sibling] }))
  await settle()
  assert.deepEqual(state.requests.value.map(item => item.id), ['sibling'])
  assert.equal(calls.some(call => call.init.method === 'POST'), false)
})
