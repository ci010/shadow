import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import type { CloneOperation, ProjectRecord } from './contracts.ts'
import { CloneTerminationError, type GitCloneRunner } from './git.ts'
import { ProjectRegistry } from './registry.ts'
import { ProjectService } from './routes.ts'
import { projectFixture } from './test-fixtures.ts'

async function setup(t: TestContext, gitRunner?: GitCloneRunner) {
  const fixture = await projectFixture(t)
  const registry = new ProjectRegistry(fixture.workspace)
  await registry.init()
  const sessions: ProjectRecord[] = []
  const service = new ProjectService({
    registry, gitRunner,
    createSession: async (project) => {
      sessions.push(project)
      return { sessionId: 'session-1', chatId: 'chat-1' }
    },
  })
  t.after(() => service.dispose())
  const app = new Hono()
  service.plugin(app)
  return { ...fixture, registry, sessions, service, app }
}

function post(app: Hono, path: string, body: unknown, signal?: AbortSignal) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

async function terminal(app: Hono, id: string): Promise<CloneOperation> {
  for (let count = 0; count < 400; count++) {
    const response = await app.request(`/api/projects/clone/${id}`)
    assert.equal(response.status, 200)
    const { operation } = await response.json() as { operation: CloneOperation }
    if (operation.state !== 'running') return operation
    await setTimeout(20)
  }
  throw new Error('Clone did not reach a terminal state')
}

function cloneBody(parentPath: string, overrides: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(), parentPath, directoryName: 'Checkout',
    url: 'https://example.invalid/owner/repo.git', ...overrides,
  }
}

test('project routes list/register and create a session from only the registered available project', async (t) => {
  const { app, folders, sessions } = await setup(t)
  assert.deepEqual(await (await app.request('/api/projects')).json(), { projects: [] })
  assert.equal((await post(app, '/api/projects/register', {})).status, 400)
  const response = await post(app, '/api/projects/register', { path: folders })
  assert.equal(response.status, 200)
  const { project } = await response.json()
  assert.deepEqual(await (await app.request('/api/projects')).json(), { projects: [project] })
  assert.equal((await post(app, '/api/projects/missing/sessions', {})).status, 404)
  const created = await post(app, `/api/projects/${project.id}/sessions`, {
    cwd: 'untrusted', sessionId: 'injected',
  })
  assert.deepEqual(await created.json(), { sessionId: 'session-1', chatId: 'chat-1' })
  assert.deepEqual(sessions, [project])
  await rm(folders, { recursive: true })
  assert.equal((await post(app, `/api/projects/${project.id}/sessions`, {})).status, 409)
  assert.equal(sessions.length, 1)
})

test('real Git clone of a tiny local fixture succeeds and registers once across duplicate requests', async (t) => {
  const { app, root, folders, registry } = await setup(t)
  const source = join(root, 'source')
  await mkdir(source)
  const git = promisify(execFile)
  await git('git', ['init', '--quiet', source])
  await writeFile(join(source, 'hello.txt'), 'hello project\n')
  await writeFile(join(source, '.gitattributes'), '*.txt text eol=lf\n')
  await git('git', ['-C', source, 'add', 'hello.txt', '.gitattributes'])
  await git('git', [
    '-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'fixture',
  ])
  const body = cloneBody(folders, { url: pathToFileURL(source).href })
  const first = await post(app, '/api/projects/clone', body)
  assert.equal(first.status, 202)
  assert.equal((await first.json()).operation.id, body.operationId)
  assert.equal((await post(app, '/api/projects/clone', body)).status, 202)
  const operation = await terminal(app, body.operationId)
  assert.equal(operation.state, 'succeeded', operation.error)
  assert.equal(await readFile(join(operation.destination, 'hello.txt'), 'utf8'), 'hello project\n')
  assert.deepEqual(registry.list(), [operation.project])
  const replay = await post(app, '/api/projects/clone', body)
  assert.deepEqual((await replay.json()).operation, operation)
  assert.equal(registry.list().length, 1)
  const cancellation = await app.request(`/api/projects/clone/${body.operationId}`, { method: 'DELETE' })
  assert.deepEqual((await cancellation.json()).operation, operation)
})

test('clone never overwrites an existing destination, including an empty folder or symlink', async (t) => {
  let calls = 0
  const { app, folders, registry } = await setup(t, async () => { calls++ })
  const directory = join(folders, 'Existing')
  await mkdir(directory)
  for (const populated of [false, true]) {
    if (populated) await writeFile(join(directory, 'keep.txt'), 'keep')
    const body = cloneBody(folders, { directoryName: 'Existing' })
    assert.equal((await post(app, '/api/projects/clone', body)).status, 202)
    const operation = await terminal(app, body.operationId)
    assert.equal(operation.state, 'failed')
    assert.match(operation.error!, /already exists/)
  }
  await symlink(directory, join(folders, 'Alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const alias = cloneBody(folders, { directoryName: 'Alias' })
  await post(app, '/api/projects/clone', alias)
  assert.equal((await terminal(app, alias.operationId)).state, 'failed')
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(calls, 0)
  assert.deepEqual(registry.list(), [])
})

test('clone failures keep partial data without registration or credential-bearing error text', async (t) => {
  const { app, folders, registry } = await setup(t, async ({ destination }) => {
    await writeFile(join(destination, 'partial'), 'recoverable')
    throw new Error('stderr: private-token')
  })
  const body = cloneBody(folders)
  await post(app, '/api/projects/clone', body)
  const operation = await terminal(app, body.operationId)
  assert.equal(operation.state, 'failed')
  assert.match(operation.error!, /partial folder was kept/)
  assert.doesNotMatch(JSON.stringify(operation), /private-token/)
  assert.equal(await readFile(join(operation.destination, 'partial'), 'utf8'), 'recoverable')
  assert.deepEqual(registry.list(), [])
})

test('a real Git failure never registers a non-repository folder', async (t) => {
  const { app, root, folders, registry } = await setup(t)
  const source = join(root, 'not-a-repository')
  await mkdir(source)
  await writeFile(join(source, 'keep'), 'source data')
  const body = cloneBody(folders, { url: pathToFileURL(source).href })
  assert.equal((await post(app, '/api/projects/clone', body)).status, 202)
  const operation = await terminal(app, body.operationId)
  assert.equal(operation.state, 'failed')
  assert.match(operation.error!, /repository access/)
  assert.equal(await readFile(join(source, 'keep'), 'utf8'), 'source data')
  assert.deepEqual(registry.list(), [])
})

test('post-clone persistence failure leaves the checkout recoverable using Open folder', async (t) => {
  const { app, folders, registry } = await setup(t, async ({ destination }) => {
    await writeFile(join(destination, 'complete'), 'complete')
  })
  await mkdir(registry.filePath)
  const body = cloneBody(folders)
  await post(app, '/api/projects/clone', body)
  const operation = await terminal(app, body.operationId)
  assert.equal(operation.state, 'failed')
  assert.match(operation.error!, /Open folder/)
  assert.equal(await readFile(join(operation.destination, 'complete'), 'utf8'), 'complete')
  assert.deepEqual(registry.list(), [])
})

test('cancellation tombstone arriving before POST acknowledgement prevents an orphan clone', async (t) => {
  let calls = 0
  const { app, folders, registry } = await setup(t, async () => { calls++ })
  const body = cloneBody(folders)
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const request = new Request('http://localhost/api/projects/clone', {
    method: 'POST',
    body: new ReadableStream({ start(controller) { stream = controller } }),
    duplex: 'half',
  } as RequestInit)
  const pending = app.fetch(request)
  const cancelled = await app.request(`/api/projects/clone/${body.operationId}`, { method: 'DELETE' })
  assert.equal((await cancelled.json()).operation.state, 'cancelled')
  stream.enqueue(new TextEncoder().encode(JSON.stringify(body)))
  stream.close()
  const response = await pending
  assert.equal(response.status, 202)
  assert.equal((await response.json()).operation.state, 'cancelled')
  assert.equal(calls, 0)
  assert.deepEqual(registry.list(), [])
  assert.deepEqual(await readdir(folders), [])
})

test('aborted start request, in-flight cancellation, and disposal stop owned jobs without registering', async (t) => {
  let calls = 0
  let started!: () => void
  let start = new Promise<void>((resolve) => { started = resolve })
  let finished = 0
  const { app, folders, registry, service } = await setup(t, async ({ destination, signal }) => {
    calls++
    await writeFile(join(destination, 'partial'), 'kept')
    started()
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await setTimeout(10)
    finished++
    signal.throwIfAborted()
  })
  const abort = new AbortController()
  abort.abort()
  const preaborted = cloneBody(folders, { directoryName: 'Preaborted' })
  await post(app, '/api/projects/clone', preaborted, abort.signal)
  assert.equal((await terminal(app, preaborted.operationId)).state, 'cancelled')
  assert.equal(calls, 0)
  const body = cloneBody(folders)
  await post(app, '/api/projects/clone', body)
  await start
  assert.equal((await post(app, '/api/projects/clone', cloneBody(folders))).status, 409)
  const cancelled = await app.request(`/api/projects/clone/${body.operationId}`, { method: 'DELETE' })
  assert.equal((await cancelled.json()).operation.state, 'cancelled')
  assert.equal(finished, 1)
  assert.equal(await readFile(join(folders, 'Checkout', 'partial'), 'utf8'), 'kept')
  start = new Promise<void>((resolve) => { started = resolve })
  const next = cloneBody(folders, { directoryName: 'Next' })
  await post(app, '/api/projects/clone', next)
  await start
  await Promise.all([service.dispose(), service.dispose()])
  assert.equal(finished, 2)
  assert.equal((await terminal(app, next.operationId)).state, 'cancelled')
  assert.deepEqual(registry.list(), [])
  assert.equal((await post(app, '/api/projects/clone', cloneBody(folders))).status, 503)
})

test('clone routes validate input, unknown IDs, and bounded cancellation history', async (t) => {
  const { app, folders } = await setup(t, async () => {})
  assert.equal((await app.request(`/api/projects/clone/${randomUUID()}`)).status, 404)
  assert.equal((await app.request('/api/projects/clone/invalid', { method: 'DELETE' })).status, 400)
  assert.equal((await post(app, '/api/projects/clone', null)).status, 400)
  for (const values of [
    { operationId: 'invalid' },
    { url: 'https://user:password@example.invalid/repo' },
    { url: 'ext::bad command' },
    { url: 'https://example.invalid/repo?token=secret' },
    { directoryName: '../escape' },
    { parentPath: 'relative' },
    { parentPath: `${folders}\u007f` },
    { parentPath: `${folders}${'a'.repeat(10_001)}` },
    { url: 'ssh://git@-v/repo' },
  ]) {
    assert.equal((await post(app, '/api/projects/clone', cloneBody(folders, values))).status, 400)
  }
  const first = randomUUID()
  for (let index = 0; index < 102; index++) {
    const id = index === 0 ? first : randomUUID()
    assert.equal((await app.request(`/api/projects/clone/${id}`, { method: 'DELETE' })).status, 200)
  }
  assert.equal((await app.request(`/api/projects/clone/${first}`)).status, 404)
})

test('a failed process-tree stop reports failure and recovery guidance rather than completed cancellation', async (t) => {
  let started!: () => void
  const start = new Promise<void>((resolve) => { started = resolve })
  const { app, folders, registry } = await setup(t, async ({ signal }) => {
    started()
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new CloneTerminationError()
  })
  const body = cloneBody(folders)
  await post(app, '/api/projects/clone', body)
  await start
  const cancelled = await app.request(`/api/projects/clone/${body.operationId}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  const { operation } = await cancelled.json() as { operation: CloneOperation }
  assert.equal(operation.state, 'failed')
  assert.match(operation.error!, /could not be stopped completely/)
  assert.match(operation.error!, /remaining Git processes/)
  assert.doesNotMatch(operation.error!, /Clone cancelled/)
  assert.deepEqual(registry.list(), [])
  assert.equal((await terminal(app, body.operationId)).state, 'failed')
})
