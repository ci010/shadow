import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CopilotAuthenticatorV2, CopilotProviderV2 } from './copilot-v2.ts'
import { CopilotAuthError } from './copilot.ts'

function fixture(oauth: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  let now = 1_000_000
  const files = new Map<string, string>()
  const urls: string[] = []
  let userReply: (() => Promise<Response>) | undefined
  const auth = new CopilotAuthenticatorV2('synthetic', {
    isolated: true, now: () => now, wait: async () => {},
    storage: { read: p => files.get(p), write: (p, v) => { files.set(p, v) }, remove: p => { files.delete(p) } },
    fetch: async (url, init) => {
      urls.push(String(url))
      if (String(url).endsWith('/device/code')) {
        assert.deepEqual(JSON.parse(String(init?.body)), { client_id: 'Ov23ctr1Udn5GokVCVJf', scope: 'copilot' })
        return Response.json({ device_code: 'device', user_code: 'ABCD-1234', verification_uri: 'https://msft.ghe.com/login/device', expires_in: 60, interval: 1 })
      }
      if (String(url).endsWith('/access_token')) return Response.json({ access_token: 'synthetic-oauth', scope: 'copilot', ...oauth })
      assert.equal(String(url), 'https://api.msft.ghe.com/copilot_internal/user')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-oauth')
      assert.equal(new Headers(init?.headers).get('copilot-integration-id'), 'copilot-developer-app')
      return userReply ? userReply() : Response.json(user)
    },
  })
  const login = async () => auth.completeDeviceLogin(await auth.startDeviceLogin(undefined, 'msft.ghe.com'))
  return { auth, files, urls, login, setUserReply: (reply: () => Promise<Response>) => { userReply = reply }, advance: (ms: number) => { now += ms } }
}

test('App OAuth directly supplies model lease, no exchange; unknown expiry and concurrent reads', async () => {
  const f = fixture()
  const grant = await f.login()
  assert.equal(f.files.size, 0)
  f.auth.persistGrant(grant)
  const leases = await Promise.all(Array.from({ length: 20 }, () => f.auth.acquireLease()))
  assert.ok(leases.every(l => l.token === 'synthetic-oauth' && l.expiryKnown === false && Object.isFrozen(l)))
  assert.equal(leases[0].apiBase, 'https://copilot-api.msft.ghe.com')
  assert.equal(f.urls.length, 3)
  assert.ok(!f.urls.some(u => u.includes('/v2/token')))
  f.advance(1e12)
  assert.equal(await f.auth.getApiKey(), 'synthetic-oauth')
  assert.equal(await f.auth.getApiKey(undefined, true), 'synthetic-oauth')
  assert.equal(new CopilotProviderV2(f.auth).name, 'copilot')
})

test('known expiry fails closed without synthetic refresh', async () => {
  const f = fixture({ expires_in: 60 })
  f.auth.persistGrant(await f.login())
  assert.equal((await f.auth.acquireLease()).expiryKnown, true)
  f.advance(60_000)
  assert.equal(f.auth.hasValidApiKey(), false)
  await assert.rejects(f.auth.acquireLease(), (e: unknown) => e instanceof CopilotAuthError && e.code === 'expired')
  assert.equal(f.urls.length, 3)
})

for (const scope of [undefined, null, 123, '', 'copilot_extra', 'repo', 'copilot\u00a0repo']) {
  test(`scope fails closed: ${String(scope)}`, async () => {
    const f = fixture({ scope })
    await assert.rejects(f.login(), (e: unknown) => e instanceof CopilotAuthError && e.code === 'scope_missing')
    assert.equal(f.urls.length, 2)
    assert.equal(f.files.size, 0)
  })
}
for (const user of [{ copilot_plan: 'no_access' }, { copilot_app_enabled: false, chat_enabled: false, cli_enabled: false }]) {
  test(`seat denial ${JSON.stringify(user)}`, async () => {
    const f = fixture({}, user)
    await assert.rejects(f.login(), (e: unknown) => e instanceof CopilotAuthError && e.code === 'denied' && e.stage === 'copilot_access')
    assert.equal(f.files.size, 0)
  })
}
for (const api of ['https://attacker.example', 'https://copilot-api.other.ghe.com', 'https://copilot-api.msft.ghe.com/path', 'https://copilot-api.msft.ghe.com:443']) {
  test(`untrusted endpoint ${api}`, async () => {
    const f = fixture({}, { endpoints: { api } })
    await assert.rejects(f.login(), (e: unknown) => e instanceof CopilotAuthError && e.code === 'invalid')
    assert.equal(f.files.size, 0)
  })
}
test('legacy cache is not treated as OAuth; rollback restores full profile; signout cannot revive', async () => {
  const f = fixture()
  const grant = await f.login()
  f.files.set('synthetic/access-token', 'old-identity')
  f.files.set('synthetic/api-key.json', JSON.stringify({ token: 'old-short-key', expires_at: 999999 }))
  assert.equal(f.auth.hasAccessToken(), false)
  await assert.rejects(f.auth.getApiKey())
  const before = new Map(f.files)
  const undo = f.auth.persistGrant(grant)
  undo()
  assert.deepEqual(f.files, before)
  f.auth.persistGrant(grant)
  f.auth.signOut()
  undo()
  await assert.rejects(f.auth.getApiKey())
  assert.equal(f.files.get('synthetic/access-token'), 'old-identity') // Other host legacy files are preserved.
})
test('late authorization response is fenced by signout', async () => {
  const f = fixture()
  const device = await f.auth.startDeviceLogin(undefined, 'msft.ghe.com')
  const pending = f.auth.completeDeviceLogin(device)
  f.auth.signOut()
  await assert.rejects(pending, (e: unknown) => e instanceof CopilotAuthError && e.code === 'cancelled')
  assert.equal(f.files.size, 0)
})

test('readiness recheck shares one request and waiter cancellation does not own it', async () => {
  const f = fixture()
  f.auth.persistGrant(await f.login())
  let resolve!: (response: Response) => void
  f.setUserReply(() => new Promise<Response>(r => { resolve = r }))
  const c = new AbortController()
  const first = f.auth.acquireLease(c.signal, true)
  const second = f.auth.acquireLease(undefined, true)
  c.abort()
  await assert.rejects(first)
  resolve(Response.json({}))
  assert.equal((await second).token, 'synthetic-oauth')
  assert.equal(f.urls.length, 4)
})
test('late readiness recheck cannot resurrect credentials after signout or rollback', async () => {
  for (const rollback of [false, true]) {
    const f = fixture()
    const grant = await f.login()
    f.auth.persistGrant(grant)
    let resolve!: (response: Response) => void
    f.setUserReply(() => new Promise<Response>(r => { resolve = r }))
    const old = f.auth.acquireLease(undefined, true)
    if (rollback) { const undo = f.auth.persistGrant(grant); undo() }
    else f.auth.signOut()
    const snapshot = new Map(f.files)
    resolve(Response.json({}))
    await assert.rejects(old, (e: unknown) => e instanceof CopilotAuthError && e.code === 'cancelled')
    assert.deepEqual(f.files, snapshot)
  }
})
test('401 recheck invalidates profile, subsequent calls require explicit login', async () => {
  const f = fixture()
  f.auth.persistGrant(await f.login())
  f.setUserReply(async () => new Response('', { status: 401 }))
  await assert.rejects(f.auth.getApiKey(undefined, true), (e: unknown) => e instanceof CopilotAuthError && e.code === 'denied' && e.httpStatus === 401)
  assert.equal(f.auth.hasValidApiKey(), false)
  await assert.rejects(f.auth.getApiKey(), (e: unknown) => e instanceof CopilotAuthError && e.code === 'missing')
})
test('direct OAuth models request uses App header and retains Responses capabilities', async () => {
  const f = fixture({}, { endpoints: { api: 'https://copilot-api.msft.ghe.com' } })
  f.auth.persistGrant(await f.login())
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://copilot-api.msft.ghe.com/models')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-oauth')
    assert.equal(new Headers(init?.headers).get('copilot-integration-id'), 'copilot-developer-app')
    return Response.json({ data: [{ id: 'synthetic-model', supported_endpoints: ['/responses'] }] })
  }
  try {
    const models = await new CopilotProviderV2(f.auth).listModelInfos()
    assert.equal(models.length, 1)
    assert.deepEqual(models[0].supportedEndpoints, ['/responses'])
  } finally { globalThis.fetch = previous }
})

test('current device polling preserves slow_down intervals, cancellation and closed host validation', async () => {
  let now = 1_000_000
  const waits: number[] = []
  const urls: string[] = []
  const replies: unknown[] = [
    { device_code: 'synthetic-device', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 2 },
    { error: 'slow_down' }, { error: 'authorization_pending' },
    { access_token: 'synthetic-oauth', scope: 'copilot' }, { copilot_plan: 'individual' },
  ]
  const auth = new CopilotAuthenticatorV2('synthetic-poll', {
    isolated: true, now: () => now,
    storage: { read: () => undefined, write: () => assert.fail('Polling must not persist'), remove: () => assert.fail('Polling must not remove credentials') },
    wait: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); now += ms },
    fetch: async url => { urls.push(String(url)); assert.ok(replies.length); return Response.json(replies.shift()) },
  })
  await assert.rejects(auth.startDeviceLogin(undefined, 'attacker.example'))
  assert.equal(urls.length, 0)
  const device = await auth.startDeviceLogin()
  const grant = await auth.completeDeviceLogin(device)
  assert.equal(grant.accessToken, 'synthetic-oauth')
  assert.deepEqual(waits, [2000, 7000, 7000])
  assert.equal(urls.at(-1), 'https://api.github.com/copilot_internal/user')
  const controller = new AbortController(); controller.abort()
  const count = urls.length
  await assert.rejects(auth.completeDeviceLogin(device, controller.signal))
  assert.equal(urls.length, count)
})
