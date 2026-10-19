import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COPILOT_VERIFICATION_URL, createDeviceLoginController, createProviderSetupClient,
  parseConfiguredProviders, parseDeviceLogin, parseProviderSetup, type DeviceLogin, type LoginView,
  copilotFailureMessage, providerFailureMessage,
} from './provider-setup.ts'

const pending: DeviceLogin = {
  loginId: 'attempt-1', state: 'pending', userCode: 'ABCD-EFGH',
  verificationUri: COPILOT_VERIFICATION_URL, expiresAt: 4_000_000_000_000, intervalMs: 5000,
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('safe login error codes survive parsing and reach the UI without upstream secrets', async () => {
  const views: LoginView[] = []
  const failed = parseDeviceLogin({
    loginId: pending.loginId, state: 'error', errorCode: 'proxy', message: 'private-upstream-secret',
  })
  const controller = createDeviceLoginController({
    start: async () => failed, poll: async () => failed, cancel: async () => {},
  }, view => views.push(view), undefined, () => pending.loginId)
  await controller.start()
  assert.equal(views.at(-1)?.error, copilotFailureMessage('proxy'))
  assert.match(views.at(-1)!.error!, /PAC/)
  assert.doesNotMatch(JSON.stringify(views), /private-upstream-secret/)
  assert.match(providerFailureMessage('authentication'), /sign in/i)
  assert.match(providerFailureMessage('rate-limit'), /quota/)
})

test('explicit login requests reauthentication and sign-out validates local removal', async () => {
  const client = createProviderSetupClient('http://fixture.invalid', async (url, init) => {
    assert.equal(init?.method, 'POST')
    if (String(url).endsWith('/logout')) return Response.json({ authenticated: false })
    assert.equal(JSON.parse(String(init?.body)).reauthenticate, true)
    return Response.json(pending)
  })
  await client.start()
  await client.signOut()
  const invalid = createProviderSetupClient('http://fixture.invalid', async () => Response.json({ authenticated: true }))
  await assert.rejects(invalid.signOut(), /could not be confirmed/)
})

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


test('Copilot setup and inventory preserve validated host and reject invalid hosts', () => {
  const status = { provider: 'copilot', authMode: 'copilot', model: 'model', ready: true, hasApiKey: false }
  const item = { ...status, selected: false }
  for (const host of ['github.com', 'octocat.ghe.com']) {
    assert.equal(parseProviderSetup({ ...status, host }).host, host)
    assert.equal(parseConfiguredProviders({ providers: [{ ...item, host }] })[0]?.host, host)
  }
  for (const host of [null, 1, '', 'ghe.com', 'nested.tenant.ghe.com', 'https://tenant.ghe.com', 'evil.example', 'tenant.ghe.com:443', 'tenant.ghe.com/path', 'xn--tenant.ghe.com']) {
    assert.throws(() => parseProviderSetup({ ...status, host }), /invalid provider status/)
    assert.throws(() => parseConfiguredProviders({ providers: [{ ...item, host }] }), /invalid provider list/)
    assert.throws(() => parseDeviceLogin({ ...pending, host }), /invalid login status/)
  }
})

test('enterprise device links must match the validated response host exactly', () => {
  const login = { ...pending, host: 'octocat.ghe.com', verificationUri: 'https://octocat.ghe.com/login/device' }
  assert.deepEqual(parseDeviceLogin(login), login)
  for (const verificationUri of [
    COPILOT_VERIFICATION_URL, 'https://other.ghe.com/login/device',
    'https://octocat.ghe.com:443/login/device', 'https://octocat.ghe.com/login/device?',
    'https://octocat.ghe.com/login/device#', 'https://user@octocat.ghe.com/login/device',
    'https://octocat.ghe.com/other/../login/device', 'https://octocat.ghe.com/login/device\n',
  ]) assert.throws(() => parseDeviceLogin({ ...login, verificationUri }), /invalid GitHub device code/)
  assert.throws(() => parseDeviceLogin({ ...pending, verificationUri: login.verificationUri }), /invalid GitHub device code/)
})

test('login client sends explicit canonical host and rejects invalid hosts before POST or mismatched responses', async () => {
  const requests: Record<string, unknown>[] = []
  const client = createProviderSetupClient('http://fixture.invalid', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    return Response.json({ ...pending, host: body.host, verificationUri: `https://${body.host}/login/device` })
  })
  await client.start('model', pending.loginId)
  await client.start('model', pending.loginId, undefined, ' Octocat.GHE.com ')
  assert.deepEqual(requests.map(body => body.host), ['github.com', 'octocat.ghe.com'])
  assert.deepEqual(requests[1], { model: 'model', attemptId: pending.loginId, reauthenticate: true, host: 'octocat.ghe.com' })
  await assert.rejects(client.start(undefined, undefined, undefined, 'https://evil.example'))
  assert.equal(requests.length, 2)
  const wrongHost = createProviderSetupClient('http://fixture.invalid', async () => Response.json(pending))
  await assert.rejects(wrongHost.start(undefined, undefined, undefined, 'octocat.ghe.com'), /login host changed/)
})

test('retry retains enterprise selection and host changes are ignored during pending login', async () => {
  const hosts: Array<string | undefined> = []
  const views: LoginView[] = []
  const login = { ...pending, host: 'octocat.ghe.com', verificationUri: 'https://octocat.ghe.com/login/device' }
  const controller = createDeviceLoginController({
    async start(_model, _id, _signal, host) { hosts.push(host); return login },
    async poll() { return login },
    async cancel() {},
  }, view => views.push(view), () => () => {}, () => pending.loginId)
  await controller.start(undefined, 'octocat.ghe.com')
  await controller.start(undefined, 'github.com')
  assert.equal(hosts.length, 1)
  await controller.cancel()
  await controller.start()
  assert.deepEqual(hosts, ['octocat.ghe.com', 'octocat.ghe.com'])
  assert.equal(views.at(-1)?.login?.verificationUri, login.verificationUri)
  await controller.cancel()
})

test('poll cannot silently change the selected login host', async () => {
  let tick: (() => void) | undefined
  const views: LoginView[] = []
  const cancelled: string[] = []
  const controller = createDeviceLoginController({
    async start() { return { ...pending, host: 'octocat.ghe.com', verificationUri: 'https://octocat.ghe.com/login/device' } },
    async poll() { return { loginId: pending.loginId, host: 'github.com', state: 'succeeded' } },
    async cancel(id) { cancelled.push(id) },
  }, view => views.push(view), callback => { tick = callback; return () => { tick = undefined } }, () => pending.loginId)
  await controller.start(undefined, 'octocat.ghe.com')
  tick?.()
  await flush()
  assert.equal(views.at(-1)?.state, 'error')
  assert.equal(views.some(view => view.state === 'succeeded'), false)
  assert.deepEqual(cancelled, [pending.loginId])
})


test('instance-scoped client sends login, polling, cancel and logout to the same stable identity', async () => {
  const paths: string[] = []
  const client = createProviderSetupClient('http://fixture.invalid', async (url, init) => {
    const parsed = new URL(String(url))
    assert.equal(parsed.searchParams.get('provider'), 'work-copilot')
    paths.push(`${init?.method ?? 'GET'} ${parsed.pathname}`)
    return Response.json(parsed.pathname.endsWith('/logout') ? { authenticated: false } : pending)
  }, () => 'work-copilot')
  await client.start(undefined, pending.loginId)
  await client.poll(pending.loginId)
  await client.cancel(pending.loginId)
  await client.signOut()
  assert.equal(paths.length, 4)
  const parsed = parseConfiguredProviders({ providers: [
    { provider: 'a', type: 'deepseek', name: 'Work', authMode: 'api-key', hasApiKey: true, selected: true },
    { provider: 'b', type: 'deepseek', name: 'Home', authMode: 'api-key', hasApiKey: true, selected: false },
  ] })
  assert.deepEqual(parsed.map(item => [item.provider, item.type, item.name]), [['a', 'deepseek', 'Work'], ['b', 'deepseek', 'Home']])
})


test('safe authentication phase distinguishes OAuth rejection from Copilot exchange in UI', async () => {
  for (const errorStage of ['oauth_device', 'oauth_token', 'copilot_token'] as const) {
    const views: LoginView[] = []
    const failed = parseDeviceLogin({ loginId: 'attempt-stage', state: 'denied', errorCode: 'denied', errorStage, httpStatus: 403, message: 'private-token-response', accessToken: 'private-token' })
    assert.equal(failed.errorStage, errorStage)
    assert.equal(failed.httpStatus, 403)
    const controller = createDeviceLoginController({ start: async () => failed, poll: async () => failed, cancel: async () => {} }, view => views.push(view), undefined, () => failed.loginId)
    await controller.start()
    assert.equal(views.at(-1)?.error, copilotFailureMessage('denied', errorStage))
    assert.doesNotMatch(JSON.stringify(views), /private-token/)
    if (errorStage === 'copilot_token') assert.match(views.at(-1)!.error!, /authorization succeeded/)
    else assert.match(views.at(-1)!.error!, /rejected the OAuth/)
  }
  const unknown = parseDeviceLogin({ loginId: 'attempt-stage', state: 'denied', errorCode: 'denied', errorStage: 'private-token', httpStatus: 700 })
  assert.equal(unknown.errorStage, undefined)
  assert.equal(unknown.httpStatus, undefined)
})


test('missing copilot grant remains a distinct actionable error without upstream text', async () => {
  const failed = parseDeviceLogin({ loginId: 'scope-attempt', state: 'error', errorCode: 'scope_missing', errorStage: 'oauth_token', message: 'synthetic-private-upstream' })
  assert.equal(failed.errorCode, 'scope_missing')
  const views: LoginView[] = []
  const controller = createDeviceLoginController({ start: async () => failed, poll: async () => failed, cancel: async () => {} }, view => views.push(view), undefined, () => failed.loginId)
  await controller.start()
  assert.equal(views.at(-1)?.error, copilotFailureMessage('scope_missing'))
  assert.match(views.at(-1)!.error!, /did not grant.*copilot/)
  assert.match(views.at(-1)!.error!, /not request broader permissions automatically/)
  assert.doesNotMatch(JSON.stringify(views), /synthetic-private-upstream/)
})


test('server HTTP errors preserve safe status and phase rather than being called connection timeouts', async () => {
  const failed = parseDeviceLogin({ loginId: 'server-error', state: 'error', errorCode: 'network', errorStage: 'copilot_access', httpStatus: 404, message: 'synthetic-secret-upstream' })
  assert.equal(failed.errorStage, 'copilot_access')
  assert.equal(failed.httpStatus, 404)
  const views: LoginView[] = []
  const controller = createDeviceLoginController({ start: async () => failed, poll: async () => failed, cancel: async () => {} }, view => views.push(view), undefined, () => failed.loginId)
  await controller.start()
  assert.match(views.at(-1)!.error!, /copilot_access.*404/)
  assert.match(views.at(-1)!.error!, /not a connection timeout/)
  assert.doesNotMatch(JSON.stringify(views), /synthetic-secret-upstream/)
  assert.match(copilotFailureMessage('expired', 'copilot_access'), /authorization has expired/)
  assert.match(copilotFailureMessage('denied', 'copilot_access'), /access check was rejected/)
})
