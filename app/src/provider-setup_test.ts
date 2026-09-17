import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COPILOT_VERIFICATION_URL, createDeviceLoginController, createProviderSetupClient,
  parseConfiguredProviders, parseDeviceLogin, parseProviderSetup, type DeviceLogin, type LoginView,
} from './provider-setup.ts'

const pending: DeviceLogin = {
  loginId: 'attempt-1', state: 'pending', userCode: 'ABCD-EFGH',
  verificationUri: COPILOT_VERIFICATION_URL, expiresAt: 4_000_000_000_000, intervalMs: 5000,
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('configured inventory validates records, drops extra secrets, and forwards cancellation', async () => {
  const provider = { provider: 'local', authMode: 'none', hasApiKey: false, selected: true, model: 'qwen@local', baseUrl: 'http://127.0.0.1:11434/v1' }
  assert.deepEqual(parseConfiguredProviders({ providers: [{ ...provider, apiKey: 'synthetic-private-key' }] }), [provider])
  for (const value of [
    {}, { providers: {} }, { providers: [null] }, { providers: [{ ...provider, selected: 'true' }] },
    { providers: [{ ...provider, authMode: 'unknown' }] }, { providers: [provider, provider] },
    { providers: [provider, { ...provider, provider: 'another' }] },
    { providers: [{ ...provider, baseUrl: 5 }] },
  ]) assert.throws(() => parseConfiguredProviders(value), /invalid provider list/)
  const controller = new AbortController()
  const client = createProviderSetupClient('http://fixture.invalid', async (input, init) => {
    assert.equal(input, 'http://fixture.invalid/api/provider/configured')
    assert.equal(init?.signal?.aborted, false)
    controller.abort()
    assert.equal(init?.signal?.aborted, true)
    assert.equal(init?.signal?.reason, controller.signal.reason)
    return Response.json({ providers: [provider] })
  })
  assert.deepEqual(await client.configured(controller.signal), [provider])
  assert.deepEqual(parseConfiguredProviders({ providers: [] }), [])
})

test('provider reads retain their timeout when a view supplies a cancellation signal', async (t) => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30_000)
    return deadline.signal
  })
  const view = new AbortController()
  const client = createProviderSetupClient('http://fixture.invalid', async (_input, init) => {
    deadline.abort(new DOMException('Synthetic timeout', 'TimeoutError'))
    init!.signal!.throwIfAborted()
    throw new Error('Expected the deadline to cancel the request')
  })
  await assert.rejects(client.status(view.signal), /Cannot reach the provider setup service/)
  await assert.rejects(client.configured(view.signal), /Cannot reach the provider setup service/)
  assert.equal(view.signal.aborted, false, 'a timeout must not abort the owning view')
})

function harness(result: DeviceLogin | Error = { loginId: pending.loginId, state: 'succeeded' }) {
  const views: LoginView[] = []
  const cancelled: string[] = []
  let timer: (() => void) | undefined
  let starts = 0
  let polls = 0
  const controller = createDeviceLoginController({
    async start() { starts++; return pending },
    async poll() { polls++; if (result instanceof Error) throw result; return result },
    async cancel(id) { cancelled.push(id) },
  }, (view) => views.push(view), (callback) => {
    assert.equal(timer, undefined, 'Only one UI status refresh may be queued')
    timer = callback
    return () => { timer = undefined }
  }, () => pending.loginId)
  return {
    controller, views, cancelled,
    get starts() { return starts },
    get polls() { return polls },
    get scheduled() { return !!timer },
    async tick() { const callback = timer; timer = undefined; callback?.(); await flush() },
  }
}

test('provider status accepts missing, configured, Copilot and keyless-local states without carrying secrets', () => {
  for (const [provider, authMode, ready, hasApiKey] of [
    ['openai', 'api-key', false, false],
    ['openai', 'api-key', true, true],
    ['copilot', 'copilot', true, false],
    ['local', 'none', true, false],
  ] as const) {
    const status = parseProviderSetup({ provider, authMode, ready, hasApiKey, model: 'model', apiKey: 'synthetic-secret' })
    assert.equal(status.ready, ready)
    assert.equal('apiKey' in status, false)
  }
  assert.throws(() => parseProviderSetup({ ready: true }), /invalid provider status/)
})

test('device-code data validates the exact trusted verification URL and drops private data', () => {
  assert.deepEqual(parseDeviceLogin({ ...pending, device_code: 'private', access_token: 'secret' }), pending)
  for (const verificationUri of [
    'http://github.com/login/device', 'https://github.com.evil.example/login/device',
    'https://github.com/login/device?token=secret', 'https://user@github.com/login/device',
    'https://github.com/settings/tokens',
  ]) assert.throws(() => parseDeviceLogin({ ...pending, verificationUri }), /invalid GitHub device code/)
  assert.throws(() => parseDeviceLogin({ ...pending, intervalMs: 0 }), /invalid GitHub/)
})

test('successful flow starts once, publishes success, and leaves no refresh timer', async () => {
  const h = harness()
  await h.controller.start()
  await h.controller.start()
  assert.equal(h.starts, 1)
  await h.tick()
  assert.equal(h.polls, 1)
  assert.equal(h.views.at(-1)?.state, 'succeeded')
  assert.equal(h.scheduled, false)
})

test('pending refresh remains single and cancellation cleans up', async () => {
  const h = harness({ ...pending, intervalMs: 10_000 })
  await h.controller.start()
  await h.tick()
  assert.equal(h.scheduled, true)
  await h.controller.cancel()
  assert.equal(h.scheduled, false)
  assert.deepEqual(h.cancelled, [pending.loginId])
  await h.tick()
  assert.equal(h.polls, 1)
  assert.equal(h.views.at(-1)?.state, 'cancelled')
})

test('denial, expiry and server failure are terminal, recoverable states', async () => {
  for (const state of ['denied', 'expired', 'error'] as const) {
    const h = harness({ loginId: pending.loginId, state })
    await h.controller.start()
    await h.tick()
    assert.equal(h.views.at(-1)?.state, state)
    assert.equal(h.scheduled, false)
    await h.controller.start()
    assert.equal(h.starts, 2)
    await h.controller.cancel()
  }
})

test('network polling failure cancels the backend attempt and reports a safe error', async () => {
  const h = harness(new Error('sensitive upstream body'))
  await h.controller.start()
  await h.tick()
  assert.deepEqual(h.cancelled, [pending.loginId])
  assert.equal(h.views.at(-1)?.state, 'error')
  assert.equal(JSON.stringify(h.views).includes('sensitive'), false)
  assert.equal(h.scheduled, false)
})

test('cancel while starting uses the client ID before POST returns and never duplicates an attempt', async () => {
  let complete!: (value: DeviceLogin) => void
  const deferred = new Promise<DeviceLogin>((resolve) => { complete = resolve })
  const cancelled: string[] = []
  const views: LoginView[] = []
  let starts = 0
  const controller = createDeviceLoginController({
    start: () => { starts++; return deferred },
    async poll() { throw new Error('Must not poll after cancel') },
    async cancel(id) { cancelled.push(id) },
  }, (view) => views.push(view), undefined, () => pending.loginId)
  const starting = controller.start()
  const cancelling = controller.cancel()
  assert.deepEqual(cancelled, [pending.loginId], 'Cancellation does not wait for the POST response')
  await controller.start()
  assert.equal(starts, 1)
  complete(pending)
  await Promise.all([starting, cancelling])
  assert.deepEqual(cancelled, [pending.loginId])
  assert.equal(views.some((view) => view.state === 'pending'), false)
  assert.equal(views.at(-1)?.state, 'cancelled')
})

test('a late status response cannot re-authenticate a cancelled UI flow', async () => {
  let complete!: (value: DeviceLogin) => void
  let callback: (() => void) | undefined
  let signal: AbortSignal | undefined
  const views: LoginView[] = []
  const controller = createDeviceLoginController({
    async start() { return pending },
    poll: async (_id, value) => {
      signal = value
      return await new Promise<DeviceLogin>((resolve) => { complete = resolve })
    },
    async cancel() {},
  }, (view) => views.push(view), (value) => { callback = value; return () => { callback = undefined } }, () => pending.loginId)
  await controller.start()
  callback?.()
  await controller.cancel()
  assert.equal(signal?.aborted, true)
  complete({ loginId: pending.loginId, state: 'succeeded' })
  await flush()
  assert.equal(views.at(-1)?.state, 'cancelled')
  assert.equal(views.some((view) => view.state === 'succeeded'), false)
})

test('setup client sends keys only in POST body; cancellation is keepalive and status is redacted', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const client = createProviderSetupClient('http://127.0.0.1:43123', async (url, init) => {
    requests.push({ url: String(url), init })
    return Response.json({
      provider: 'openai', model: 'gpt-4.1@openai', ready: true, hasApiKey: true,
      authMode: 'api-key', apiKey: 'should-not-be-retained',
    })
  })
  const status = await client.save({ provider: 'openai', model: 'gpt-4.1', apiKey: 'synthetic-key' })
  assert.equal('apiKey' in status, false)
  assert.equal(requests[0]?.url.includes('synthetic-key'), false)
  assert.equal(requests[0]?.init?.method, 'POST')
  assert.equal(JSON.parse(String(requests[0]?.init?.body)).apiKey, 'synthetic-key')
  await client.cancel('attempt-1')
  assert.equal(requests[1]?.init?.keepalive, true)
  assert.equal(requests[1]?.init?.method, 'DELETE')
})
