import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChildWorkspaceConnection } from './child-workspace.ts'

test('Child starts checking, enters workspace without another invitation, falls back offline and reconnects', async () => {
  let status = 503
  const scheduled: Array<{ action: () => void; delay: number }> = []
  const connection = createChildWorkspaceConnection('http://127.0.0.1:3123', {
    fetch: async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:3123/api/projects')
      assert.equal(init?.cache, 'no-store')
      assert.equal(new Headers(init?.headers).has('Authorization'), false, 'device identity never enters renderer')
      return Response.json({ projects: [] }, { status })
    },
    setTimer: ((action: () => void, delay: number) => { scheduled.push({ action, delay }); return 1 }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  })
  assert.equal(connection.checking.value, true)
  assert.equal(connection.available.value, false)
  await connection.refresh()
  assert.equal(connection.checking.value, false)
  assert.equal(connection.available.value, false)
  assert.equal(scheduled.at(-1)?.delay, 30000)
  status = 200; await connection.refresh()
  assert.equal(connection.available.value, true)
  assert.equal(scheduled.at(-1)?.delay, 30000)
  status = 503; await connection.refresh()
  assert.equal(connection.available.value, false)
  status = 200; await connection.refresh()
  assert.equal(connection.available.value, true)
  connection.dispose()
  const count = scheduled.length
  await connection.refresh()
  assert.equal(scheduled.length, count)
})

test('disposing Child workspace aborts an in-flight check and ignores its late response', async () => {
  let signal: AbortSignal | undefined
  let finish!: (response: Response) => void
  const connection = createChildWorkspaceConnection('http://127.0.0.1:3123', {
    fetch: async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(resolve => { finish = resolve }) },
  })
  const check = connection.refresh()
  connection.dispose()
  assert.equal(signal?.aborted, true)
  finish(Response.json({ projects: [] }))
  await check
  assert.equal(connection.available.value, false)
})

test('workspace displays safe concrete HTTP diagnostics and clears them after recovery', async () => {
  let response = Response.json({ error: 'main_workspace_challenge_http_404' }, { status: 503 })
  const connection = createChildWorkspaceConnection('http://127.0.0.1:3123', { fetch: async () => response })
  try {
    await connection.refresh()
    assert.equal(connection.error.value, 'main_workspace_challenge_http_404 (HTTP 503)')
    response = Response.json({ error: 'Bearer secret with spaces' }, { status: 401 })
    await connection.refresh()
    assert.equal(connection.error.value, 'main_workspace_http_error (HTTP 401)')
    response = Response.json({ projects: [] })
    await connection.refresh()
    assert.equal(connection.error.value, null)
    assert.equal(connection.available.value, true)
  } finally { connection.dispose() }
})

test('hidden Child pauses health reads and resumes immediately when visible', async () => {
  const page = Object.assign(new EventTarget(), { hidden: true })
  let reads = 0
  let callback!: () => void
  const connection = createChildWorkspaceConnection('http://fixture', {
    document: page,
    fetch: async () => { reads++; return Response.json({ projects: [] }) },
    setTimer: ((action: () => void) => { callback = action; return 1 }) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  })
  await connection.refresh(); assert.equal(reads, 0)
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1)
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'))
  callback(); assert.equal(reads, 1)
  connection.dispose()
})

test('Child probes before bootstrap, then shares host live health and cleans up', async () => {
  const page = Object.assign(new EventTarget(), { hidden: false })
  let status!: (value: import('./live-client.ts').LiveStatus) => void
  let reads = 0
  let stopped = 0
  let nextId = 0
  const timers = new Map<number, () => void>()
  const connection = createChildWorkspaceConnection('http://fixture', {
    document: page,
    observeHost: (base, callback) => {
      assert.equal(base, 'http://fixture')
      status = callback; callback({ phase: 'idle' })
      return () => { stopped++ }
    },
    fetch: async () => { reads++; return Response.json({ projects: [] }) },
    setTimer: ((action: () => void, delay: number) => {
      assert.equal(delay, 30_000); timers.set(++nextId, action); return nextId
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { timers.delete(id) }) as unknown as typeof clearTimeout,
  })
  assert.equal(timers.size, 0, 'observer must not block or replace the initial probe')
  await connection.refresh()
  assert.equal(reads, 1)
  assert.equal(connection.available.value, true)
  assert.equal(timers.size, 1)
  status({ phase: 'live' })
  assert.equal(timers.size, 0)
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'))
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'))
  assert.equal(reads, 1, 'healthy visible return reuses live status')
  await connection.refresh()
  assert.equal(reads, 2, 'explicit Retry still reads while live')
  assert.equal(timers.size, 0)
  status({ phase: 'reconnecting' })
  assert.equal(timers.size, 1)
  const action = [...timers.values()][0]; timers.clear(); action()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 3)
  status({ phase: 'live' }); assert.equal(timers.size, 0)
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'))
  status({ phase: 'error' }); assert.equal(timers.size, 0)
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 4)
  connection.dispose()
  assert.equal(stopped, 1)
  assert.equal(timers.size, 0)
  status({ phase: 'error' })
  page.dispatchEvent(new Event('visibilitychange'))
  await connection.refresh()
  assert.equal(reads, 4)
  assert.equal(timers.size, 0)
})

test('repeated reconnect phases preserve the original HTTP fallback deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let status!: (value: import('./live-client.ts').LiveStatus) => void
  let reads = 0
  const connection = createChildWorkspaceConnection('http://fixture', {
    observeHost: (_base, callback) => {
      status = callback; callback({ phase: 'idle' }); return () => {}
    },
    fetch: async () => { reads++; return Response.json({ projects: [] }) },
  })
  t.after(() => connection.dispose())
  await connection.refresh()
  status({ phase: 'live' })
  status({ phase: 'reconnecting' })
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(5000)
    status({ phase: i % 2 ? 'reconnecting' : 'connecting' })
    assert.equal(reads, 1)
  }
  t.mock.timers.tick(4999)
  assert.equal(reads, 1)
  status({ phase: 'error' })
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 2, 'fallback executes 30s after initial disconnection despite phase churn')
  status({ phase: 'live' })
  t.mock.timers.tick(60_000)
  assert.equal(reads, 2)
})
