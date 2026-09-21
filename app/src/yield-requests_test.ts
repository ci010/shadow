import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, reactive } from 'vue'
import { parseYieldResponse, useYieldRequest, yieldDeadlineText, type YieldSource } from './yield-requests.ts'

const question = (sessionId = 'web:root', id = 'question-1') => ({
  id, sessionId, question: 'Which approach should I use?',
  options: ['Minimal change', 'Full refactor', 'Leave unchanged'],
  defaultOption: 'Minimal change', recipient: { kind: 'user', sessionId },
  createdAt: '2026-09-13T12:00:00.000Z', deadline: null,
})
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness(t: TestContext, initial: Partial<YieldSource> = {}) {
  const requests: { url: string; init: RequestInit; finish: (response: Response) => void }[] = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) =>
    new Promise<Response>(resolve => requests.push({ url, init, finish: resolve })))
  const source = reactive({ apiBase: 'http://main', sessionId: 'web:root', active: true, stage: 'waiting', canAnswer: true, ...initial })
  let state!: ReturnType<typeof useYieldRequest>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = useYieldRequest(() => source); return () => null },
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { state, source, requests, app }
}

test('yield response validates session identity, two or three options, and one default', () => {
  assert.deepEqual(parseYieldResponse({ request: question() }, 'web:root'), question())
  assert.equal(parseYieldResponse({ request: null }, 'web:root'), null)
  for (const invalid of [
    {}, { request: undefined }, { request: question('web:other') },
    { request: { ...question(), options: ['One'] } },
    { request: { ...question(), options: ['One', 'One', 'Three'] } },
    { request: { ...question(), defaultOption: 'Other' } },
    { request: { ...question(), recipient: { kind: 'parent', sessionId: 'web:root' } } },
    { request: { ...question(), deadline: 'not a date' } },
  ]) assert.throws(() => parseYieldResponse(invalid, 'web:root'))
})

test('direct choice helper submits exactly the requested option and blocks duplicate writes', async t => {
  const { state, requests } = harness(t)
  const binary = { ...question(), options: ['Yes', 'No'], defaultOption: 'No' }
  requests[0]!.finish(Response.json({ request: binary }))
  await settle()
  assert.equal(requests.length, 1, 'Rendering the default never submits it')
  assert.equal(await state.choose('Not offered'), false)
  const answer = state.choose('Yes')
  assert.equal(await state.choose('No'), false)
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { requestId: binary.id, option: 'Yes' })
  requests[1]!.finish(Response.json({ answer: {
    requestId: binary.id, option: 'Yes', answeredBy: 'user', answeredAt: new Date().toISOString(),
  } }))
  assert.equal(await answer, true)
  assert.equal(state.request.value, null)
})

test('custom responses survive polling and rejection, require explicit confirmation and block duplicate answers', async t => {
  const { state, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  state.customMode.value = true
  for (const invalid of ['', ' \n ', 'x'.repeat(4001)]) {
    state.customText.value = invalid
    assert.equal(await state.submit(), false)
    assert.match(state.error.value, /1 to 4000/)
    assert.equal(requests.length, 1)
  }
  state.customText.value = '  My approach\nwith details  '
  const refresh = state.refresh()
  requests[1]!.finish(Response.json({ request: question() }))
  await refresh
  assert.equal(state.customMode.value, true)
  assert.equal(state.customText.value, '  My approach\nwith details  ')
  const rejected = state.submit()
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), { requestId: 'question-1', customText: 'My approach\nwith details' })
  assert.equal(await state.submit(), false)
  assert.equal(await state.choose('Minimal change'), false)
  requests[2]!.finish(Response.json({ error: 'unavailable', message: 'Retry later.' }, { status: 503 }))
  assert.equal(await rejected, false)
  assert.equal(state.customText.value, '  My approach\nwith details  ')
  const receipt = { requestId: 'question-1', option: 'My approach\nwith details', answeredBy: 'user', answeredAt: new Date().toISOString() }
  const unconfirmed = state.submit()
  requests[3]!.finish(Response.json({ answer: receipt }))
  assert.equal(await unconfirmed, false)
  assert.match(state.error.value, /did not confirm/)
  const confirmed = state.submit()
  requests[4]!.finish(Response.json({ answer: { ...receipt, custom: true } }))
  assert.equal(await confirmed, true)
  assert.equal(state.customMode.value, false)
  assert.equal(state.customText.value, '')
  assert.equal(state.request.value, null)
})

test('custom drafts clear when the request disappears or changes, access is revoked, or the session changes', async t => {
  const { state, source, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  const draft = () => { state.customMode.value = true; state.customText.value = 'Private to this question' }
  draft()
  const missing = state.refresh()
  requests.at(-1)!.finish(Response.json({ request: null }))
  await missing
  assert.equal(state.request.value, null)
  assert.equal(state.customMode.value, false)
  assert.equal(state.customText.value, '')
  const restored = state.refresh()
  requests.at(-1)!.finish(Response.json({ request: question() }))
  await restored
  draft()
  const next = state.refresh()
  requests.at(-1)!.finish(Response.json({ request: question('web:root', 'question-2') }))
  await next
  assert.equal(state.customText.value, '')
  draft()
  source.canAnswer = false
  assert.equal(state.customText.value, '')
  assert.equal(await state.submit(), false)
  source.canAnswer = true
  draft()
  source.sessionId = 'web:other'
  assert.equal(state.customMode.value, false)
  assert.equal(state.customText.value, '')
})

test('direct presets can still be selected after opening custom entry', async t => {
  const { state, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  state.customMode.value = true
  state.customText.value = 'Unsent custom draft'
  const answer = state.choose('Minimal change')
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { requestId: 'question-1', option: 'Minimal change' })
  requests[1]!.finish(Response.json({ answer: {
    requestId: 'question-1', option: 'Minimal change', answeredBy: 'user', answeredAt: new Date().toISOString(),
  } }))
  assert.equal(await answer, true)
  assert.equal(state.customText.value, '')
})

test('only visible waiting sessions fetch and stale session responses cannot appear', async t => {
  const { source, state, requests } = harness(t, { stage: 'tool' })
  assert.equal(requests.length, 0)
  source.stage = 'waiting'
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.url, 'http://main/api/sessions/web%3Aroot/yield')
  source.sessionId = 'web:second'
  assert.equal(requests[0]!.init.signal!.aborted, true)
  requests[1]!.finish(Response.json({ request: question('web:second') }))
  await settle()
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  assert.equal(state.request.value?.sessionId, 'web:second')
  assert.equal(state.selected.value, 'Minimal change')
  source.active = false
  assert.equal(state.request.value === null, true)
  source.sessionId = 'web:third'
  assert.equal(requests.length, 2)
  source.active = true
  assert.equal(requests.length, 3)
  source.stage = 'idle'
  assert.equal(requests[2]!.init.signal!.aborted, true)
  assert.equal(state.request.value === null, true)
})

test('preselection and expired deadlines never submit; selections survive refresh and rejection', async t => {
  const { state, requests } = harness(t)
  const expired = { ...question(), deadline: '2026-09-13T12:00:01.000Z' }
  requests[0]!.finish(Response.json({ request: expired }))
  await settle()
  assert.equal(state.selected.value, expired.defaultOption)
  assert.match(yieldDeadlineText(state.request.value!, Date.parse('2026-09-13T13:00:00Z')), /Waiting for the server/)
  assert.match(yieldDeadlineText(state.request.value!, Date.parse('2026-09-13T11:00:00Z')), /server will choose the default/)
  assert.match(yieldDeadlineText(question() as never, Date.now()), /No time limit/)
  assert.equal(requests.length, 1)
  state.selected.value = 'Full refactor'
  const refresh = state.refresh()
  requests[1]!.finish(Response.json({ request: expired }))
  await refresh
  assert.equal(state.selected.value, 'Full refactor')
  const submit = state.submit()
  assert.deepEqual(JSON.parse(requests[2]!.init.body as string), { requestId: expired.id, option: 'Full refactor' })
  requests[2]!.finish(Response.json({ error: 'conflict', message: 'Another response arrived.' }, { status: 409 }))
  await submit
  assert.equal(state.selected.value, 'Full refactor')
  assert.equal(state.request.value?.id, expired.id)
  assert.match(state.error.value, /Another response arrived.*Reload/)
  const retryRead = state.refresh()
  requests[3]!.finish(Response.json({ request: expired }))
  await retryRead
  assert.match(state.error.value, /Another response arrived/, 'background success must not hide a rejected answer')
})

test('parent and permission-limited requests remain read-only', async t => {
  const { state, source, requests } = harness(t, { canAnswer: false })
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  assert.equal(state.answerable.value, false)
  await state.submit()
  assert.equal(await state.cancelQuestion(), false)
  assert.equal(requests.length, 1)
  source.canAnswer = true
  assert.equal(requests.length, 1, 'permission updates must not clear or refetch the current question')
  assert.equal(state.answerable.value, true)
  const refresh = state.refresh()
  requests[1]!.finish(Response.json({ request: { ...question(), recipient: { kind: 'parent', sessionId: 'web:parent' } } }))
  await refresh
  assert.equal(state.answerable.value, false)
  await state.submit()
  assert.equal(await state.cancelQuestion(), false)
  assert.equal(requests.length, 2)
})

test('identity, visibility and permission changes cancel pending answers without touching the next question', async t => {
  const { state, source, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  const submit = state.submit()
  source.sessionId = 'web:next'
  assert.equal(requests[1]!.init.signal!.aborted, true)
  assert.equal(state.request.value === null, true)
  requests[2]!.finish(Response.json({ request: { ...question('web:next', 'question-2'), defaultOption: 'Leave unchanged' } }))
  await settle()
  requests[1]!.finish(Response.json({ answer: { requestId: 'question-1', option: 'Minimal change', answeredBy: 'user', answeredAt: new Date().toISOString() } }))
  await submit
  assert.equal(state.request.value?.id, 'question-2')
  assert.equal(state.selected.value, 'Leave unchanged')
  const otherSubmit = state.submit()
  source.canAnswer = false
  assert.equal(requests[3]!.init.signal!.aborted, true)
  requests[3]!.finish(Response.json({ error: 'forbidden' }, { status: 403 }))
  await otherSubmit
  assert.equal(state.error.value, '')
  source.canAnswer = true
  void state.submit()
  source.active = false
  assert.equal(requests[4]!.init.signal!.aborted, true)
  assert.equal(state.submitting.value, false)
})

test('successful answers require confirmation and do not reappear from a delayed snapshot', async t => {
  const { state, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  const invalid = state.submit()
  requests[1]!.finish(Response.json({ success: true }))
  await invalid
  assert.match(state.error.value, /did not confirm/)
  assert.equal(state.request.value?.id, 'question-1')
  const submit = state.submit()
  requests[2]!.finish(Response.json({ answer: { requestId: 'question-1', option: 'Minimal change', answeredBy: 'user', answeredAt: new Date().toISOString() } }))
  await submit
  assert.equal(state.request.value === null, true)
  assert.equal(state.error.value, '')
  const refresh = state.refresh()
  requests[3]!.finish(Response.json({ request: question() }))
  await refresh
  assert.equal(state.request.value === null, true)
  const next = state.refresh()
  requests[4]!.finish(Response.json({ request: { ...question('web:root', 'question-2'), defaultOption: 'Leave unchanged' } }))
  await next
  assert.equal(state.selected.value, 'Leave unchanged')
})

test('HTTP failures are actionable, with no fake successful fallback', async t => {
  const { state, requests } = harness(t)
  requests[0]!.finish(Response.json({ error: 'not_found' }, { status: 404 }))
  await settle()
  assert.match(state.error.value, /does not support yield/)
  for (const status of [400, 403, 409, 503]) {
    const pending = state.refresh()
    requests.at(-1)!.finish(Response.json({ error: 'failure', message: `Failure ${status}.` }, { status }))
    await pending
    assert.match(state.error.value, new RegExp(`Failure ${status}`))
    assert.equal(state.request.value, null)
  }
})

test('explicit cancellation sends only the nonce, excludes answers and requires server confirmation', async t => {
  const { state, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  state.selected.value = 'Full refactor'
  const invalid = state.cancelQuestion()
  assert.equal(state.cancelling.value, true)
  assert.equal(state.busy.value, true)
  assert.equal(requests[1]!.init.method, 'DELETE')
  assert.deepEqual(JSON.parse(requests[1]!.init.body as string), { requestId: 'question-1' })
  assert.equal(await state.submit(), false)
  assert.equal(await state.cancelQuestion(), false)
  assert.equal(requests.length, 2)
  requests[1]!.finish(Response.json({ cancelled: false }))
  assert.equal(await invalid, false)
  assert.match(state.error.value, /did not confirm cancellation/)
  assert.equal(state.selected.value, 'Full refactor')
  assert.equal(state.request.value?.id, 'question-1')
  const rejected = state.cancelQuestion()
  requests[2]!.finish(Response.json({ error: 'conflict', message: 'Stale question.' }, { status: 409 }))
  assert.equal(await rejected, false)
  assert.match(state.error.value, /Stale question.*Reload/)
  assert.equal(state.selected.value, 'Full refactor')
  const cancelled = state.cancelQuestion()
  requests[3]!.finish(Response.json({ cancelled: true }))
  assert.equal(await cancelled, true)
  assert.equal(state.request.value === null, true)
  assert.equal(state.selected.value, '')
  assert.equal(state.busy.value, false)
  const reload = state.refresh()
  requests[4]!.finish(Response.json({ request: question() }))
  await reload
  assert.equal(state.request.value === null, true, 'An old snapshot must not restore an explicitly cancelled question')
  assert.equal(requests.some(item => item.init.method === 'POST'), false)
})

test('hidden or unmounted UI never cancels the task; reopening retrieves the pending question', async t => {
  const { state, source, requests, app } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  source.active = false
  assert.equal(requests.length, 1)
  source.active = true
  requests[1]!.finish(Response.json({ request: question() }))
  await settle()
  assert.equal(state.request.value?.id, 'question-1')
  assert.equal(state.selected.value, 'Minimal change')
  app.unmount()
  assert.equal(requests.length, 2)
  assert.equal(requests.some(item => item.init.method === 'DELETE'), false)
})

test('stale cancellation results cannot clear a new session or revoke its selection', async t => {
  const { state, source, requests } = harness(t)
  requests[0]!.finish(Response.json({ request: question() }))
  await settle()
  const cancellation = state.cancelQuestion()
  source.sessionId = 'web:next'
  assert.equal(requests[1]!.init.signal!.aborted, true)
  requests[2]!.finish(Response.json({ request: { ...question('web:next', 'question-2'), defaultOption: 'Leave unchanged' } }))
  await settle()
  requests[1]!.finish(Response.json({ cancelled: true }))
  assert.equal(await cancellation, false)
  assert.equal(state.request.value?.id, 'question-2')
  assert.equal(state.selected.value, 'Leave unchanged')
  assert.equal(state.cancelling.value, false)
  const forbidden = state.cancelQuestion()
  source.canAnswer = false
  assert.equal(requests[3]!.init.signal!.aborted, true)
  requests[3]!.finish(Response.json({ cancelled: true }))
  assert.equal(await forbidden, false)
  assert.equal(state.request.value?.id, 'question-2')
})
