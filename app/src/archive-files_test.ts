import assert from 'node:assert/strict'
import test from 'node:test'
import { createArchiveEngine, parseArchiveListing } from './archive-engine.ts'
import { archiveDirectory, archivePath, isArchive, ARCHIVE_MAX_BYTES, ARCHIVE_MAX_ENTRIES,
  ARCHIVE_ENTRY_MAX_BYTES, type ArchiveRequest, type ArchiveResult } from './archive-format.ts'
import { archiveFixtures, rar5Fixture } from './archive-test-fixture.ts'
import { useSessionFiles } from './composables/useSessionFiles.ts'
import { listArchive, readArchiveEntry } from './archive-files.ts'
import { reactive } from 'vue'

test('archive formats belong to expandable trees, including compound and case-insensitive extensions', () => {
  for (const name of ['x.ZIP', 'x.7z', 'x.RAR', 'x.tar.gz', 'x.tgz', 'x.tar.bz2', 'x.xz', 'x.txz', 'x.tbz2']) assert(isArchive(name), name)
  for (const name of ['x.zip.txt', 'x.docx', 'x.gz.js']) assert(!isArchive(name), name)
})

test('archive paths and ambiguous listings are rejected instead of becoming workspace paths', () => {
  for (const name of ['../escape', '/absolute', 'C:\\escape', 'a/../b', 'a\nfake', 'a//b', '__proto__/../b']) assert.throws(() => archivePath(name))
  assert.equal(archivePath('./folder\\file.txt'), 'folder/file.txt')
  assert.throws(() => parseArchiveListing('Path = x\nSize = 1\nPath = y'))
  assert.throws(() => parseArchiveListing('Path = x\nSize = -1'))
  assert.throws(() => parseArchiveListing('Path = x\nSize = 1\n\nPath = x\nSize = 1'))
  assert.throws(() => parseArchiveListing(Array.from({ length: ARCHIVE_MAX_ENTRIES + 1 }, (_, n) => `Path = ${n}\nSize = 0`).join('\n\n')), /50,000/)
})

test('archive directories synthesize parents and retain explicit empty directories safely', () => {
  const entries = parseArchiveListing('Path = folder/deep.txt\nSize = 3\n\nPath = empty\nFolder = +\nSize = 0\n\nPath = __proto__/safe.txt\nSize = 0')
  const source = { path: 'root.zip', members: [] }
  const root = archiveDirectory(entries, source)
  assert.deepEqual(root.map(file => [file.name, file.type]), [['__proto__', 'dir'], ['empty', 'dir'], ['folder', 'dir']])
  const child = archiveDirectory(entries, source, 'folder')[0]!
  assert.deepEqual(child.archive, { path: 'root.zip', members: ['folder/deep.txt'] })
  assert.equal(child.size, 3)
  assert.deepEqual(archiveDirectory(entries, source, 'empty'), [])
})

test('real WASM lists and selectively extracts ZIP, 7z, RAR, TAR and compressed containers', async () => {
  const fixtures = await archiveFixtures()
  fixtures.set('rar5.rar', rar5Fixture())
  for (const [alias, original] of [['bundle.tgz', 'bundle.tar.gz'], ['bundle.tbz', 'bundle.tar.bz2'],
    ['bundle.tbz2', 'bundle.tar.bz2'], ['bundle.txz', 'bundle.tar.xz']]) fixtures.set(alias!, fixtures.get(original!)!)
  for (const [name, bytes] of fixtures) {
    if (['nested.zip', 'encrypted.7z', 'empty.zip'].includes(name)) continue
    const engine = await createArchiveEngine()
    engine.module.FS.writeFile(`/${name}`, bytes)
    const request = { name, members: [], mode: 'list' as const }
    const result = engine.run(`/${name}`, request)
    assert('entries' in result, name)
    const member = result.entries.find(entry => entry.path === 'notes.txt')
    assert(member, `${name}: ${JSON.stringify(result)}`)
    assert(!engine.module.FS.readdir('/').includes('notes.txt'), 'Listing never extracts files')
    const content = engine.run(`/${name}`, { ...request, mode: 'read', members: ['notes.txt'] })
    assert('bytes' in content, name)
    assert.equal(new TextDecoder().decode(content.bytes), 'Synthetic archive entry', name)
    if (!name.startsWith('notes.') && !name.endsWith('.rar')) {
      const nested = engine.run(`/${name}`, { ...request, mode: 'read', members: ['folder/deep.txt'] })
      assert('bytes' in nested)
      assert.equal(new TextDecoder().decode(nested.bytes), 'Nested archive entry', name)
    }
  }
})

test('WASM handles nested/empty archives and reports encrypted, missing and damaged entries', async t => {
  // Emscripten's Node adapter sets the process exit status for an expected CLI failure.
  const exitCode = process.exitCode
  t.after(() => { process.exitCode = exitCode })
  const fixtures = await archiveFixtures()
  for (const [name, members, expected] of [
    ['nested.zip', ['bundle.7z', 'notes.txt'], 'Synthetic archive entry'],
    ['bundle.zip', ['literal[1].txt'], 'Exact entry'],
  ] as const) {
    const engine = await createArchiveEngine()
    engine.module.FS.writeFile('/input', fixtures.get(name)!)
    const result = engine.run('/input', { name, members: [...members], mode: 'read' })
    assert('bytes' in result)
    assert.equal(new TextDecoder().decode(result.bytes), expected)
  }
  for (const name of ['empty.zip', 'encrypted.7z', 'damaged.zip']) {
    const engine = await createArchiveEngine()
    engine.module.FS.writeFile('/input', fixtures.get(name) ?? new Uint8Array([1, 2, 3]))
    if (name === 'empty.zip') assert.deepEqual(engine.run('/input', { name, members: [], mode: 'list' }), { entries: [] })
    else assert.throws(() => engine.run('/input', { name, members: name === 'encrypted.7z' ? ['notes.txt'] : [], mode: name === 'encrypted.7z' ? 'read' : 'list' }),
      name === 'encrypted.7z' ? /Password/ : /archive|ERROR|Cannot/i)
  }
})

test('bounded archive downloads reject oversized headers and streamed bodies', async t => {
  const files = useSessionFiles('http://fixture', 'folder')
  t.mock.method(globalThis, 'fetch', async () => new Response('small', { headers: { 'content-length': String(ARCHIVE_MAX_BYTES + 1) } }))
  await assert.rejects(files.readBlob('', 'large.zip', undefined, ARCHIVE_MAX_BYTES), /128 MB/)
  t.mock.method(globalThis, 'fetch', async () => new Response('123456789'))
  await assert.rejects(files.readBlob('', 'large.zip', undefined, 8), /128 MB/)
  assert.equal(await (await files.readBlob('', 'small.zip', undefined, 9)).text(), '123456789')
})

test('entry size limits are enforced before decompression and links never become readable files', async () => {
  const fixtures = await archiveFixtures()
  const bytes = Buffer.from(fixtures.get('bundle.zip')!)
  let position = bytes.indexOf(Buffer.from('504b0102', 'hex'))
  while (position >= 0 && bytes.readUInt32LE(position) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(position + 28)
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString()
    if (name === 'notes.txt') {
      bytes.writeUInt32LE(ARCHIVE_ENTRY_MAX_BYTES + 1, position + 24)
      bytes.writeUInt32LE(ARCHIVE_ENTRY_MAX_BYTES + 1, bytes.readUInt32LE(position + 42) + 22)
      break
    }
    position += 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32)
  }
  const engine = await createArchiveEngine()
  engine.module.FS.writeFile('/large.zip', bytes)
  assert.throws(() => engine.run('/large.zip', { name: 'large.zip', members: ['notes.txt'], mode: 'read' }), /32 MB/)
  assert.throws(() => engine.run('/large.zip', { name: 'large.zip', members: ['missing.txt'], mode: 'read' }), /no longer available/)
  assert.throws(() => engine.run('/large.zip', { name: 'large.zip', members: ['a', 'b', 'c', 'd', 'e'], mode: 'read' }), /four levels/)
  for (const field of ['Symbolic Link = target', 'Hard Link = target', 'Mode = prw-r--r--']) {
    assert.equal(parseArchiveListing(`Path = link\nSize = 0\n${field}`)[0]!.link, true)
  }
})

test('archive workers accept Vue state, preserve request scope, and terminate on success, abort and timeout', async t => {
  const workers: FakeWorker[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  class FakeWorker {
    onmessage?: (event: MessageEvent<ArchiveResult>) => void
    onerror?: () => void
    message?: ArchiveRequest
    terminated = false
    constructor() { workers.push(this) }
    postMessage(message: ArchiveRequest) { this.message = structuredClone(message) }
    terminate() { this.terminated = true }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else Reflect.deleteProperty(globalThis, 'Worker') })
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return new Response('archive') })
  const source = reactive({ path: 'bundle.zip', members: ['icon.svg'] })
  const reading = readArchiveEntry('http://fixture/projects/one', 'session', 'folder', source, new AbortController().signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(new URL(urls[0]!).pathname, '/projects/one/api/folders/folder/raw')
  assert.equal(new URL(urls[0]!).searchParams.get('path'), 'bundle.zip')
  assert.deepEqual(workers[0]!.message!.members, ['icon.svg'])
  workers[0]!.onmessage!(new MessageEvent('message', { data: { bytes: new TextEncoder().encode('<svg/>') } }))
  assert.equal((await reading).type, 'image/svg+xml')
  assert(workers[0]!.terminated)

  const controller = new AbortController()
  const cancelled = readArchiveEntry('http://fixture', 'session', undefined, source, controller.signal)
  const rejection = assert.rejects(cancelled, /cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancelled'))
  await rejection
  assert(workers[1]!.terminated)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalled = listArchive('http://fixture', 'session', undefined, { path: 'bundle.zip', members: [] }, new AbortController().signal)
  const timeout = assert.rejects(stalled, /timed out/)
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(30_001)
  await timeout
  assert(workers[2]!.terminated)
})

test('wire listings cannot inject renderer-only archive references', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ path: '', entries: [{
    name: 'file.txt', type: 'file', ext: '.txt', size: 1, mtime: null, archive: { path: 'elsewhere.zip', members: [] },
  }] }))
  await assert.rejects(useSessionFiles('http://fixture').listDir('session'), /Invalid file listing/)
})
