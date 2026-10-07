import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createChatRequestControl, resumeChatRequest } from './chat-request-control.ts'
import { parseActiveRequestIds } from './session-activity.ts'
import { Hono } from 'hono'
import { sessionsApiPlugin } from '../../src/sessions/routes.ts'
import type { SessionManager } from '../../src/sessions/session-manager.ts'

function fixture(sessionId = '', requestId: string | undefined = 'request-one') {
  let aborted = false
  const calls: Array<{ url: string; init?: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = []
  const request: typeof fetch = async (url, init) => {
    const pending = Promise.withResolvers<Response>()
    calls.push({ url: String(url), init, ...pending })
    return pending.promise
  }
  const control = createChatRequestControl('http://main/orgs/one', () => { aborted = true }, request, sessionId, requestId)
  return { control, calls, request, aborted: () => aborted }
}

test('a draft can be stopped before an identity or message submission without a server cancel', async () => {
  const f = fixture()
  await f.control.stop()
  assert.equal(f.aborted(), true)
  assert.equal(f.control.state.phase, 'finished')
  assert.equal(f.calls.length, 0)
})

test('stop during admission waits for the POST, then cancels its captured logical session', async () => {
  const f = fixture()
  f.control.submitting('web:chat-one')
  await f.control.stop()
  await f.control.stop()
  assert.equal(f.aborted(), false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.control.state.stopping, true)
  f.control.admitted('request-one')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.url, 'http://main/orgs/one/api/sessions/web%3Achat-one/cancel')
  assert.equal(f.calls[0]!.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init?.body)), { requestId: 'request-one' })
  assert(f.calls[0]!.init?.signal)
  f.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'requested' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.control.state.phase, 'active')
  assert.equal(f.control.state.stopping, true)
  assert.equal(f.aborted(), false)
  f.control.finish()
  assert.equal(f.control.state.stopping, false)
})

test('stop acknowledgement waits for completion, and double clicks do not repeat cancellation', async () => {
  const f = fixture('web:chat-one')
  const stopping = f.control.stop()
  await f.control.stop()
  assert.equal(f.calls.length, 1)
  f.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'requested' }))
  await stopping
  assert.equal(f.control.state.phase, 'active')
  assert.equal(f.control.state.stopping, true)
  assert.equal(f.aborted(), false)
  f.control.finish()
  await f.control.stop()
  assert.equal(f.calls.length, 1)
})

test('an already idle response confirms completion without aborting the stream reader', async () => {
  const f = fixture('web:chat-one')
  const stopping = f.control.stop()
  f.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'idle' }))
  await stopping
  assert.equal(f.control.state.phase, 'finished')
  assert.equal(f.control.state.stopping, false)
  assert.equal(f.aborted(), false)
})

test('missing restored or admission identity never falls back to cancelling an arbitrary current turn', async () => {
  for (const admitted of [false, true]) {
    const f = fixture()
    if (admitted) {
      f.control.submitting('web:chat-one')
      f.control.admitted()
    } else {
      f.control.state.phase = 'active'
      f.control.state.sessionId = 'web:chat-one'
      f.control.state.requestId = undefined
    }
    await f.control.stop()
    assert.equal(f.calls.length, 0)
    assert.equal(f.control.state.phase, 'active')
    assert.equal(f.control.state.stopping, false)
    assert.match(f.control.state.error, /identity is unavailable/)
  }
})

test('restored activity captures snapshot identity and a delayed Stop cannot abort its queued successor', async () => {
  const sessionId = 'web:chat-restored'
  let activeRequestId = 'restored-input'
  let abort = new AbortController()
  const app = new Hono()
  sessionsApiPlugin({
    getSessionState: (id: string) => id === sessionId ? { sessionId } : undefined,
    listSessions: async () => [{ sessionId }],
    yields: { get: () => null },
    inputs: { get: () => null },
    getActiveSession: () => ({
      phase: 'llm',
      get activeRequestId() { return activeRequestId },
      cancel: () => abort.abort(),
    }),
  } as unknown as SessionManager)(app)
  const snapshot = await (await app.request('/api/sessions/stages')).json()
  const identity = parseActiveRequestIds(snapshot)[sessionId]
  assert.equal(identity, 'restored-input')
  const deliver = Promise.withResolvers<void>()
  let submittedIdentity: string | undefined
  let responseStatus: number | undefined
  const control = createChatRequestControl('http://main', () => {}, async (url, init) => {
    submittedIdentity = JSON.parse(String(init?.body)).requestId
    await deliver.promise
    const response = await app.request(String(url), init)
    responseStatus = response.status
    return response
  }, sessionId, identity)
  const stopping = control.stop()
  assert.equal(submittedIdentity, 'restored-input')
  activeRequestId = 'queued-successor'
  abort = new AbortController()
  deliver.resolve()
  await stopping
  assert.equal(responseStatus, 409)
  assert.equal(abort.signal.aborted, false)
  assert.equal(control.state.requestId, 'restored-input')
  assert.equal(control.state.phase, 'active')
  assert.equal(control.state.stopping, false)
  assert.match(control.state.error, /may still be running/)
})

for (const response of [
  () => Response.json({ error: 'forbidden' }, { status: 403 }),
  () => Response.json({ error: 'unavailable' }, { status: 503 }),
  () => Response.json({ error: 'request_not_active' }, { status: 409 }),
  () => Response.json({ sessionId: 'web:other', status: 'requested' }),
  () => Response.json({ sessionId: 'web:chat-one', cancelled: true }),
  () => new Response('not json'),
]) {
  test(`unconfirmed cancellation remains busy and retryable: ${response().status} ${response().headers.get('content-type')}`, async () => {
    const f = fixture('web:chat-one')
    const stopping = f.control.stop()
    f.calls[0]!.resolve(response())
    await stopping
    assert.equal(f.control.state.phase, 'active')
    assert.equal(f.control.state.stopping, false)
    assert.match(f.control.state.error, /may still be running/)
    assert.equal(f.aborted(), false)
    const retry = f.control.stop()
    assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'requested' }))
    await retry
    assert.equal(f.control.state.error, '')
    assert.equal(f.control.state.stopping, true)
  })
}

test('network cancellation failure retains busy state; completion wins over late failure', async () => {
  const f = fixture('web:chat-one')
  const stopping = f.control.stop()
  f.calls[0]!.reject(new Error('Network unavailable'))
  await stopping
  assert.equal(f.control.state.phase, 'active')
  assert.equal(f.control.state.stopping, false)
  assert.match(f.control.state.error, /Network unavailable/)
  const retry = f.control.stop()
  f.control.finish()
  f.calls[1]!.reject(new Error('Late network error'))
  await retry
  assert.equal(f.control.state.phase, 'finished')
  assert.equal(f.control.state.error, '')
})

test('switching sessions cannot retarget an in-flight cancellation or stop queued successor work', async () => {
  const first = fixture('web:chat-one')
  const second = fixture('web:chat-two')
  const stopping = first.control.stop()
  first.control.finish()
  first.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'requested' }))
  await stopping
  assert.equal(first.control.state.phase, 'finished')
  assert.equal(first.control.state.stopping, false)
  assert.equal(second.control.state.phase, 'active')
  assert.equal(second.control.state.stopping, false)
  assert.equal(second.calls.length, 0)
})

test('composer exposes an accessible stop action and retains activity when polling fails', async () => {
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(source, /v-if="requestBusy"[\s\S]*?:aria-label="t\('Stop current request'\)"[\s\S]*?@click="stopCurrentRequest\(\)"/)
  assert.match(source, /currentRequest\?\.state\.error[\s\S]*?role="alert"/)
  const polling = source.slice(source.indexOf('async function pollSessionStages'), source.indexOf('function startStagePolling'))
  assert.doesNotMatch(polling.slice(polling.indexOf('} catch')), /sessionStages\.value = \{\}/)
  const stop = source.slice(source.indexOf('async function stopCurrentRequest'), source.indexOf('function handleYieldCancelled'))
  assert.doesNotMatch(stop, /\.abort\(|streaming\.value = false/)
  assert.match(stop, /activeRequestIds\.value\[activeSessionId\.value\]/)
})

test('explicit Resume submits only recovery identity and pending Stop targets the newly admitted continuation', async () => {
  const f = fixture()
  assert.equal(f.calls.length, 0, 'constructing the control does not resume automatically')
  const continuing = resumeChatRequest('http://main/orgs/one', 'web:chat-one', 'recovery-one', f.control, f.request)
  assert.equal(f.calls[0]!.url, 'http://main/orgs/one/api/sessions/web%3Achat-one/resume')
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init?.body)), { recoveryId: 'recovery-one' })
  assert.equal(f.control.state.phase, 'submitting')
  await f.control.stop()
  assert.equal(f.calls.length, 1)
  f.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', recoveryId: 'recovery-one', requestId: 'resume-input', status: 'accepted' }, { status: 202 }))
  await continuing
  assert.equal(f.calls.length, 2)
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init?.body)), { requestId: 'resume-input' })
  f.calls[1]!.resolve(Response.json({ sessionId: 'web:chat-one', status: 'requested' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.control.state.stopping, true)
  assert.equal(f.aborted(), false)
})

test('Resume completion arriving before acknowledgement stays finished and cannot affect another selected session', async () => {
  const f = fixture()
  const next = fixture('web:chat-two', 'second-input')
  const continuing = resumeChatRequest('http://main', 'web:chat-one', 'recovery-one', f.control, f.request)
  f.control.finish()
  f.calls[0]!.resolve(Response.json({ sessionId: 'web:chat-one', recoveryId: 'recovery-one', requestId: 'resume-input', status: 'accepted' }, { status: 202 }))
  await continuing
  assert.equal(f.control.state.phase, 'finished')
  assert.equal(next.calls.length, 0)
  assert.equal(next.control.state.requestId, 'second-input')
})

test('Resume rejection is retryable; unknown admission never claims success or sends an uncorrelated Stop', async () => {
  for (const status of [409, 500]) {
    const f = fixture()
    const continuing = resumeChatRequest('http://main', 'web:chat-one', 'recovery-one', f.control, f.request)
    f.calls[0]!.resolve(Response.json({ error: 'recovery_conflict' }, { status }))
    await assert.rejects(continuing, /Could not continue/)
    assert.equal(f.control.state.phase, 'finished')
    assert.equal(f.calls.length, 1)
  }
  const f = fixture()
  const continuing = resumeChatRequest('http://main', 'web:chat-one', 'recovery-one', f.control, f.request)
  f.calls[0]!.reject(new Error('Connection lost'))
  await assert.rejects(continuing, /Connection lost/)
  assert.equal(f.control.state.phase, 'active')
  await f.control.stop()
  assert.equal(f.calls.length, 1)
  assert.match(f.control.state.error, /identity is unavailable/)
})

test('Continue is prominent above the composer, gated by persisted recovery rather than idle or a draft', async () => {
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(source, /v-if="currentRecovery && !requestBusy"[\s\S]*?:aria-label="t\('Resume interrupted request'\)"[\s\S]*?@click="resumeCurrentRequest\(\)"/)
  assert(source.indexOf('class="resume-bar"') < source.indexOf('class="composer-box"'))
  assert.match(source, /currentRecovery = computed\(\(\) => activeSessionId\.value \? sessionRecoveries\.value\[activeSessionId\.value\] : undefined\)/)
  assert.equal((source.match(/await resumeChatRequest\(/g) ?? []).length, 1)
  assert.match(source, /Continue without adding a message\. Remote shell calls only check the Child\\'s saved execution record/)
  assert.match(source, /type="checkbox" :checked="acknowledgedRecoveryId === currentRecovery\.id"/)
  assert.match(source, /acknowledgedRecoveryId !== currentRecovery\.id/)
  assert.match(source, /sessionRecoveries\.value\[sessionId\]\?\.id === priorRecoveryId/)
})

test('acknowledged continuation sends explicit replay consent without replaying a draft', async () => {
  const f = fixture()
  const continuing = resumeChatRequest('http://main', 'web:chat-one', 'recovery-one', f.control, f.request, true)
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init?.body)), { recoveryId: 'recovery-one', acknowledgeToolReplay: true })
  f.calls[0]!.resolve(Response.json({
    sessionId: 'web:chat-one', recoveryId: 'recovery-one', requestId: 'continued-input', status: 'accepted',
  }, { status: 202 }))
  await continuing
})
