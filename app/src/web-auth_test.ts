import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserSession, mountBrowserSession } from './web-auth.ts'

const paired = { version: 1, required: true, authenticated: true, expiresAt: '2026-09-19T00:00:00Z' }
const unpaired = { version: 1, required: true, authenticated: false }
const now = () => Date.parse('2026-09-18T12:00:00Z')

test('PIN login sends only an explicit PIN body and preserves the existing browser session lifecycle', async t => {
  const calls: RequestInit[] = []
  let attempts = 0
  const session = createBrowserSession('http://fixture', { now, fetch: async (_url, init) => {
    calls.push(init!)
    if (init?.method !== 'POST') return Response.json({ ...unpaired, pinAvailable: true })
    return ++attempts === 1 ? new Response('', { status: 401 }) : Response.json({ ...paired, pinAvailable: true })
  } })
  t.after(() => session.dispose())
  await session.refresh()
  assert.equal(session.status.value?.pinAvailable, true)
  await session.loginWithPin('wrong')
  assert.match(session.error.value, /PIN is incorrect/)
  assert.equal(session.view.value, 'pairing')
  await session.loginWithPin('  fixture-Pin-8371  ')
  assert.equal(calls.at(-1)?.body, JSON.stringify({ pin: 'fixture-Pin-8371' }))
  assert.equal(session.view.value, 'authenticated')
  assert.equal(session.error.value, '')
  await session.logout()
  assert.equal(session.view.value, 'pairing')
  assert.equal(calls.at(-1)?.method, 'DELETE')
})

test('protected app only mounts after verified session; pairing and revocation preserve route and clean up', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const responses = [unpaired, paired, paired, unpaired, paired, unpaired]
  const session = createBrowserSession('http://shadow.local/projects/default/chat/saved', {
    now,
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return Response.json(responses.shift()) },
  })
  t.after(() => session.dispose())
  const lifecycle: string[] = []
  const stop = mountBrowserSession(session, {
    authenticated: () => { lifecycle.push('app'); return () => { lifecycle.push('stop-app') } },
    unauthenticated: () => { lifecycle.push('auth'); return () => { lifecycle.push('stop-auth') } },
  })
  t.after(stop)
  assert.deepEqual(lifecycle, ['auth'])
  await session.refresh()
  assert.deepEqual(lifecycle, ['auth'])
  await session.pair('  synthetic-code  ')
  assert.deepEqual(lifecycle, ['auth', 'stop-auth', 'app'])
  assert.equal(calls[1]?.url, 'http://shadow.local/api/web-auth/pair')
  assert.equal(calls[1]?.init?.body, JSON.stringify({ code: 'synthetic-code' }))
  assert.deepEqual(calls[1]?.init?.headers, { 'Content-Type': 'application/json' })
  await session.refresh()
  assert.equal(lifecycle.length, 3, 'Valid status checks must not remount the current page')
  await session.refresh()
  assert.deepEqual(lifecycle.slice(-2), ['stop-app', 'auth'])
  await session.pair('another-code')
  const logout = session.logout()
  assert.equal(lifecycle.at(-1), 'auth', 'Sign out hides protected content before its request completes')
  await logout
  assert.equal(calls.at(-1)?.init?.method, 'DELETE')
  assert.ok(calls.every(call => call.init?.credentials === 'same-origin' && call.init.cache === 'no-store'))
})

test('legacy local sessions remain compatible but 404, network errors and malformed responses never authorize', async t => {
  for (const response of [
    () => Response.json({ version: 1, required: false, authenticated: true }),
    () => new Response('Not found', { status: 404 }),
    () => { throw new TypeError('Failed to fetch') },
    () => Response.json({ authenticated: true }),
    () => Response.json({ version: 1, required: false, authenticated: false }),
    () => Response.json({ ...paired, expiresAt: 'not-a-date' }),
    () => Response.json({ ...paired, pinAvailable: 'yes' }),
    () => new Response('<html>SPA fallback</html>'),
  ]) {
    const session = createBrowserSession('http://fixture', { now, fetch: async () => response() })
    t.after(() => session.dispose())
    await session.refresh()
    if (session.status.value?.required === false) assert.equal(session.view.value, 'authenticated')
    else {
      assert.equal(session.view.value, 'error')
      assert.ok(session.error.value)
    }
  }
})

test('pairing errors distinguish invalid codes, throttling and server failures and allow retry', async t => {
  for (const [status, message] of [[401, /invalid or expired/], [429, /Too many/], [400, /Check the code/], [500, /HTTP 500/]] as const) {
    let attempt = 0
    const session = createBrowserSession('http://fixture', { now, fetch: async () =>
      attempt++ === 0 ? new Response('', { status }) : Response.json(paired) })
    t.after(() => session.dispose())
    await session.pair('invalid')
    assert.equal(session.view.value, 'pairing')
    assert.match(session.error.value, message)
    await session.pair('valid')
    assert.equal(session.view.value, 'authenticated')
    assert.equal(session.error.value, '')
  }
})

test('expiry hides the app and checks once without a reload or recurring poll', async t => {
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>()
  let timerId = 0
  let requests = 0
  let complete!: (response: Response) => void
  const session = createBrowserSession('http://fixture', {
    now,
    fetch: async () => ++requests === 1 ? Response.json(paired) : new Promise(resolve => { complete = resolve }),
    setTimer: (callback, delay) => {
      const id = ++timerId as unknown as ReturnType<typeof setTimeout>
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer: id => { timers.delete(id) },
  })
  t.after(() => session.dispose())
  await session.refresh()
  assert.equal(timers.size, 1)
  const [id, timer] = [...timers][0]!
  assert.equal(timer.delay, 12 * 60 * 60 * 1000)
  timers.delete(id)
  timer.callback()
  assert.equal(session.view.value, 'checking')
  assert.equal(requests, 2)
  complete(Response.json(unpaired))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.view.value, 'pairing')
  assert.equal(timers.size, 0)
})

test('focus, online and visible status changes recheck session, with listeners removed on cleanup', async t => {
  const target = new EventTarget()
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  let calls = 0
  const session = createBrowserSession('http://fixture', { now, fetch: async () => {
    calls++
    return Response.json(calls === 1 ? paired : unpaired)
  } })
  const stop = session.listen(target as Window, document as Document)
  t.after(() => { stop(); session.dispose() })
  await session.refresh()
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(calls, 1)
  target.dispatchEvent(new Event('focus'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.view.value, 'pairing')
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise(resolve => setImmediate(resolve))
  target.dispatchEvent(new Event('online'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 4)
  stop()
  target.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(calls, 4)
})

test('late status response cannot undo logout and failed logout retries DELETE', async t => {
  let complete!: (response: Response) => void
  const methods: string[] = []
  const session = createBrowserSession('http://fixture', { now, fetch: async (_url, init) => {
    methods.push(init!.method!)
    if (methods.length === 1) return new Promise(resolve => { complete = resolve })
    return methods.length === 2 ? new Response('', { status: 503 }) : Response.json(unpaired)
  } })
  t.after(() => session.dispose())
  const checking = session.refresh()
  await session.logout()
  assert.equal(session.view.value, 'error')
  complete(Response.json(paired))
  await checking
  assert.equal(session.view.value, 'error')
  await session.retry()
  assert.deepEqual(methods, ['GET', 'DELETE', 'DELETE'])
  assert.equal(session.view.value, 'pairing')
})

test('unreachable bootstrap retries successfully and disposed sessions stop checking', async () => {
  let calls = 0
  const session = createBrowserSession('http://fixture', { now, fetch: async () => {
    if (++calls === 1) throw new TypeError('offline')
    return Response.json(paired)
  } })
  await session.refresh()
  assert.equal(session.view.value, 'error')
  await session.retry()
  assert.equal(session.view.value, 'authenticated')
  session.dispose()
  await session.refresh()
  assert.equal(calls, 2)
})

test('expired status is never mounted and does not schedule another check', async t => {
  let requests = 0
  const session = createBrowserSession('http://fixture', { now, fetch: async () => {
    requests++
    return Response.json({ ...paired, expiresAt: '2026-09-18T11:59:59Z' })
  } })
  t.after(() => session.dispose())
  const stop = mountBrowserSession(session, {
    authenticated: () => { assert.fail('Expired session mounted protected content') },
    unauthenticated: () => () => {},
  })
  t.after(stop)
  await session.refresh()
  assert.equal(session.view.value, 'pairing')
  assert.equal(requests, 1)
})

test('a slow bootstrap has a bounded timeout and duplicate refreshes share the pending check', async t => {
  let timeout!: () => void
  let calls = 0
  const session = createBrowserSession('http://fixture', {
    fetch: async (_url, init) => {
      calls++
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    },
    setTimer: (callback, delay) => {
      assert.equal(delay, 15_000)
      timeout = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
  })
  t.after(() => session.dispose())
  const pending = session.refresh()
  await session.refresh()
  assert.equal(calls, 1)
  timeout()
  await pending
  assert.equal(session.view.value, 'error')
  assert.equal(session.busy.value, false)
  assert.match(session.error.value, /did not respond in time/)
})

test('disposing while status is in flight ignores its late authenticated response', async () => {
  let finish!: (response: Response) => void
  const session = createBrowserSession('http://fixture', { now, fetch: async () => new Promise(resolve => { finish = resolve }) })
  const pending = session.refresh()
  session.dispose()
  finish(Response.json(paired))
  await pending
  assert.notEqual(session.view.value, 'authenticated')
})

test('temporary startup 503 remains gated and automatically retries; expired-session 401 returns to pairing', async t => {
  const responses = [
    new Response('', { status: 503 }),
    Response.json(paired),
    Response.json({ error: 'unauthorized' }, { status: 401 }),
  ]
  const session = createBrowserSession('http://fixture', { now, fetch: async () => responses.shift()! })
  t.after(() => session.dispose())
  const checking = session.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.view.value, 'checking')
  assert.equal(session.busy.value, true)
  assert.equal(session.error.value, '')
  await checking
  assert.equal(session.view.value, 'authenticated')
  await session.refresh()
  assert.equal(session.view.value, 'pairing')
  assert.equal(session.status.value?.authenticated, false)
})

test('startup 503 retries stay within one timeout and stop on disposal or logout', async () => {
  for (const action of ['timeout', 'dispose', 'logout'] as const) {
    const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>()
    let timerId = 0
    const methods: string[] = []
    const session = createBrowserSession('http://fixture', {
      fetch: async (_url, init) => {
        methods.push(init!.method!)
        return init!.method === 'DELETE' ? Response.json(unpaired) : new Response('', { status: 503 })
      },
      setTimer: (callback, delay) => {
        const id = ++timerId as unknown as ReturnType<typeof setTimeout>
        timers.set(id, { callback, delay })
        return id
      },
      clearTimer: id => { timers.delete(id) },
    })
    const pending = session.refresh()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(session.view.value, 'checking')
    await session.refresh()
    assert.deepEqual(methods, ['GET'], 'Duplicate checks must not start another retry loop')
    assert.deepEqual([...timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [1_000, 15_000])
    const deadline = [...timers.values()].find(timer => timer.delay === 15_000)!
    const [retryId, retry] = [...timers].find(([, timer]) => timer.delay === 1_000)!
    timers.delete(retryId)
    retry.callback()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(methods, ['GET', 'GET'])
    assert.equal([...timers.values()].find(timer => timer.delay === 15_000), deadline,
      'Retries must not reset the overall startup deadline')
    if (action === 'timeout') {
      deadline.callback()
    } else if (action === 'dispose') session.dispose()
    else await session.logout()
    await pending
    assert.equal(timers.size, 0)
    if (action === 'timeout') {
      assert.equal(session.view.value, 'error')
      assert.match(session.error.value, /did not respond in time/)
    } else if (action === 'logout') {
      assert.deepEqual(methods, ['GET', 'GET', 'DELETE'])
      assert.equal(session.view.value, 'pairing')
    } else assert.notEqual(session.view.value, 'authenticated')
    session.dispose()
  }
})

test('503 pairing submissions are never automatically replayed', async t => {
  let calls = 0
  const session = createBrowserSession('http://fixture', { fetch: async () => {
    calls++
    return new Response('', { status: 503 })
  } })
  t.after(() => session.dispose())
  await session.pair('synthetic-single-use-code')
  assert.equal(calls, 1)
  assert.equal(session.view.value, 'pairing')
  assert.match(session.error.value, /HTTP 503/)
})
