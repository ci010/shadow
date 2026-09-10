import assert from 'node:assert/strict'
import test from 'node:test'
import { createCloneController, createProjectsClient, parseCloneOperation, parseProject, type CloneOperation, type CloneView } from './projects-client.ts'

const project = { id: 'project-a', name: 'demo', path: 'C:\\fixtures\\demo', createdAt: '2026-09-10T00:00:00Z' }
const running: CloneOperation = { id: 'operation-a', state: 'running', destination: project.path }
const input = { url: 'https://example.invalid/owner/demo.git', parentPath: 'C:\\fixtures', directoryName: 'demo' }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

test('projects and clones validate wire contracts and drop raw URLs, tokens and Git output', () => {
  assert.deepEqual(parseProject({ ...project, token: 'synthetic' }), project)
  assert.throws(() => parseProject({ ...project, path: null }), /invalid project response/)
  for (const operation of [{ ...running, id: 'wrong' }, { ...running, state: 'unknown' }, { ...running, destination: null }, { ...running, state: 'succeeded' }]) {
    assert.throws(() => parseCloneOperation(operation, running.id), /invalid project response/)
  }
  const parsed = parseCloneOperation({ ...running, state: 'failed', error: 'https://user:synthetic-secret@example.invalid/repo.git\nfatal: raw log', stdout: 'synthetic-token' }, running.id)
  assert.match(parsed.error!, /Check repository access/)
  assert.doesNotMatch(JSON.stringify(parsed), /synthetic|https:|raw log/)
})

test('client uses real project sessions and a caller-created clone ID, with no arbitrary workdir or session ID', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const client = createProjectsClient('http://main.invalid', async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path).endsWith('/register')) return response({ project })
    if (String(path).endsWith('/sessions')) return response({ sessionId: 'web:chat-created', chatId: 'chat-created' })
    if (String(path).endsWith('/clone')) return response({ operation: running }, 202)
    if (String(path).includes('/clone/')) return response({ operation: init?.method === 'DELETE' ? { ...running, state: 'cancelled' } : running })
    return response({ projects: [project] })
  })
  assert.deepEqual(await client.list(), [project])
  await client.register(project.path)
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { path: project.path })
  assert.deepEqual(await client.createSession('project/a'), { sessionId: 'web:chat-created', chatId: 'chat-created' })
  assert.equal(calls.at(-1)?.path, 'http://main.invalid/api/projects/project%2Fa/sessions')
  assert.equal(calls.at(-1)?.init?.body, undefined)
  await client.start(input, running.id)
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { operationId: running.id, ...input })
  await client.poll(running.id)
  await client.cancel(running.id)
  assert.equal(calls.at(-1)?.init?.method, 'DELETE')
  assert.equal(calls.at(-1)?.init?.keepalive, true)
})

test('HTTP and malformed poll errors are visible and never echo server credentials', async () => {
  for (const status of [400, 401, 403, 404, 409, 500]) {
    const client = createProjectsClient('', async () => response({ error: 'synthetic-secret' }, status))
    await assert.rejects(client.poll(running.id), error => error instanceof Error && !error.message.includes('synthetic-secret'))
  }
  const client = createProjectsClient('', async () => response({ operation: { ...running, id: 'wrong' } }))
  await assert.rejects(client.poll(running.id), /invalid project response/)
  const invalidSession = createProjectsClient('', async () => response({ sessionId: 'other', chatId: 'chat-created' }))
  await assert.rejects(invalidSession.createSession(project.id), /invalid project response/)
})

test('structured project messages preserve actionable folder and clone recovery guidance', async () => {
  const message = 'The project folder changed. Open the folder again.'
  const client = createProjectsClient('', async () => response({ error: 'folder_unavailable', message }, 409))
  await assert.rejects(client.createSession(project.id), { message })
  const recovery = 'Clone completed, but the project could not be saved. The folder was kept. Use Open folder to recover it.'
  assert.equal(parseCloneOperation({ ...running, state: 'failed', error: recovery }, running.id).error, recovery)
})

test('unsafe structured error messages fall back without displaying token URLs or Git logs', async () => {
  for (const message of [
    'fatal: authentication failed',
    'Failed for https://user:synthetic-secret@example.invalid/repo.git',
    'git@example.invalid:repo.git\nprivate log',
    'authorization=synthetic-secret',
    'github_pat_synthetic-secret',
  ]) {
    const client = createProjectsClient('', async () => response({ error: 'project_operation_failed', message }, 500))
    await assert.rejects(client.register(project.path), error => error instanceof Error && error.message !== message && !error.message.includes('synthetic-secret'))
  }
})

function harness(poll: () => Promise<CloneOperation> = async () => ({ ...running, state: 'succeeded', project })) {
  let timer: (() => void) | undefined
  let starts = 0
  let polls = 0
  const cancelled: string[] = []
  const views: CloneView[] = []
  const controller = createCloneController({
    async start() { starts++; return running },
    async poll() { polls++; return poll() },
    async cancel(id) { cancelled.push(id); return { ...running, state: 'cancelled' } },
  }, view => views.push(view), callback => {
    assert.equal(timer, undefined, 'only one status timer')
    timer = callback
    return () => { timer = undefined }
  }, () => running.id)
  return {
    controller, views, cancelled,
    get starts() { return starts }, get polls() { return polls }, get scheduled() { return !!timer },
    async tick() { const callback = timer; timer = undefined; callback?.(); await flush() },
  }
}

test('one clone start and sequential polls reach success with no remaining timer', async () => {
  const h = harness()
  await h.controller.start(input)
  await h.controller.start(input)
  assert.equal(h.starts, 1)
  await h.tick()
  assert.equal(h.views.at(-1)?.state, 'succeeded')
  assert.equal(h.polls, 1)
  assert.equal(h.scheduled, false)
  assert.deepEqual(h.cancelled, [])
  h.controller.reset()
  assert.equal(h.views.at(-1)?.state, 'idle')
})

test('poll failure stays actionable, stops timers and blocks duplicate clones until cancellation', async () => {
  const h = harness(async () => { throw new Error('synthetic transport error') })
  await h.controller.start(input)
  await h.tick()
  assert.equal(h.views.at(-1)?.state, 'unknown')
  assert.match(h.views.at(-1)?.error ?? '', /Retry status or cancel/)
  assert.equal(h.scheduled, false)
  await h.controller.start(input)
  assert.equal(h.starts, 1)
  await h.controller.refresh()
  assert.equal(h.polls, 2)
  await h.controller.cancel()
  assert.deepEqual(h.cancelled, [running.id])
  assert.equal(h.views.at(-1)?.state, 'cancelled')
})

test('cancel before POST acknowledgement aborts transport and sends DELETE with the original operation ID', async () => {
  let acknowledge!: (operation: CloneOperation) => void
  let signal: AbortSignal | undefined
  const cancelled: string[] = []
  const views: CloneView[] = []
  const controller = createCloneController({
    start(_input, id, currentSignal) {
      assert.equal(id, running.id)
      signal = currentSignal
      return new Promise(resolve => { acknowledge = resolve })
    },
    async poll() { assert.fail('a late POST must not schedule a poll') },
    async cancel(id) { cancelled.push(id); return { ...running, state: 'cancelled', destination: '' } },
  }, view => views.push(view), () => { assert.fail('a cancelled clone must not poll') }, () => running.id)
  const starting = controller.start(input)
  await controller.cancel()
  assert.equal(signal?.aborted, true)
  assert.deepEqual(cancelled, [running.id])
  acknowledge(running)
  await starting
  assert.equal(views.at(-1)?.state, 'cancelled')
})

test('pending poll is never overlapped; disposal-style cancellation aborts and ignores late results', async () => {
  let resolvePoll!: (operation: CloneOperation) => void
  const h = harness(() => new Promise(resolve => { resolvePoll = resolve }))
  await h.controller.start(input)
  await h.tick()
  await h.controller.refresh()
  assert.equal(h.polls, 1)
  await h.controller.cancel()
  resolvePoll({ ...running, state: 'succeeded', project })
  await flush()
  assert.equal(h.views.at(-1)?.state, 'cancelled')
  assert.equal(h.scheduled, false)
})

test('failed cancellation retains operation identity and permits retry without starting another clone', async () => {
  let cancelCalls = 0
  let starts = 0
  const views: CloneView[] = []
  const controller = createCloneController({
    async start() { starts++; return running },
    async poll() { return running },
    async cancel(id) {
      assert.equal(id, running.id)
      if (++cancelCalls === 1) throw new Error('offline')
      return { ...running, state: 'cancelled' }
    },
  }, view => views.push(view), () => () => {}, () => running.id)
  await controller.start(input)
  await controller.cancel()
  assert.equal(views.at(-1)?.state, 'unknown')
  await controller.start(input)
  assert.equal(starts, 1)
  await controller.cancel()
  assert.equal(cancelCalls, 2)
  assert.equal(views.at(-1)?.state, 'cancelled')
})

test('lost POST response cancels the operation before presenting a retry', async () => {
  const cancelled: string[] = []
  const views: CloneView[] = []
  const controller = createCloneController({
    async start() { throw new Error('Cannot reach Main. Check the connection and retry.') },
    async poll() { return running },
    async cancel(id) { cancelled.push(id); return { ...running, state: 'cancelled' } },
  }, view => views.push(view), () => () => {}, () => running.id)
  await controller.start(input)
  assert.deepEqual(cancelled, [running.id])
  assert.equal(views.at(-1)?.state, 'cancelled')
  assert.match(views.at(-1)?.error ?? '', /Cannot reach Main/)
})

test('completion racing cancellation remains success and exposes the registered project', async () => {
  const views: CloneView[] = []
  const controller = createCloneController({
    async start() { return running },
    async poll() { return running },
    async cancel() { return { ...running, state: 'succeeded', project } },
  }, view => views.push(view), () => () => {}, () => running.id)
  await controller.start(input)
  await controller.cancel()
  assert.equal(views.at(-1)?.state, 'succeeded')
  assert.deepEqual(views.at(-1)?.operation?.project, project)
})

test('process termination failure during cancellation preserves failed status and recovery guidance', async () => {
  const error = 'The clone process could not be stopped. Check running Git processes before retrying.'
  const views: CloneView[] = []
  const controller = createCloneController({
    async start() { return running },
    async poll() { return running },
    async cancel() { return { ...running, state: 'failed', error } },
  }, view => views.push(view), () => () => {}, () => running.id)
  await controller.start(input)
  await controller.cancel()
  assert.equal(views.at(-1)?.state, 'failed')
  assert.equal(views.at(-1)?.error, error)
  assert.equal(views.at(-1)?.operation?.destination, project.path)
  await controller.cancel()
  assert.equal(views.at(-1)?.state, 'failed', 'subsequent inactive cleanup must not erase the warning')
})
