import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { collectModelResources, isGltfFile, isPlaygroundFile, modelVersion } from './gltf-file-source.ts'
import { fetchPlaygroundSnapshot, watchPlayground, type SnapshotRead } from './three-playground-client.ts'

const pack = (value: object) => new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...value }))
const signal = () => new AbortController().signal

test('existing glTF reads explicit resources only, versions sidecar changes and never treats JavaScript or an attachment as a project', async () => {
  assert(isGltfFile('SCENE.GLB') && isGltfFile('scene.gltf'))
  assert(!isGltfFile('scene.glb.mjs') && !isPlaygroundFile('main.mjs') && isPlaygroundFile('playground.three.json'))
  const doc = pack({ buffers: [{ uri: './mesh%20data.bin' }], images: [{ uri: 'data:image/png;base64,QQ==' }] })
  const read = async (value: number) => await collectModelResources(doc, signal(), async path => {
    assert.equal(path, 'mesh data.bin'); return new Uint8Array([value])
  })
  const one = await read(1), two = await read(2)
  assert.deepEqual(one.get('data:image/png;base64,QQ=='), new Uint8Array([65]))
  assert.notEqual(await modelVersion(doc, one), await modelVersion(doc, two))
  await assert.rejects(collectModelResources(doc, signal()), /Sidecar files are unavailable/)
  for (const uri of ['https://example.test/a.bin', '../a.bin', 'file:///a.bin', '%2e%2e/a.bin', 'foo.js', 'data:text/html;base64,QQ==', 'a\\b.bin']) {
    let read = false
    await assert.rejects(collectModelResources(pack({ buffers: [{ uri }] }), signal(), async () => { read = true; return new Uint8Array() }))
    assert.equal(read, false)
  }
})

const change = (version: string): SnapshotRead => ({ tag: `"tag-${version}"`, snapshot: { version, files: { 'main.mjs': 'export function build(){}' }, assets: {}, shaders: [] } })

test('observe, cancel before debounce, coalesce, retain last success, manual supersession and cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reads: { tag: string; signal: AbortSignal; finish: (r: SnapshotRead | null) => void }[] = []
  const runs: { version: string; signal: AbortSignal; finish: (error?: Error) => void }[] = []
  let shown = '', failed = ''
  const watcher = watchPlayground({
    read: (tag, signal) => new Promise(resolve => reads.push({ tag, signal, finish: resolve })),
    async build({ version }, signal) {
      await new Promise<void>((resolve, reject) => runs.push({ version, signal, finish(e) { if (e) reject(e); else resolve() } }))
      signal.throwIfAborted(); shown = version
    },
    failed: (_, version) => { failed = version || 'read' },
  }, 20, 50)
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await setImmediate() }
  assert.equal(reads[0].tag, '')
  reads[0].finish(change('a')); await tick(0); runs[0].finish(); await tick(0)
  assert.equal(shown, 'a')
  await tick(20); assert.equal(reads[1].tag, '"tag-a"'); reads[1].finish(change('b')); await tick(0)
  await tick(20); reads[2].finish(change('c')); await tick(0)
  await tick(50); assert.deepEqual(runs.map(r => r.version), ['a', 'c'])
  reads[3].finish(change('d')); await tick(0); assert(runs[1].signal.aborted)
  runs[1].finish(); await tick(50); assert.equal(shown, 'a')
  runs[2].finish(new Error('stand.mjs:4')); await tick(0)
  assert.equal(shown, 'a'); assert.equal(failed, 'd')
  watcher.rebuild(); assert.equal(reads.at(-1)?.tag, ''); assert(reads[4].signal.aborted)
  reads.at(-1)!.finish(change('e')); await tick(0); runs.at(-1)!.finish(); await tick(0)
  assert.equal(shown, 'e'); watcher.dispose(); await tick(1000)
  assert(runs.at(-1)!.signal.aborted)
})

test('conditional snapshot wire rejects malformed versions and reports the server path and request id', async t => {
  const url = new URL('http://fixture.invalid/projects/test/api/folders/id/three-snapshot?path=playground.three.json')
  const request = t.mock.method(globalThis, 'fetch', async (_: URL, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('if-none-match'), '"previous"'); return new Response(null, { status: 304 })
  })
  assert.equal(await fetchPlaygroundSnapshot(url, '"previous"', signal()), null)
  request.mock.mockImplementation(async () => Response.json(change('invalid').snapshot))
  await assert.rejects(fetchPlaygroundSnapshot(url, '', signal()), /Invalid Playground snapshot/)
  request.mock.mockImplementation(async () => Response.json({ file: 'stand.mjs', message: 'File unavailable', id: 'attempt-1' }, { status: 404 }))
  await assert.rejects(fetchPlaygroundSnapshot(url, '', signal()), /stand\.mjs: File unavailable: attempt-1/)
})

test('client forwards declared JSON as bytes and rebuilds on a JSON-only snapshot change', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const url = new URL('http://fixture.invalid/api/folders/id/three-snapshot?path=playground.three.json')
  const scenes = ['{"name":"魔方"}', '{"name":"新版"}']
  let revision = 0
  t.mock.method(globalThis, 'fetch', async (_: URL, init: RequestInit) => {
    const etag = `"${revision}"`
    const headers = { ETag: etag }
    if (new Headers(init.headers).get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return Response.json({ ...change(String(revision).repeat(64)).snapshot,
      assets: { 'scene.json': Buffer.from(scenes[revision]).toString('base64') } }, { headers })
  })
  const built: Buffer[] = []
  const errors: unknown[] = []
  const watcher = watchPlayground({
    read: (tag, signal) => fetchPlaygroundSnapshot(url, tag, signal),
    async build(snapshot) { built.push(Buffer.from(snapshot.assets['scene.json'])) },
    failed(error) { errors.push(error) },
  }, 20, 10)
  t.after(() => watcher.dispose())
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await setImmediate() }
  await tick(0)
  await tick(20)
  assert.deepEqual(built, [Buffer.from(scenes[0])])
  revision++
  await tick(20)
  await tick(10)
  assert.deepEqual(errors, [])
  assert.deepEqual(built, scenes.map(scene => Buffer.from(scene)))
})
