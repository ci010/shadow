import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { type TestContext } from 'node:test'
import { TaskbarActivity } from './taskbar-activity.js'

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly progress: unknown[][] = []
  isDestroyed = () => this.destroyed
  setProgressBar = (value: number, options?: { mode: 'indeterminate' }) => {
    assert.equal(this.destroyed, false)
    this.progress.push(options ? [value, options] : [value])
  }
}

const authorization = { apiBase: 'http://127.0.0.1:3123', launchToken: 'synthetic-taskbar-token' }
const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(t: TestContext) {
  const window = new FakeWindow()
  const errors: string[] = []
  const calls: { url: URL; init: RequestInit }[] = []
  let projects = ['default', 'second-project']
  const responses = new Map<string, () => Response>([
    ['default', () => Response.json({ stages: { sameSession: 'idle' } })],
    ['second-project', () => Response.json({ stages: { sameSession: 'inactive' } })],
  ])
  const activity = new TaskbarActivity(window, {
    onError: message => { errors.push(message) },
    fetch: async (input, init) => {
      const url = new URL(input)
      calls.push({ url, init: init! })
      assert.equal(url.origin, authorization.apiBase)
      assert.equal(init?.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${authorization.launchToken}`)
      if (url.pathname === '/api/projects') return Response.json({ projects: projects.map(id => ({ id })) })
      const id = url.pathname.split('/')[2]!
      assert.equal(url.pathname, `/projects/${id}/api/sessions/stages`)
      return responses.get(id)!()
    },
  })
  t.after(() => activity.dispose())
  return { window, activity, responses, errors, calls, setProjects: (ids: string[]) => { projects = ids } }
}

test('native progress aggregates every project, survives partial completion and clears at the last idle turn', async t => {
  const f = fixture(t)
  assert.equal(f.calls.length, 0, 'No requests before Main authorization')
  f.responses.set('second-project', () => Response.json({ stages: { sameSession: 'llm' } }))
  f.activity.setAuthorization(authorization)
  await settle()
  assert.deepEqual(f.window.progress, [[-1], [2, { mode: 'indeterminate' }]])
  assert.equal(f.calls.length, 3)
  for (const phase of ['tool', 'waiting']) {
    f.responses.set('second-project', () => Response.json({ stages: { sameSession: phase } }))
    await f.activity.refresh()
    assert.equal(f.window.progress.length, 2, 'Do not reset the native animation on each snapshot')
  }
  f.responses.set('default', () => Response.json({ stages: { sameSession: 'tool' } }))
  f.responses.set('second-project', () => Response.json({ stages: { sameSession: 'idle' } }))
  await f.activity.refresh()
  assert.equal(f.window.progress.length, 2)
  f.responses.set('default', () => Response.json({ stages: { sameSession: 'inactive' } }))
  await f.activity.refresh()
  assert.deepEqual(f.window.progress.at(-1), [-1])
  assert.deepEqual(f.errors, [])
})

test('catalog refresh includes new projects and drops deleted ones without reading their sessions again', async t => {
  const f = fixture(t)
  f.setProjects(['default'])
  f.activity.setAuthorization(authorization)
  await settle()
  f.responses.set('second-project', () => Response.json({ stages: { task: 'tool' } }))
  f.setProjects(['default', 'second-project'])
  await f.activity.refresh()
  assert.deepEqual(f.window.progress.at(-1), [2, { mode: 'indeterminate' }])
  f.setProjects(['default'])
  const before = f.calls.length
  await f.activity.refresh()
  assert.equal(f.calls.length - before, 2)
  assert.deepEqual(f.window.progress.at(-1), [-1])
})

test('malformed or failed snapshots are reported without hiding another project still working', async t => {
  const f = fixture(t)
  f.responses.set('default', () => Response.json({ error: 'unavailable' }, { status: 503 }))
  f.responses.set('second-project', () => Response.json({ stages: { task: 'llm' } }))
  f.activity.setAuthorization(authorization)
  await settle()
  assert.deepEqual(f.window.progress.at(-1), [2, { mode: 'indeterminate' }])
  assert.match(f.errors[0]!, /HTTP 503/)
  await f.activity.refresh()
  assert.equal(f.errors.length, 1, 'Deduplicate persistent failures, not every poll')
  for (const invalid of [null, { stages: [] }, { stages: { task: ['llm'] } }, { stages: { task: 'unknown' } }]) {
    f.responses.set('default', () => Response.json(invalid))
    await f.activity.refresh()
    assert.deepEqual(f.window.progress.at(-1), [2, { mode: 'indeterminate' }])
    assert.match(f.errors.at(-1)!, /Invalid session activity/)
  }
  f.responses.set('second-project', () => Response.json({ stages: {} }))
  await f.activity.refresh()
  assert.deepEqual(f.window.progress.at(-1), [-1], 'Unknown activity must not leave a stale endless spinner')
})

test('starting and failed project runtimes cannot run agents and are not retried or initialized by observation', async t => {
  const f = fixture(t)
  for (const [id, state] of [['default', 'starting'], ['second-project', 'failed']]) {
    f.responses.set(id!, () => Response.json({ state, error: 'project_unavailable' }, { status: 503 }))
  }
  f.activity.setAuthorization(authorization)
  await settle()
  assert.deepEqual(f.errors, [])
  assert.deepEqual(f.window.progress, [[-1]])
  assert.equal(f.calls.length, 3)
})

test('revoked or replaced authorization aborts reads and stale results cannot restore progress', async t => {
  const window = new FakeWindow()
  const requests: { url: URL; init: RequestInit; resolve: (response: Response) => void }[] = []
  const activity = new TaskbarActivity(window, {
    fetch: (input, init) => new Promise(resolve => { requests.push({ url: new URL(input), init: init!, resolve }) }),
    onError: message => assert.fail(message),
  })
  t.after(() => activity.dispose())
  activity.setAuthorization(authorization)
  requests[0]!.resolve(Response.json({ projects: [{ id: 'default' }] }))
  await settle()
  activity.setAuthorization(null)
  assert.equal(requests[1]!.init.signal!.aborted, true)
  requests[1]!.resolve(Response.json({ stages: { task: 'llm' } }))
  await settle()
  assert.deepEqual(window.progress, [[-1]])
  activity.setAuthorization({ ...authorization, apiBase: 'http://127.0.0.1:3133', launchToken: 'new-synthetic-token' })
  assert.equal(requests[2]!.url.origin, 'http://127.0.0.1:3133')
  activity.dispose()
  requests[2]!.resolve(Response.json({ projects: [] }))
  await settle()
  assert.equal(requests[2]!.init.signal!.aborted, true)
  assert.deepEqual(window.progress, [[-1]])
})

test('native polling does not depend on renderer visibility and closes with its window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t)
  f.activity.setAuthorization(authorization)
  await settle()
  f.responses.set('default', () => Response.json({ stages: { task: 'tool' } }))
  t.mock.timers.tick(1500)
  await settle()
  assert.deepEqual(f.window.progress.at(-1), [2, { mode: 'indeterminate' }])
  const calls = f.calls.length
  f.window.destroyed = true
  f.window.emit('closed')
  assert.equal(f.window.listenerCount('closed'), 0)
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(f.calls.length, calls)
  assert.equal(f.window.progress.length, 2, 'Never call a destroyed BrowserWindow')
})

test('timeouts abort a hung poll, report the failure and retry without overlapping requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const window = new FakeWindow()
  const errors: string[] = []
  const signals: AbortSignal[] = []
  const activity = new TaskbarActivity(window, {
    onError: message => { errors.push(message) },
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!
      signals.push(signal)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  t.after(() => activity.dispose())
  activity.setAuthorization(authorization)
  await activity.refresh()
  assert.equal(signals.length, 1)
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(signals[0]!.aborted, true)
  assert.match(errors[0]!, /timed out/)
  t.mock.timers.tick(1500)
  assert.equal(signals.length, 2)
  activity.dispose()
  await settle()
})

test('only loopback authorization and path-safe project identifiers are accepted', async t => {
  const f = fixture(t)
  for (const apiBase of ['https://example.com', 'http://localhost:3123', 'http://127.0.0.1:3123/projects/default', 'http://user:pass@127.0.0.1:3123']) {
    assert.throws(() => f.activity.setAuthorization({ ...authorization, apiBase }), /authenticated loopback/)
  }
  assert.equal(f.calls.length, 0)
  f.setProjects(['../elsewhere'])
  f.activity.setAuthorization(authorization)
  await settle()
  assert.equal(f.calls.length, 1)
  assert.match(f.errors[0]!, /Invalid project activity identity/)
})

test('project reads have a four-request concurrency ceiling and expose working state without waiting for slower projects', async t => {
  const window = new FakeWindow()
  const pending: ((response: Response) => void)[] = []
  let concurrent = 0
  let maximum = 0
  const activity = new TaskbarActivity(window, {
    onError: message => assert.fail(message),
    fetch: async input => {
      if (new URL(input).pathname === '/api/projects') {
        return Response.json({ projects: Array.from({ length: 10 }, (_, i) => ({ id: `project-${i}` })) })
      }
      maximum = Math.max(maximum, ++concurrent)
      try {
        return await new Promise<Response>(resolve => { pending.push(resolve) })
      } finally { concurrent-- }
    },
  })
  t.after(() => activity.dispose())
  activity.setAuthorization(authorization)
  await settle()
  assert.equal(pending.length, 4)
  for (let index = 0; index < 10; index++) {
    pending[index]!(Response.json({ stages: { task: index === 0 ? 'llm' : 'idle' } }))
    await settle()
    assert.deepEqual(window.progress.at(-1), [2, { mode: 'indeterminate' }])
  }
  assert.equal(maximum, 4)
  assert.equal(concurrent, 0)
})
