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
  assert.equal(scheduled.at(-1)?.delay, 3000)
  status = 200; await connection.refresh()
  assert.equal(connection.available.value, true)
  assert.equal(scheduled.at(-1)?.delay, 10000)
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
