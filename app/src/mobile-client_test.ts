import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createMobileFetch, createMobileSession, isMobileBusinessPath, mobileBootTarget, parseMobileCredentials, validateMainOrigin, type CredentialStore, type MobileCredentials } from './mobile-client.ts'
import { createFetchEventSource, createSseParser } from './mobile-sse.ts'
import { mobileResourcePath, validateResourceTicket, vMobileMedia } from './mobile-resources.ts'
import { createMobileClientContext } from './installation-context.ts'
import { navigationFor } from './navigation-policy.ts'
import { createLiveClient } from './live-client.ts'

const expiresAt = () => new Date(Date.now() + 60 * 60_000).toISOString()
const credential = (): MobileCredentials => ({ version: 1, origin: 'https://main.example', accessToken: 'synthetic-opaque-access-token', expiresAt: expiresAt() })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function storage(initial: string | null = null) {
  let value = initial
  const writes: Array<string | null> = []
  const store: CredentialStore = {
    async get() { return { value } },
    async set(next) { value = next.value; writes.push(value) },
    async remove() { value = null; writes.push(null) },
  }
  return { store, writes, get: () => value }
}
const response = () => Response.json({ version: 1, authenticated: true, expiresAt: expiresAt() })

test('Main endpoint accepts only a canonical HTTPS origin', () => {
  assert.equal(validateMainOrigin(' https://MAIN.example:443/ '), 'https://main.example')
  assert.equal(validateMainOrigin('https://[::1]:444'), 'https://[::1]:444')
  for (const value of ['http://main.example', 'https://u:p@main.example', 'https://main.example/api', 'https://main.example?x=1',
    'https://main.example#x', 'https://main.example?', 'https://main.example#', 'https://main.example\\evil', '//main.example', 'file:///main', 'https:main.example']) {
    assert.throws(() => validateMainOrigin(value), undefined, value)
  }
})

test('mobile gating and policy cannot become desktop, browser admin, or execution Child', async () => {
  assert.equal(mobileBootTarget('mobile', true), 'native')
  assert.equal(mobileBootTarget('mobile', false), 'unavailable')
  assert.equal(mobileBootTarget('production', true), 'standard')
  const context = createMobileClientContext('https://main.example')
  assert.equal(context.mode, 'client')
  assert.equal(context.uiScopes.includes('nodes:admin'), false)
  assert.deepEqual(navigationFor(context).map(item => item.name), ['chat', 'settings', 'agents', 'spans', 'logs'])
  const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(main, /if \(import\.meta\.env\.MODE !== 'mobile'\) void registerBrowserPwa/)
  assert.match(main, /if \(import\.meta\.env\.MODE === 'mobile'\)[\s\S]*?await import\('\.\/mobile-bootstrap\.ts'\)[\s\S]*?else if \(desktopApi\)/)
  const bootstrap = await readFile(new URL('./mobile-bootstrap.ts', import.meta.url), 'utf8')
  assert.match(bootstrap, /Capacitor\.isNativePlatform\(\)/)
  assert.doesNotMatch(bootstrap, /CapacitorHttp|createBrowserSession|localStorage|sessionStorage/)
})

test('saved credentials are versioned, origin-bound, and reject expired or malformed values', () => {
  const saved = credential()
  assert.deepEqual(parseMobileCredentials(JSON.stringify(saved)), saved)
  for (const value of [
    { ...credential(), version: 2 }, { ...credential(), origin: 'http://main.example' },
    { ...credential(), accessToken: 'x\r\nbad' }, { ...credential(), expiresAt: 'invalid' },
    { ...credential(), expiresAt: new Date(0).toISOString() },
  ]) assert.throws(() => parseMobileCredentials(JSON.stringify(value)))
})

test('fetch adapter preserves Request/init bodies headers and signals; redirects and cookies are disabled', async () => {
  const calls: Request[] = []
  const lifetime = new AbortController()
  const caller = new AbortController()
  const request = createMobileFetch({
    fetch: async input => { calls.push(input as Request); return response() },
    credentials: credential, webviewOrigin: 'https://localhost', signal: () => lifetime.signal,
    unauthorized() { assert.fail('unexpected auth loss') },
  })
  await request(new Request('https://localhost/projects/a/api/chat', {
    method: 'POST', body: JSON.stringify({ text: 'hello' }), headers: { 'x-fixture': 'kept' }, signal: caller.signal,
  }))
  assert.equal(calls[0].url, 'https://main.example/projects/a/api/chat')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.get('x-fixture'), 'kept')
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${credential().accessToken}`)
  assert.equal(await calls[0].text(), '{"text":"hello"}')
  assert.equal(calls[0].credentials, 'omit')
  assert.equal(calls[0].redirect, 'error')
  caller.abort()
  assert.equal(calls[0].signal.aborted, true)
  await request('/api/live')
  lifetime.abort()
  assert.equal(calls[1].signal.aborted, true)
})

test('external URLs never inherit Main bearer; forbidden paths fail before network access', async () => {
  const calls: Request[] = []
  const request = createMobileFetch({
    fetch: async input => { calls.push(input as Request); return response() },
    credentials: credential, webviewOrigin: 'https://localhost', signal: () => new AbortController().signal, unauthorized() {},
  })
  await request('https://external.example/tool', { headers: { authorization: `Bearer ${credential().accessToken}` } })
  assert.equal(calls[0].headers.has('authorization'), false)
  assert.equal(calls[0].credentials, 'omit')
  assert.equal(calls[0].redirect, 'error')
  for (const path of ['/local/v1/nodes', '/cluster/v1', '/pair/v1/offers', '/nodes/v1/network', '/projects/a/local/v1', '/api/nodes', '/mobile/v1/pair']) {
    assert.equal(isMobileBusinessPath(path), false)
    await assert.rejects(request(`https://main.example${path}`), /not available/)
  }
  assert.equal(calls.length, 1)
})

test('diagnostic queries and inventory are read-only; device mutation routes remain unavailable', () => {
  for (const path of ['/v1/query/logs', '/projects/a/v1/query/spans', '/host/v1/query/session-spans', '/nodes/v1']) {
    assert.equal(isMobileBusinessPath(path, 'GET'), true, path)
    assert.equal(isMobileBusinessPath(path, 'POST'), false, path)
    assert.equal(isMobileBusinessPath(path, 'DELETE'), false, path)
  }
  for (const path of ['/nodes/v1/pending', '/nodes/v1/network', '/host/v1/admin', '/projects/a/nodes/v1']) {
    assert.equal(isMobileBusinessPath(path, 'GET'), false, path)
  }
})

test('401 unmount signal fires and no disconnected request falls back to local webview', async () => {
  let lost = 0
  const options = {
    fetch: async () => new Response(null, { status: 401 }),
    credentials: () => credential() as MobileCredentials | undefined,
    webviewOrigin: 'capacitor://localhost', signal: () => new AbortController().signal, unauthorized() { lost++ },
  }
  await createMobileFetch(options)('https://main.example/api/projects')
  assert.equal(lost, 1)
  options.credentials = () => undefined
  await assert.rejects(createMobileFetch(options)('/api/projects'), /Connect/)
})

test('pairing uses native secure storage only; background aborts, resume revalidates, and auth loss clears', async t => {
  const saved = storage()
  let denied = false
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const session = createMobileSession(saved.store, async (input, init) => {
    calls.push({ url: String(input), init })
    if (String(input).endsWith('/pair')) return Response.json(credential())
    return denied ? new Response(null, { status: 401 }) : response()
  })
  t.after(() => session.dispose())
  await session.load()
  assert.equal(session.view.value, 'pairing')
  await session.pair('https://main.example', 'abcdef-abcdef-abcdef-abcdef')
  assert.equal(session.view.value, 'connected')
  assert.equal(saved.writes.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(saved.get()!)).sort(), ['accessToken', 'expiresAt', 'origin', 'version'])
  assert.equal(new Headers(calls[0].init?.headers).has('authorization'), false)
  const signal = session.signal()
  session.setActive(false)
  assert.equal(signal.aborted, true)
  assert.equal(session.view.value, 'paused')
  session.setActive(true)
  await flush()
  assert.equal(session.view.value, 'connected')
  assert.equal(calls.at(-1)?.url, 'https://main.example/mobile/v1/session')
  denied = true
  await session.refresh()
  assert.equal(session.view.value, 'pairing')
  assert.equal(saved.get(), null)
  assert.match(session.error.value, /expired|revoked/)
})

test('secure store read/write/remove errors remain actionable; no browser persistence fallback', async t => {
  const readFailure = createMobileSession({
    async get() { throw new Error('unavailable') }, async set() {}, async remove() {},
  }, async () => response())
  t.after(() => readFailure.dispose())
  await readFailure.load()
  assert.equal(readFailure.view.value, 'error')
  assert.match(readFailure.error.value, /secure storage/)
  const writeFailure = createMobileSession({
    async get() { return { value: null } }, async set() { throw new Error('unavailable') }, async remove() { throw new Error('locked') },
  }, async () => Response.json(credential()))
  t.after(() => writeFailure.dispose())
  await writeFailure.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
  assert.equal(writeFailure.view.value, 'pairing')
  assert.equal(writeFailure.credentials(), undefined)
  assert.match(writeFailure.error.value, /secure storage/)
  await writeFailure.disconnect()
  assert.equal(writeFailure.view.value, 'error')
  assert.match(writeFailure.error.value, /clear credentials/)
})

test('network and malformed protocol failures never mount an authenticated app', async t => {
  for (const request of [
    async () => { throw new TypeError('network') },
    async () => Response.json({ version: 7, accessToken: 'synthetic-opaque-access-token', expiresAt: expiresAt() }),
  ]) {
    const saved = storage()
    const session = createMobileSession(saved.store, request)
    t.after(() => session.dispose())
    await session.pair('https://main.example', 'abcdefabcdefabcdefabcdef')
    assert.equal(session.view.value, 'pairing')
    assert.ok(session.error.value)
    assert.equal(saved.get(), null)
  }
})

test('resource tickets cover exact media/raw/artifact files, not arbitrary URLs or API calls', () => {
  const origin = 'https://main.example'
  for (const path of ['/projects/p/api/media?path=x', '/api/sessions/web%3Ax/raw?path=x', '/api/folders/f/raw?path=x', '/projects/p/api/io/runs/r/artifacts/a']) {
    assert.equal(mobileResourcePath(origin + path, origin), path)
    const data = { version: 1, url: origin + path + (path.includes('?') ? '&' : '?') + 'ticket=short-lived', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    assert.equal(validateResourceTicket(data, path, origin).url, data.url)
    assert.throws(() => validateResourceTicket({ ...data, url: data.url.replace(origin, 'https://evil.example') }, path, origin))
    assert.throws(() => validateResourceTicket({ ...data, url: origin + '/api/media?ticket=wrong' }, path, origin))
  }
  assert.equal(mobileResourcePath('/api/sessions/s/static/docs/image.png', origin), '/api/sessions/s/raw?path=docs%2Fimage.png')
  assert.equal(mobileResourcePath('/api/sessions/s/static/docs/%broken.png', origin), null)
  for (const path of ['/api/chat', '/cluster/v1', 'https://evil.example/api/media', '/api/sessions/s/raw/extra']) assert.equal(mobileResourcePath(path, origin), null)
})

test('renewed media tickets preserve playback position and clean metadata listeners on unmount', () => {
  let listener: (() => void) | undefined
  let played = 0
  const element = {
    currentTime: 42, paused: false, ended: false,
    play() { played++; return Promise.resolve() },
    addEventListener(_name: string, callback: () => void) { listener = callback },
    removeEventListener() { listener = undefined },
  } as unknown as HTMLMediaElement
  const hook = vMobileMedia.beforeUpdate as Function
  hook(element, { value: 'same-file', oldValue: 'same-file' }, { props: { src: '?ticket=new' } }, { props: { src: '?ticket=old' } })
  assert.ok(listener)
  element.currentTime = 0
  listener()
  assert.equal(element.currentTime, 42)
  assert.equal(played, 1)
  assert.equal(listener, undefined)
  hook(element, { value: 'same-file', oldValue: 'same-file' }, { props: { src: '?ticket=next' } }, { props: { src: '?ticket=new' } })
  ;(vMobileMedia.beforeUnmount as Function)(element)
  assert.equal(listener, undefined)
})

test('SSE parser supports split CRLF, multiline frames, comments, and event names', () => {
  const frames: Array<[string, string]> = []
  const parse = createSseParser((type, data) => frames.push([type, data]))
  for (const part of [': heartbeat\r', '\nevent: realtime\r\ndata: one\r', '\ndata: two\r', '\n\r', '\ndata: three\n\n']) parse(part)
  assert.deepEqual(frames, [['realtime', 'one\ntwo'], ['message', 'three']])
})

test('fetch SSE closes streaming reader and reports EOF for existing live reconnect logic', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: realtime\ndata: ok\n\n')) },
    cancel() { cancelled = true },
  })
  const source = createFetchEventSource('https://main.example/api/live', async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
  const data: string[] = []
  source.addEventListener('realtime', event => data.push((event as MessageEvent).data))
  await flush()
  assert.deepEqual(data, ['ok'])
  source.close()
  await flush()
  assert.equal(cancelled, true)
  const ended = createFetchEventSource('https://main.example/api/live', async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }))
  let errors = 0
  ended.addEventListener('error', () => errors++)
  await flush()
  assert.equal(errors, 1)
  ended.close()
})

test('live retry clears cursor and reconstructs subscriber history; disposal stops reconnects', async t => {
  const sources: EventTarget[] = []
  const urls: string[] = []
  let closed = 0
  const resets: string[] = []
  const client = createLiveClient('https://main.example', {
    source(url) { urls.push(url); const source = new EventTarget(); sources.push(source); return { addEventListener: source.addEventListener.bind(source), close() { closed++ } } },
  })
  t.after(() => client.dispose())
  const subscription = client.subscribe({ kind: 'chat', projectId: 'default', sessionId: 'web:chat' }, { event() {}, reset: reason => resets.push(reason) })
  await new Promise(resolve => setTimeout(resolve, 10))
  sources[0].dispatchEvent(new MessageEvent('realtime', { data: JSON.stringify({ type: 'ready', cursor: '00000000-0000-4000-8000-000000000000:1' }) }))
  assert.deepEqual(resets, ['subscription'])
  client.retry()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(new URL(urls[1]).searchParams.has('cursor'), false)
  sources[1].dispatchEvent(new MessageEvent('realtime', { data: JSON.stringify({ type: 'ready', cursor: '00000000-0000-4000-8000-000000000000:2' }) }))
  assert.deepEqual(resets, ['subscription', 'subscription'])
  assert.equal(sources.length, 2)
  assert.equal(closed, 1)
  subscription.close()
  client.dispose()
  assert.equal(closed, 2)
})
