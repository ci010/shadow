import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test, type TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import type { CloneOperation, FolderRecord } from './contracts.ts'
import { CloneTerminationError, type GitCloneRunner } from './git.ts'
import { FolderRegistry } from './registry.ts'
import { FolderService } from './routes.ts'
import { folderFixture } from './test-fixtures.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

async function setup(t: TestContext, gitRunner?: GitCloneRunner) {
  const fixture = await folderFixture(t)
  const registry = new FolderRegistry(fixture.workspace)
  await registry.init()
  const sessions: FolderRecord[] = []
  const service = new FolderService({
    registry, gitRunner,
    createSession: async (folder) => {
      sessions.push(folder)
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
    const response = await app.request(`/api/folders/clone/${id}`)
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

describe('folder file browsing', () => {
  test('text encoding changes preserve exact Unicode paths and original bytes for folder and session previews', async t => {
    const { app, folders, registry } = await setup(t)
    const folder = await registry.register(folders)
    sessionsApiPlugin({
      workspace: folders,
      assertHistoricalFolderAccess: async () => {},
      readSessionState: async () => ({ sessionId: 'encoded', workdir: { version: 2, nodeId: 'local', workdirId: 'folder' } }),
      workdirLookup: () => ({ node: 'online', workdir: { online: true, path: folders } }),
    } as unknown as SessionManager)(app)
    const filename = '\u65e5\u672c\u8a9e % #.txt'
    const bytes = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 10])
    await writeFile(join(folders, filename), bytes)
    await writeFile(join(folders, 'boundary.txt'), 'x'.repeat(255) + '\u65e5')
    for (const base of [`/api/folders/${folder.id}`, '/api/sessions/encoded']) {
      const path = encodeURIComponent(filename)
      const utf8 = await (await app.request(`${base}/preview?path=${path}`)).json()
      assert.match(utf8.encodingWarning, /not valid utf-8/)
      const decoded = await (await app.request(`${base}/preview?path=${path}&encoding=shift_jis`)).json()
      assert.equal(decoded.path, filename)
      assert.equal(decoded.content, '\u65e5\u672c\u8a9e\n')
      assert.equal(decoded.encoding, 'shift_jis')
      assert.equal(decoded.encodingWarning, undefined)
      assert.deepEqual(Buffer.from(await (await app.request(`${base}/raw?path=${path}`)).arrayBuffer()), bytes)
      assert.equal((await app.request(`${base}/preview?path=${path}&encoding=unknown`)).status, 400)
      const truncated = await (await app.request(`${base}/preview?path=boundary.txt&maxBytes=256`)).json()
      assert.equal(truncated.truncated, true)
      assert.equal(truncated.content, 'x'.repeat(255))
      assert.equal(truncated.encodingWarning, undefined)
    }
    assert.deepEqual(await readFile(join(folders, filename)), bytes)
  })

  test('registered folder files are available before Send without creating a session', async t => {
    const { app, folders, registry, sessions, workspace } = await setup(t)
    await mkdir(join(folders, 'docs'))
    await writeFile(join(folders, '.node-version'), '24.15.0\n')
    await writeFile(join(folders, 'docs', 'notes.custom'), 'folder notes')
    const folder = await registry.register(folders)
    const savedRegistry = await readFile(registry.filePath, 'utf8')
    const base = `/api/folders/${folder.id}`
    const listing = await app.request(`${base}/files?cwd=untrusted&sessionId=injected`)
    assert.equal(listing.status, 200)
    const data = await listing.json()
    assert.equal(data.folderId, folder.id)
    assert.equal(data.path, '')
    assert.deepEqual(data.workdir, { kind: 'local', displayPath: folder.path })
    assert.deepEqual(data.entries.map((entry: { name: string }) => entry.name), ['docs', '.node-version'])
    assert.equal(data.entries[0].type, 'dir')
    assert.deepEqual((await (await app.request(`${base}/files?path=docs`)).json()).entries
      .map((entry: { name: string }) => entry.name), ['notes.custom'])
    const search = await app.request(`${base}/files/search?query=NOTES`)
    assert.equal(search.status, 200)
    assert.deepEqual(await search.json(), { paths: ['docs/notes.custom'], truncated: false })
    assert.equal((await app.request(`${base}/files/search?query=`)).status, 400)
    for (const path of ['.node-version', 'docs/notes.custom']) {
      const preview = await app.request(`${base}/preview?path=${encodeURIComponent(path)}`)
      assert.equal(preview.status, 200)
      assert.equal((await preview.json()).content, path === '.node-version' ? '24.15.0\n' : 'folder notes')
    }
    assert.deepEqual(sessions, [])
    assert.equal(await readFile(registry.filePath, 'utf8'), savedRegistry)
    assert.deepEqual(await readdir(workspace), ['state'])
    assert.deepEqual(await readdir(join(workspace, 'state')), ['folders.v2.json'])
  })

  test('folder and local-session file routes share text, binary, media and static serving', async t => {
    const { app, folders, registry, sessions } = await setup(t)
    const folder = await registry.register(folders)
    sessionsApiPlugin({
      workspace: folders,
      assertHistoricalFolderAccess: async () => {},
      readSessionState: async () => ({ sessionId: 'existing', workdir: { version: 2, nodeId: 'local', workdirId: 'folder' } }),
      workdirLookup: () => ({ node: 'online', workdir: { online: true, path: folders } }),
    } as unknown as SessionManager)(app)
    await mkdir(join(folders, 'page'))
    await writeFile(join(folders, 'page', 'index.html'), '<link rel="stylesheet" href="style.css"><h1>Fixture</h1>')
    await writeFile(join(folders, 'page', 'style.css'), 'h1 { color: red }')
    await writeFile(join(folders, 'large.custom'), 'x'.repeat(70_000))
    await writeFile(join(folders, 'binary.custom'), new Uint8Array([1, 0, 2]))
    const media = [['image.PNG', 'image/png'], ['image % #.png', 'image/png'], ['movie.mp4', 'video/mp4'], ['sound.wav', 'audio/wav'],
      ['document.pdf', 'application/pdf']] as const
    for (const [name] of media) await writeFile(join(folders, name), new Uint8Array([10, 20, 30]))
    for (const base of [`/api/folders/${folder.id}`, '/api/sessions/existing']) {
      const preview = await app.request(`${base}/preview?path=large.custom&maxBytes=999999`)
      assert.equal(preview.status, 200)
      const text = await preview.json()
      assert.equal(text.content.length, 65536)
      assert.equal(text.size, 70000)
      assert.equal(text.truncated, true)
      const binary = await (await app.request(`${base}/preview?path=binary.custom`)).json()
      assert.equal(binary.binary, true)
      assert.equal(binary.content, undefined)
      for (const [name, mime] of media) {
        const raw = await app.request(`${base}/raw?path=${encodeURIComponent(name)}`)
        assert.equal(raw.status, 200)
        assert.equal(raw.headers.get('content-type'), mime)
        assert.equal(raw.headers.get('content-length'), '3')
        if (mime.startsWith('image/')) {
          assert.equal(decodeURIComponent(raw.headers.get('x-shadow-source-path')!), join(folders, name))
          assert.equal(raw.headers.get('access-control-expose-headers'), 'X-Shadow-Source-Path')
        } else assert.equal(raw.headers.get('x-shadow-source-path'), null)
        assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), new Uint8Array([10, 20, 30]))
      }
      const html = await app.request(`${base}/static/page/index.html`)
      assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.match(await html.text(), /href="style.css"/)
      const css = await app.request(`${base}/static/page/style.css`)
      assert.equal(css.headers.get('access-control-allow-origin'), '*')
      assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
      assert.equal(await css.text(), 'h1 { color: red }')
      assert.equal((await app.request(`${base}/preview?path=page`)).status, 400)
      assert.equal((await app.request(`${base}/raw?path=page`)).status, 400)
      assert.equal((await app.request(`${base}/preview?path=missing`)).status, 404)
      assert.equal((await app.request(`${base}/static/%ZZ`)).status, 400)
    }
    assert.deepEqual(sessions, [])
  })

  test('folder file routes reject missing identities, traversal and symlink escapes without fallback', async t => {
    const { app, folders, root, registry, sessions } = await setup(t)
    const folder = await registry.register(folders)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.txt'), 'outside fixture')
    await symlink(outside, join(folders, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const base = `/api/folders/${folder.id}`
    for (const operation of ['files', 'raw', 'preview', 'static']) {
      const suffix = operation === 'static' ? '/private.txt' : '?path=private.txt'
      assert.equal((await app.request(`/api/folders/${randomUUID()}/${operation}${suffix}`)).status, 404)
      assert.equal((await app.request(`/api/folders/missing/${operation}${suffix}`)).status, 404)
      const paths = ['../outside/private.txt', 'escape/private.txt', '\0']
      for (const path of paths) {
        const url = operation === 'static' ? `${base}/static/${encodeURIComponent(path)}`
          : `${base}/${operation}?path=${encodeURIComponent(path)}`
        assert.equal((await app.request(url)).status, 400, url)
      }
    }
    await rm(folders, { recursive: true })
    for (const suffix of ['files', 'raw?path=private.txt', 'preview?path=private.txt', 'static/private.txt']) {
      const response = await app.request(`${base}/${suffix}`)
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error, 'folder_unavailable')
    }
    assert.deepEqual(sessions, [])
  })

})

test('folder routes list/register and create a session from only the registered available folder', async (t) => {
  const { app, folders, sessions } = await setup(t)
  assert.deepEqual(await (await app.request('/api/folders')).json(), { folders: [] })
  assert.equal((await post(app, '/api/folders/register', {})).status, 400)
  assert.equal((await post(app, '/api/folders/register', { path: folders, description: 42 })).status, 400)
  const response = await post(app, '/api/folders/register', { path: folders, description: 'API sources' })
  assert.equal(response.status, 200)
  const { folder } = await response.json()
  assert.equal(folder.description, 'API sources')
  assert.deepEqual(await (await app.request('/api/folders')).json(), { folders: [folder] })
  assert.equal((await post(app, '/api/folders/missing/sessions', {})).status, 404)
  const created = await post(app, `/api/folders/${folder.id}/sessions`, {
    cwd: 'untrusted', sessionId: 'injected',
  })
  assert.deepEqual(await created.json(), { sessionId: 'session-1', chatId: 'chat-1' })
  assert.deepEqual(sessions, [folder])
  await rm(folders, { recursive: true })
  assert.equal((await post(app, `/api/folders/${folder.id}/sessions`, {})).status, 409)
  assert.equal(sessions.length, 1)
})

test('real Git clone of a tiny local fixture succeeds and registers once across duplicate requests', async (t) => {
  const { app, root, folders, registry } = await setup(t)
  const source = join(root, 'source')
  await mkdir(source)
  const git = promisify(execFile)
  await git('git', ['init', '--quiet', source])
  await writeFile(join(source, 'hello.txt'), 'hello folder\n')
  await writeFile(join(source, '.gitattributes'), '*.txt text eol=lf\n')
  await git('git', ['-C', source, 'add', 'hello.txt', '.gitattributes'])
  await git('git', [
    '-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'fixture',
  ])
  const body = cloneBody(folders, { url: pathToFileURL(source).href })
  const first = await post(app, '/api/folders/clone', body)
  assert.equal(first.status, 202)
  assert.equal((await first.json()).operation.id, body.operationId)
  assert.equal((await post(app, '/api/folders/clone', body)).status, 202)
  const operation = await terminal(app, body.operationId)
  assert.equal(operation.state, 'succeeded', operation.error)
  assert.equal(await readFile(join(operation.destination, 'hello.txt'), 'utf8'), 'hello folder\n')
  assert.deepEqual(registry.list(), [operation.folder])
  const replay = await post(app, '/api/folders/clone', body)
  assert.deepEqual((await replay.json()).operation, operation)
  assert.equal(registry.list().length, 1)
  const cancellation = await app.request(`/api/folders/clone/${body.operationId}`, { method: 'DELETE' })
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
    assert.equal((await post(app, '/api/folders/clone', body)).status, 202)
    const operation = await terminal(app, body.operationId)
    assert.equal(operation.state, 'failed')
    assert.match(operation.error!, /already exists/)
  }
  await symlink(directory, join(folders, 'Alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const alias = cloneBody(folders, { directoryName: 'Alias' })
  await post(app, '/api/folders/clone', alias)
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
  await post(app, '/api/folders/clone', body)
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
  assert.equal((await post(app, '/api/folders/clone', body)).status, 202)
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
  await mkdir(registry.filePath, { recursive: true })
  const body = cloneBody(folders)
  await post(app, '/api/folders/clone', body)
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
  const request = new Request('http://localhost/api/folders/clone', {
    method: 'POST',
    body: new ReadableStream({ start(controller) { stream = controller } }),
    duplex: 'half',
  } as RequestInit)
  const pending = app.fetch(request)
  const cancelled = await app.request(`/api/folders/clone/${body.operationId}`, { method: 'DELETE' })
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
  await post(app, '/api/folders/clone', preaborted, abort.signal)
  assert.equal((await terminal(app, preaborted.operationId)).state, 'cancelled')
  assert.equal(calls, 0)
  const body = cloneBody(folders)
  await post(app, '/api/folders/clone', body)
  await start
  assert.equal((await post(app, '/api/folders/clone', cloneBody(folders))).status, 409)
  const cancelled = await app.request(`/api/folders/clone/${body.operationId}`, { method: 'DELETE' })
  assert.equal((await cancelled.json()).operation.state, 'cancelled')
  assert.equal(finished, 1)
  assert.equal(await readFile(join(folders, 'Checkout', 'partial'), 'utf8'), 'kept')
  start = new Promise<void>((resolve) => { started = resolve })
  const next = cloneBody(folders, { directoryName: 'Next' })
  await post(app, '/api/folders/clone', next)
  await start
  await Promise.all([service.dispose(), service.dispose()])
  assert.equal(finished, 2)
  assert.equal((await terminal(app, next.operationId)).state, 'cancelled')
  assert.deepEqual(registry.list(), [])
  assert.equal((await post(app, '/api/folders/clone', cloneBody(folders))).status, 503)
})

test('clone routes validate input, unknown IDs, and bounded cancellation history', async (t) => {
  const { app, folders } = await setup(t, async () => {})
  assert.equal((await app.request(`/api/folders/clone/${randomUUID()}`)).status, 404)
  assert.equal((await app.request('/api/folders/clone/invalid', { method: 'DELETE' })).status, 400)
  assert.equal((await post(app, '/api/folders/clone', null)).status, 400)
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
    assert.equal((await post(app, '/api/folders/clone', cloneBody(folders, values))).status, 400)
  }
  const first = randomUUID()
  for (let index = 0; index < 102; index++) {
    const id = index === 0 ? first : randomUUID()
    assert.equal((await app.request(`/api/folders/clone/${id}`, { method: 'DELETE' })).status, 200)
  }
  assert.equal((await app.request(`/api/folders/clone/${first}`)).status, 404)
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
  await post(app, '/api/folders/clone', body)
  await start
  const cancelled = await app.request(`/api/folders/clone/${body.operationId}`, { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  const { operation } = await cancelled.json() as { operation: CloneOperation }
  assert.equal(operation.state, 'failed')
  assert.match(operation.error!, /could not be stopped completely/)
  assert.match(operation.error!, /remaining Git processes/)
  assert.doesNotMatch(operation.error!, /Clone cancelled/)
  assert.deepEqual(registry.list(), [])
  assert.equal((await terminal(app, body.operationId)).state, 'failed')
})
