import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DeepSeekAccountAuth, accountBrowserUrl } from './deepseek-account-auth.ts'
import { DeepSeekAccountProvider, deepseekAccountRequest } from './deepseek-account.ts'
import { writePrivateFile } from '../utils/private-file.ts'
import { ConfigSchema } from '../config/schema.ts'
import { createProvider, resolveProviderSettings } from './factory.ts'

function temporary(t: TestContext) {
  const directory = mkdtempSync(join(process.cwd(), '.tmp-deepseek-account-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
const envelope = (data: unknown) => Response.json({ code: 0, data: { biz_code: 0, biz_data: data } })
const token = 'synthetic-account-token'
const deviceId = 'c468c022-a984-4bad-aad8-d6566fc361d3'
function stored(directory: string, value = token) {
  mkdirSync(directory, { recursive: true })
  writePrivateFile(join(directory, 'grant.json'), JSON.stringify({ version: 1, issuer: 'https://platform.deepseek.com', token: value, deviceId }))
}
function stream(events: unknown[], chunkSize = 11) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
    controller.close()
  } }))
}
const complete = [
  { type: 'message_start', message: { model: 'deepseek-v4-flash', usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '考虑' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"weather"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]

test('Account login uses S256, loopback/state checks, isolated private storage and one-time callback', async t => {
  const directory = temporary(t)
  let init: Record<string, string> = {}
  let exchange: Record<string, string> = {}
  const auth = new DeepSeekAccountAuth(directory, (async (input, options) => {
    assert.equal(options?.redirect, 'error')
    assert.equal(new Headers(options?.headers).get('authorization'), null)
    if (String(input).endsWith('/auth_init')) {
      init = JSON.parse(String(options?.body))
      return envelope({ authorize_url: 'https://platform.deepseek.com/dsh/authorize?id=synthetic', authorize_id: 'synthetic', expires_in: 60 })
    }
    exchange = JSON.parse(String(options?.body))
    assert.equal(createHash('sha256').update(exchange.code_verifier!).digest('base64url'), init.code_challenge)
    assert.equal(exchange.redirect_uri, init.redirect_uri)
    assert.equal(exchange.code, 'synthetic-code')
    return envelope({ token, authorized_url: 'https://platform.deepseek.com/dsh/authorized' })
  }) as typeof fetch)
  t.after(() => auth.dispose())
  const login = await auth.start()
  assert.equal(init.code_challenge_method, 'S256')
  assert.match(init.redirect_uri!, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
  assert.equal((await auth.start()).loginId, login.loginId)
  const bad = await fetch(`${init.redirect_uri}?state=wrong&code=synthetic-code`)
  assert.equal(bad.status, 400)
  const callback = await fetch(`${init.redirect_uri}?state=${init.state}&code=synthetic-code`)
  assert.equal(callback.status, 200)
  // Wait for the exchange's private file commit, not a real external service.
  for (let i = 0; i < 50 && auth.status(login.loginId)?.state === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(auth.status(login.loginId)?.state, 'succeeded')
  assert.equal(auth.resolve().token, token)
  assert.equal(statSync(join(directory, 'grant.json')).mode & 0o777, 0o600)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(JSON.parse(readFileSync(join(directory, 'grant.json'), 'utf8')).issuer, 'https://platform.deepseek.com')
  assert.equal(JSON.stringify(login).includes(token), false)
})

test('Account browser/inference destinations reject lookalikes, credentials and redirects', t => {
  const auth = new DeepSeekAccountAuth(temporary(t))
  for (const endpoint of ['https://evil.example/v1/messages', 'https://api.deepseek.com.evil.example/v1/messages', 'https://api.deepseek.com/v1/messages?token=x', 'http://api.deepseek.com/v1/messages']) assert.throws(() => auth.resolve(endpoint), /not allowed/)
  for (const browser of ['https://platform.deepseek.com.evil.example/dsh/authorize', 'https://platform.deepseek.com/other', 'https://a:b@platform.deepseek.com/dsh/authorize']) assert.throws(() => accountBrowserUrl(browser))
})

test('Cancelled late exchange cannot persist a token', async t => {
  const directory = temporary(t)
  let init: Record<string, string> = {}
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let exchanging!: () => void
  const started = new Promise<void>(resolve => { exchanging = resolve })
  const auth = new DeepSeekAccountAuth(directory, (async (input, options) => {
    if (String(input).endsWith('/auth_init')) {
      init = JSON.parse(String(options?.body))
      return envelope({ authorize_url: 'https://platform.deepseek.com/dsh/authorize', authorize_id: 'id', expires_in: 60 })
    }
    exchanging(); await blocked
    return envelope({ token, authorized_url: 'https://platform.deepseek.com/dsh/authorized' })
  }) as typeof fetch)
  t.after(() => auth.dispose())
  const login = await auth.start()
  await fetch(`${init.redirect_uri}?state=${init.state}&code=code`)
  await started
  auth.cancel(login.loginId)
  release()
  await auth.dispose()
  assert.equal(auth.ready(), false)
  assert.equal(auth.status(login.loginId)?.state, 'cancelled')
})

test('Messages streaming assembles reasoning/text/tool JSON and cache usage across UTF-8/CRLF chunks', async t => {
  const directory = temporary(t); stored(directory)
  const provider = new DeepSeekAccountProvider(new DeepSeekAccountAuth(directory), (async (input, options) => {
    assert.equal(input, 'https://api.deepseek.com/v1/messages')
    assert.equal(new Headers(options?.headers).get('x-dsh-auth-token'), token)
    assert.equal(new Headers(options?.headers).get('authorization'), null)
    assert.equal(new Headers(options?.headers).get('x-api-key'), null)
    assert.equal(options?.redirect, 'error')
    const body = JSON.parse(String(options?.body))
    assert.equal(body.stream, true)
    assert.equal(body.system, 'system')
    assert.deepEqual(body.output_config, { effort: 'high' })
    return stream(complete, 1)
  }) as typeof fetch)
  const response = await provider.chat([{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }], [], { model: 'deepseek-v4-flash' })
  assert.equal(response.content, '你好')
  assert.equal(response.reasoningContent, '考虑')
  assert.deepEqual(response.toolCalls, [{ id: 'call-1', name: 'lookup', arguments: { query: 'weather' } }])
  assert.deepEqual(response.usage, { costIncomplete: true, promptTokens: 15, completionTokens: 5, totalTokens: 20, cachedTokens: 2, cacheWriteTokens: 3 })
})

test('History replays thinking/tool results, maps shared effort aliases and rejects unsupported images/unresolved calls', () => {
  const body = deepseekAccountRequest([
    { role: 'assistant', content: null, reasoning_content: 'reason', tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
    { role: 'tool', content: 'result', tool_call_id: 'a' },
  ], [], { model: 'deepseek-v4-flash', thinking: { type: 'disabled' } })
  assert.deepEqual((body.messages as any[])[0].content[0], { type: 'thinking', thinking: 'reason' })
  assert.equal((body.messages as any[])[1].content[0].tool_use_id, 'a')
  assert.equal(body.output_config, undefined)
  assert.throws(() => deepseekAccountRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }], [], { model: 'm' }), /text and tools/)
  assert.deepEqual(deepseekAccountRequest([], [], { model: 'm', reasoningEffort: 'medium' }).output_config, { effort: 'high' })
  assert.deepEqual(deepseekAccountRequest([], [], { model: 'm', reasoningEffort: 'xhigh' }).output_config, { effort: 'high' })
  assert.throws(() => deepseekAccountRequest([{ role: 'tool', content: '', tool_call_id: 'x' }], [], { model: 'm' }), /no matching/)
})

test('401 invalidates only the rejected grant; no API key fallback; logout aborts in-flight requests', async t => {
  const directory = temporary(t); stored(directory)
  const auth = new DeepSeekAccountAuth(directory, (async () => new Response(null, { status: 204 })) as typeof fetch)
  const old = auth.resolve()
  stored(directory, 'new-synthetic-token')
  auth.reject(old.token)
  assert.equal(auth.resolve().token, 'new-synthetic-token')
  const current = auth.resolve()
  const provider = new DeepSeekAccountProvider(auth, (async () => new Response(null, { status: 401 })) as typeof fetch)
  await assert.rejects(provider.chat([], [], { model: 'm' }), /request rejected/)
  assert.equal(current.signal.aborted, true)
  assert.equal(auth.ready(), false)
  await assert.rejects(provider.chat([], [], { model: 'm' }), /Sign in/)
  stored(directory, 'logout-synthetic-token')
  const lifetime = auth.resolve().signal
  await auth.logout()
  assert.equal(lifetime.aborted, true)
  assert.equal(auth.ready(), false)
})

test('Malformed/truncated/error streams fail, cancellation closes the reader', async t => {
  const directory = temporary(t); stored(directory)
  const auth = new DeepSeekAccountAuth(directory)
  for (const events of [complete.slice(0, -1), [{ type: 'error', error: { message: 'secret must not leak' } }], [{ type: 'content_block_delta', index: 9, delta: {} }]]) {
    const provider = new DeepSeekAccountProvider(auth, (async () => stream(events)) as typeof fetch)
    await assert.rejects(provider.chat([], [], { model: 'm' }))
  }
  let cancelled = false
  const controller = new AbortController()
  const provider = new DeepSeekAccountProvider(auth, (async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))) as typeof fetch)
  const result = provider.chat([], [], { model: 'm', signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(result)
  assert.equal(cancelled, true)
})

test('Factory separates DeepSeek Account from original DeepSeek API-key path', t => {
  const config = ConfigSchema.parse({ agent: { workspace: temporary(t), model: 'deepseek-v4-flash@account' }, providers: { account: { type: 'deepseek-account' }, deepseek: { apiKey: 'synthetic-key' } } })
  assert.equal(resolveProviderSettings(config, 'account').authMode, 'deepseek-account')
  assert.equal(createProvider('deepseek-v4-flash', config, 'account').name, 'deepseek-account')
  assert.equal(createProvider('deepseek-v4-flash', config, 'deepseek').name, 'deepseek')
  config.providers.account.baseUrl = 'https://evil.example'
  assert.throws(() => createProvider('m', config, 'account'), /does not accept/)
})

test('Setup routes register a named account, poll/cancel/login/logout safely and activate the qualified model', async t => {
  const { Hono } = await import('hono')
  const { ConfigStore } = await import('../config/store.ts')
  const { ProviderSetup } = await import('./setup.ts')
  const root = temporary(t)
  const file = join(root, 'config.json')
  writePrivateFile(file, JSON.stringify({ agent: { workspace: root, model: 'deepseek-v4-flash@named' }, providers: { named: { type: 'deepseek-account', name: 'Work account' }, api: { type: 'deepseek', apiKey: 'synthetic-api-key' } } }))
  let config = ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  let init: Record<string, string> = {}
  const auth = new DeepSeekAccountAuth(join(root, 'account'), (async (input, options) => {
    if (String(input).endsWith('/auth_init')) {
      init = JSON.parse(String(options?.body))
      return envelope({ authorize_url: 'https://platform.deepseek.com/dsh/authorize', authorize_id: 'id', expires_in: 60 })
    }
    if (String(input).endsWith('/logout')) return envelope({})
    return envelope({ token, authorized_url: 'https://platform.deepseek.com/dsh/authorized' })
  }) as typeof fetch)
  const store = new ConfigStore({ configPath: file, getConfig: () => config, onChanged: next => { config = next } })
  const { CopilotAuthenticatorV2 } = await import('./copilot-v2.ts')
  const copilot = new CopilotAuthenticatorV2(join(root, 'synthetic-copilot'), { storage: { read: () => undefined, write: () => {}, remove: () => {} } })
  const setup = new ProviderSetup({ store, auth: copilot, getConfig: () => config, accountAuth: (home, id) => { assert.equal(home, root); assert.equal(id, 'named'); return auth } })
  t.after(() => setup.dispose())
  const app = new Hono(); setup.plugin()(app)
  assert.equal((await setup.status()).ready, false)
  assert.equal(setup.configured().find(item => item.provider === 'named')?.authMode, 'deepseek-account')
  assert.equal((await app.request('/api/deepseek-account/login?provider=api', { method: 'POST' })).status, 409)
  const started = await app.request('/api/deepseek-account/login?provider=named', { method: 'POST' })
  assert.equal(started.headers.get('cache-control'), 'no-store')
  const login = await started.json()
  await fetch(`${init.redirect_uri}?state=${init.state}&code=synthetic`)
  for (let i = 0; i < 50 && auth.status(login.loginId)?.state === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const status = await (await app.request(`/api/deepseek-account/login/${login.loginId}?provider=named`)).json()
  assert.equal(status.state, 'succeeded')
  assert.equal(JSON.stringify(status).includes(token), false)
  const saved = await app.request('/api/provider/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'named', type: 'deepseek-account', model: 'deepseek-v4-pro' }) })
  assert.equal((await saved.json()).ready, true)
  assert.equal(config.agent.model, 'deepseek-v4-pro@named')
  assert.equal(config.providers.api.apiKey, 'synthetic-api-key')
  await app.request('/api/deepseek-account/logout?provider=named', { method: 'POST' })
  assert.equal((await setup.status()).ready, false)
  assert.equal(config.providers.api.apiKey, 'synthetic-api-key')
})

test('Failed initialization releases its callback listener and never stores a grant', async t => {
  const directory = temporary(t)
  let callback = ''
  const auth = new DeepSeekAccountAuth(directory, (async (_input, options) => {
    callback = JSON.parse(String(options?.body)).redirect_uri
    return new Response('synthetic-private-upstream-message', { status: 403 })
  }) as typeof fetch)
  await assert.rejects(auth.start(), /third-party access/)
  assert.equal(auth.ready(), false)
  await assert.rejects(fetch(callback))
  await auth.dispose()
})

test('Service TTL expiration closes the loopback listener without credentials', async t => {
  const directory = temporary(t)
  let callback = ''
  const auth = new DeepSeekAccountAuth(directory, (async (_input, options) => {
    callback = JSON.parse(String(options?.body)).redirect_uri
    return envelope({ authorize_url: 'https://platform.deepseek.com/dsh/authorize', authorize_id: 'id', expires_in: 0.01 })
  }) as typeof fetch)
  const login = await auth.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(auth.status(login.loginId)?.state, 'expired')
  assert.equal(auth.ready(), false)
  await assert.rejects(fetch(callback))
  await auth.dispose()
})

test('Main-scoped account home is used by inference in Projects with different homes', async t => {
  const root = temporary(t)
  const home = join(root, 'main')
  stored(join(home, 'config', 'deepseek-account', 'shared'))
  let requests = 0
  t.mock.method(globalThis, 'fetch', (async (_input, options) => {
    requests++
    assert.equal(new Headers(options?.headers).get('x-dsh-auth-token'), token)
    return stream(complete)
  }) as typeof fetch)
  const { createAggregatedProvider } = await import('./factory.ts')
  for (const project of ['project-a', 'project-b']) {
    const config = ConfigSchema.parse({ agent: { workspace: join(root, project), model: 'deepseek-v4-pro@shared' }, providers: { shared: { type: 'deepseek-account' } } })
    const provider = createAggregatedProvider(config, undefined, home)
    const response = await provider.chat([{ role: 'user', content: 'hello' }], [], { model: 'deepseek-v4-pro@shared' })
    assert.equal(response.content, '你好')
    assert.ok((await provider.listModels()).includes('deepseek-v4-pro@shared'))
  }
  assert.equal(requests, 2)
})
