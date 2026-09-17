import assert from 'node:assert/strict'
import test from 'node:test'
import { fileKind, useSessionFiles } from './useSessionFiles.ts'

test('preview encoding is explicit and missing or invalid decoder metadata is not silently accepted', async t => {
  const path = '\u65e5\u672c\u8a9e % #.txt'
  const mock = t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    assert.equal(url.searchParams.get('encoding'), 'shift_jis')
    assert.equal(url.searchParams.get('path'), path)
    return Response.json({ binary: false, size: 6, content: '\u65e5\u672c\u8a9e', encoding: 'shift_jis' })
  })
  const files = useSessionFiles('http://localhost')
  assert.equal((await files.preview('session', path, 65536, undefined, 'shift_jis')).content, '\u65e5\u672c\u8a9e')
  mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 6, content: 'legacy' }))
  await assert.rejects(files.preview('session', path, 65536, undefined, 'shift_jis'), /Restart Main/)
  for (const metadata of [{ encoding: 'unknown' }, { encoding: 'auto' }, { encodingWarning: 12 }]) {
    mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 6, content: 'text', ...metadata }))
    await assert.rejects(files.preview('session', path), /Invalid file preview/)
  }
})

test('file requests retain the owning session, relative path and abort signal', async t => {
  const controller = new AbortController()
  let requested: URL | undefined
  let requestSignal: AbortSignal | null | undefined
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    requested = new URL(input)
    requestSignal = init.signal
    return Response.json({ path: 'src', entries: [{ name: 'main.ts', type: 'file', ext: '.ts', size: 12, mtime: null }] })
  })
  const result = await useSessionFiles('http://localhost:3123').listDir('web:child/a', 'src', controller.signal)
  assert.equal(requested?.pathname, '/api/sessions/web%3Achild%2Fa/files')
  assert.equal(requested?.searchParams.get('path'), 'src')
  assert.equal(result.entries[0].name, 'main.ts')
  controller.abort()
  assert.equal(requestSignal?.aborted, true)
})

test('invalid listing names and malformed text responses are rejected', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ path: '', entries: [{ name: '../outside', type: 'file', ext: '', size: 0, mtime: null }] }))
  const files = useSessionFiles('http://localhost')
  await assert.rejects(files.listDir('session'), /Invalid file listing/)
  mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 0 }))
  await assert.rejects(files.preview('session', 'file'), /Invalid file preview/)
  mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 0, content: '' }))
  assert.equal((await files.preview('session', 'file')).content, '')
})

test('file listings preserve authoritative local and remote workspace identities', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({
    path: '', entries: [], workdir: { kind: 'local', displayPath: 'C:\\workspace\\web_chat-free' },
  }))
  const files = useSessionFiles('http://localhost')
  assert.deepEqual((await files.listDir('web:chat-free')).workdir,
    { kind: 'local', displayPath: 'C:\\workspace\\web_chat-free' })
  mock.mock.mockImplementation(async () => Response.json({
    path: 'src', entries: [], workdir: { kind: 'remote', displayPath: '/opaque/remote/folder' },
  }))
  assert.deepEqual((await files.listDir('remote', 'src')).workdir,
    { kind: 'remote', displayPath: '/opaque/remote/folder' })
  mock.mock.mockImplementation(async () => Response.json({
    path: '', entries: [], workdir: { kind: 'local', displayPath: 'C:\\home', scope: 'home' },
  }))
  assert.deepEqual((await files.listDir('heartbeat:reflector-fixture')).workdir,
    { kind: 'local', displayPath: 'C:\\home', scope: 'home' })
  mock.mock.mockImplementation(async () => Response.json({
    binary: false, size: 4, content: 'Home', sourcePath: 'C:\\home\\note.txt',
  }))
  assert.equal((await files.preview('heartbeat:reflector-fixture', 'note.txt')).sourcePath, 'C:\\home\\note.txt')
  mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 4, content: 'Home', sourcePath: 42 }))
  await assert.rejects(files.preview('session', 'note.txt'), /Invalid file preview/)
  for (const workdir of [null, { kind: 'unknown', displayPath: 'folder' }, { kind: 'local', displayPath: 42 },
    { kind: 'local', displayPath: 'folder', scope: 'unknown' }, { kind: 'remote', displayPath: '/remote', scope: 'home' }]) {
    mock.mock.mockImplementation(async () => Response.json({ path: '', entries: [], workdir }))
    await assert.rejects(files.listDir('session'), /Invalid workspace information/)
  }
})

test('remote workdir failures never fall back to another file root', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'remote_workdir_requires_executor' }, { status: 501 }))
  await assert.rejects(useSessionFiles('http://localhost').listDir('remote'), /No local folder was used/)
  assert.equal(mock.mock.callCount(), 1)
})

test('unknown and extensionless files try text while specialized renderers remain unchanged', () => {
  for (const ext of ['', '.node-version', '.custom', '.txt', '.md', '.zip']) assert.equal(fileKind(ext), 'text')
  for (const [ext, kind] of [
    ['.PNG', 'image'], ['.svg', 'image'], ['.mp4', 'video'], ['.wav', 'audio'],
    ['.html', 'html'], ['.htm', 'html'], ['.pdf', 'pdf'],
  ]) assert.equal(fileKind(ext!), kind)
})

test('folder client scopes every operation to its registry ID without a session or renderer path', async t => {
  const folderId = 'cdbf51ac-8714-4a82-8412-e11a5dd61c20'
  const files = useSessionFiles('http://localhost:3123', folderId)
  const controller = new AbortController()
  const requests: URL[] = []
  const signals: AbortSignal[] = []
  const mock = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert(init.signal)
    signals.push(init.signal)
    requests.push(new URL(input))
    return Response.json({ path: '', entries: [] })
  })
  await files.listDir('', '', controller.signal)
  mock.mock.mockImplementation(async (input: string, init: RequestInit) => {
    assert(init.signal)
    signals.push(init.signal)
    requests.push(new URL(input))
    return Response.json({ binary: false, size: 8, content: '24.15.0\n', truncated: false })
  })
  assert.equal((await files.preview('', '.node-version', 65536, controller.signal)).content, '24.15.0\n')
  assert.equal(requests[0]?.pathname, `/api/folders/${folderId}/files`)
  assert.equal(requests[1]?.pathname, `/api/folders/${folderId}/preview`)
  assert.equal(requests[1]?.searchParams.get('maxBytes'), '65536')
  const raw = new URL(files.rawUrl('ignored-session', 'docs/a #.pdf'))
  assert.equal(raw.pathname, `/api/folders/${folderId}/raw`)
  assert.equal(raw.searchParams.get('path'), 'docs/a #.pdf')
  const html = files.staticUrl('', 'docs/a #.html')
  assert.equal(html, `http://localhost:3123/api/folders/${folderId}/static/docs/a%20%23.html`)
  assert.equal(new URL('style.css', html).pathname, `/api/folders/${folderId}/static/docs/style.css`)
  assert.equal(mock.mock.callCount(), 2)
  controller.abort()
  assert(signals.every(signal => signal.aborted))
})

test('file request deadlines stop loading without retrying locally', async t => {
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 30_000)
    return deadline.signal
  })
  const request = t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })))
  const listing = useSessionFiles('http://localhost').listDir('remote')
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  await assert.rejects(listing, /Check the device connection and retry/)
  assert.equal(request.mock.callCount(), 1)
})
test('unavailable folders and invalid folder wire data do not fall back to session requests', async t => {
  const files = useSessionFiles('http://localhost', 'registered-id')
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'folder_unavailable' }, { status: 409 }))
  await assert.rejects(files.listDir('existing-session'), /folder is unavailable/)
  assert.equal(mock.mock.callCount(), 1)
  mock.mock.mockImplementation(async () => Response.json({ binary: false, size: 12, content: 12 }))
  await assert.rejects(files.preview('', 'custom'), /Invalid file preview/)
  mock.mock.mockImplementation(async () => Response.json({ binary: true, size: 3 }))
  assert.equal((await files.preview('', 'custom')).binary, true)
})

test('folder fetch cancellation is passed through without retrying another source', async t => {
  const controller = new AbortController()
  controller.abort()
  const mock = t.mock.method(globalThis, 'fetch', async (_: string, init: RequestInit) => {
    init.signal?.throwIfAborted()
    throw new Error('expected cancellation')
  })
  await assert.rejects(useSessionFiles('http://localhost', 'folder').preview('', 'file', 4096, controller.signal),
    { name: 'AbortError' })
  assert.equal(mock.mock.callCount(), 1)
})
