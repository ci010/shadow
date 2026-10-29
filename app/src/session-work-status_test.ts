import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionWorkStatus } from './session-work-status.ts'

const empty = { records: [], effects: [] }

test('session work missing is terminal for revisions, but explicit retry and new identity recover', async () => {
  let requests = 0
  let available = false
  const request: typeof fetch = async () => {
    requests++
    return available ? Response.json(empty) : Response.json({ error: 'session_not_found' }, { status: 404 })
  }
  const snapshot = createSessionWorkStatus('http://fixture/projects/a', 'web:draft', request, 0)
  try {
    await snapshot.autoRefresh()
    assert.match(snapshot.state.error, /conversation is no longer/)
    for (let i = 0; i < 10; i++) await snapshot.autoRefresh()
    snapshot.pause()
    await snapshot.autoRefresh()
    assert.equal(requests, 1)
    available = true
    await snapshot.refresh()
    assert.equal(snapshot.state.error, '')
    assert.deepEqual(snapshot.state.value, empty)
    await snapshot.autoRefresh()
    assert.equal(requests, 3)
  } finally { snapshot.dispose() }
  const next = createSessionWorkStatus('http://fixture/projects/b', 'web:other', request, 0)
  try { await next.autoRefresh(); assert.equal(requests, 4) } finally { next.dispose() }
})

test('queued revisions and late aborted missing replies never cause extra HTTP reads', async () => {
  let requests = 0
  let finish!: (response: Response) => void
  const request: typeof fetch = async () => { requests++; return new Promise(resolve => { finish = resolve }) }
  const snapshot = createSessionWorkStatus('http://fixture', 'web:test', request, 0)
  try {
    const first = snapshot.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    const queued = snapshot.autoRefresh()
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await Promise.all([first, queued])
    assert.equal(requests, 1)
  } finally { snapshot.dispose() }
  const next = createSessionWorkStatus('http://fixture', 'web:test', request, 0)
  try {
    const pending = next.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    next.pause()
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await pending
    await new Promise(resolve => setTimeout(resolve, 10))
    const retry = next.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(requests, 3)
    finish(Response.json(empty))
    await retry
    assert.equal(next.state.error, '')
  } finally { next.dispose() }
})

for (const [status, body] of [[404, { error: 'unknown_route' }], [403, {}], [500, {}], [200, {}]] as const) {
  test(`session work non-terminal ${status} errors remain visible and retryable`, async () => {
    let requests = 0
    const snapshot = createSessionWorkStatus('http://fixture', 'web:test', async () => {
      requests++
      return Response.json(body, { status })
    }, 0)
    try {
      await snapshot.autoRefresh()
      assert.notEqual(snapshot.state.error, '')
      await snapshot.autoRefresh()
      assert.equal(requests, 2)
    } finally { snapshot.dispose() }
  })
}

test('session work empty draft identity does not discover', async () => {
  let requests = 0
  const snapshot = createSessionWorkStatus('http://fixture', '', async () => { requests++; return Response.json(empty) }, 0)
  try { await snapshot.autoRefresh(); assert.equal(requests, 0) } finally { snapshot.dispose() }
})

test('a matching completed turn reconciles an initially unpersisted draft once', async () => {
  let requests = 0
  let available = false
  const snapshot = createSessionWorkStatus('http://fixture', 'web:draft', async () => {
    requests++
    return available ? Response.json(empty) : Response.json({ error: 'session_not_found' }, { status: 404 })
  }, 0)
  try {
    await snapshot.autoRefresh()
    for (const payload of [
      { event: 'invalidate', sessionId: 'other', completedTurnId: 'turn-1' },
      { event: 'invalidate', sessionId: 'web:draft' },
      { event: 'invalidate', sessionId: 'web:draft', completedTurnId: '' },
      { event: 'activity', sessionId: 'web:draft', completedTurnId: 'turn-1' },
    ]) await snapshot.reconcile(payload)
    assert.equal(requests, 1)
    const completed = { event: 'invalidate', sessionId: 'web:draft', completedTurnId: 'turn-1' }
    await snapshot.reconcile(completed)
    await snapshot.reconcile(completed)
    assert.equal(requests, 2)
    available = true
    await snapshot.reconcile({ ...completed, completedTurnId: 'turn-2' })
    assert.equal(requests, 3)
    assert.equal(snapshot.state.error, '')
  } finally { snapshot.dispose() }
})

test('completed turn during an in-flight draft 404 schedules a fresh persisted read', async () => {
  let requests = 0
  let finish!: (response: Response) => void
  const snapshot = createSessionWorkStatus('http://fixture', 'web:draft', async () => {
    requests++
    if (requests > 1) return Response.json(empty)
    return new Promise(resolve => { finish = resolve })
  }, 0)
  try {
    const first = snapshot.autoRefresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    const reconciled = snapshot.reconcile({ event: 'invalidate', sessionId: 'web:draft', completedTurnId: 'turn-1' })
    finish(Response.json({ error: 'session_not_found' }, { status: 404 }))
    await Promise.all([first, reconciled])
    assert.equal(requests, 2)
    assert.equal(snapshot.state.error, '')
  } finally { snapshot.dispose() }
})
