import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { publishPreviewManifest } from './preview-manifest.ts'
import type { OtioPreviewManifest } from '../shared/otio-effects.ts'
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
async function fixture(fn: (f: { dir: string; file: string; manifest: string; receipt: OtioPreviewManifest }) => Promise<void>) {
  const dir = await mkdtemp(path.resolve('.preview-test-'))
  const file = path.join(dir, 'timeline.otio'), manifest = `${file}.preview.json`
  await writeFile(file, 'source')
  const receipt: OtioPreviewManifest = { version: 1, profileVersion: 1, sourceSha256: hash('source'), media: '../renders/preview.mp4', start: 0, end: 1, rate: 24, frames: 24 }
  try { await fn({ dir, file, manifest, receipt }) } finally { await rm(dir, { recursive: true, force: true }) }
}
test('new publication and three revision-protected rounds; conflict and no residuals', async () => fixture(async ({ dir, file, manifest, receipt }) => {
  let published = await publishPreviewManifest(file, manifest, receipt)
  assert.equal(published.manifest, manifest)
  for (let round = 0; round < 3; round++) {
    assert.equal(hash(await readFile(manifest)), published.manifestRevision)
    const old = published.manifestRevision
    published = await publishPreviewManifest(file, manifest, { ...receipt, media: `../renders/preview-${round}.mp4` }, { expectedRevision: old })
    const before = await readFile(manifest)
    await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: old }), /revision conflict/)
    assert.deepEqual(await readFile(manifest), before)
  }
  await assert.rejects(publishPreviewManifest(file, manifest, receipt), /conflict/)
  assert.deepEqual((await readdir(dir)).sort(), ['timeline.otio', 'timeline.otio.preview.json'])
}))
test('matching hashes cannot authorize overwriting arbitrary JSON or arbitrary paths', async () => fixture(async ({ file, manifest, receipt }) => {
  for (const text of ['{}', JSON.stringify({ ...receipt, version: 2 }), JSON.stringify({ ...receipt, media: 'https://example/a.mp4' }), JSON.stringify({ ...receipt, extra: true }), ' '.repeat(65537)]) {
    await writeFile(manifest, text)
    await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: hash(text) }))
    assert.equal(await readFile(manifest, 'utf8'), text)
  }
  await assert.rejects(publishPreviewManifest(file, `${manifest}.other.json`, receipt, { expectedRevision: hash('{}') }), /fixed/)
}))
test('two cooperative publishers have exactly one winner for creation and updates', async () => fixture(async ({ dir, file, manifest, receipt }) => {
  const run = async (revision?: string) => {
    const results = await Promise.allSettled([0, 1].map(n => publishPreviewManifest(file, manifest, { ...receipt, media: `v${n}.mp4` }, { expectedRevision: revision })))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    assert.match(String(rejected.reason), /conflict/)
  }
  await run()
  await run(hash(await readFile(manifest)))
  assert.equal((await readdir(dir)).length, 2)
}))
test('abort, changed source, and retained lock preserve prior bytes', async () => fixture(async ({ dir, file, manifest, receipt }) => {
  const { manifestRevision } = await publishPreviewManifest(file, manifest, receipt)
  const before = await readFile(manifest)
  await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: manifestRevision, signal: AbortSignal.abort() }))
  await writeFile(file, 'changed')
  await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: manifestRevision }), /source revision/)
  await writeFile(`${manifest}.lock`, 'other owner')
  await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: manifestRevision }), /lock conflict/)
  assert.equal(await readFile(`${manifest}.lock`, 'utf8'), 'other owner')
  assert.deepEqual(await readFile(manifest), before)
  assert.equal((await readdir(dir)).filter(n => n.endsWith('.tmp')).length, 0)
}))
test('path/receipt preflight rejects network, device, URI and unsafe media before access', async () => fixture(async ({ file, manifest, receipt }) => {
  for (const p of ['//host/share/file', '\\\\host\\share\\file', '\\\\?\\C:\\file', '/device/file', 'https://host/file', 'file:///tmp/file']) {
    await assert.rejects(publishPreviewManifest(p, manifest, receipt))
    await assert.rejects(publishPreviewManifest(file, p, receipt))
  }
  for (const media of ['/tmp/a.mp4', 'C:/a.mp4', 'file:a.mp4', '//host/a.mp4', '../a%20.mp4', '../a\\b.mp4']) await assert.rejects(publishPreviewManifest(file, manifest, { ...receipt, media }))
}))
test('symlink sources, targets, dangling targets and directory aliases rejected', async t => fixture(async ({ dir, file, manifest, receipt }) => {
  const alias = path.join(dir, 'alias')
  try { await symlink(file, alias) } catch (e) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) { t.skip('Windows symlink permission unavailable'); return }
    throw e
  }
  await assert.rejects(publishPreviewManifest(alias, manifest, receipt), /regular|symlink/i)
  await symlink(path.join(dir, 'missing'), manifest)
  await assert.rejects(publishPreviewManifest(file, manifest, receipt))
  await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: hash('') }))
  await rm(manifest)
  await writeFile(manifest, JSON.stringify(receipt))
  const targetAlias = path.join(dir, 'target.json')
  await symlink(manifest, targetAlias)
  await assert.rejects(publishPreviewManifest(file, targetAlias, receipt))
  const nested = path.join(dir, 'nested'); await mkdir(nested)
  const directoryAlias = path.join(dir, 'directory-alias'); await symlink(nested, directoryAlias, 'dir')
  await assert.rejects(publishPreviewManifest(file, path.join(directoryAlias, 'preview.json'), receipt), /Symlink/)
}))
test('concurrent reader sees only complete JSON during repeated atomic replacement', async () => fixture(async ({ dir, file, manifest, receipt }) => {
  let result = await publishPreviewManifest(file, manifest, receipt)
  let done = false, reads = 0
  const reader = (async () => { while (!done) { const parsed = JSON.parse(await readFile(manifest, 'utf8')); assert.equal(parsed.version, 1); assert.equal(parsed.frames, 24); reads++ } })()
  try {
    for (let n = 0; n < 20; n++) result = await publishPreviewManifest(file, manifest, { ...receipt, media: `preview-${n}.mp4` }, { expectedRevision: result.manifestRevision })
  } finally { done = true; await reader }
  assert.ok(reads > 0)
  assert.equal((await readdir(dir)).length, 2)
}))

test('late abort and source/manifest mutations after temp sync preserve the entry and clean owned files', async () => {
  for (const change of ['abort', 'source', 'manifest'] as const) await fixture(async ({ dir, file, manifest, receipt }) => {
    const { manifestRevision } = await publishPreviewManifest(file, manifest, receipt)
    const before = await readFile(manifest)
    const controller = new AbortController()
    const original = controller.signal.throwIfAborted.bind(controller.signal)
    let checkpoints = 0
    // Third cancellation checkpoint is after temporary write+sync, before final checks.
    Object.defineProperty(controller.signal, 'throwIfAborted', { value: () => {
      if (++checkpoints === 3) {
        if (change === 'abort') controller.abort()
        if (change === 'source') writeFileSync(file, 'changed during publishing')
        if (change === 'manifest') writeFileSync(manifest, 'external edit')
      }
      original()
    } })
    await assert.rejects(publishPreviewManifest(file, manifest, { ...receipt, media: 'new.mp4' }, { expectedRevision: manifestRevision, signal: controller.signal }))
    assert.deepEqual(await readFile(manifest), change === 'manifest' ? Buffer.from('external edit') : before)
    assert.equal((await readdir(dir)).length, 2)
  })
})

test('oversize receipts and nonregular sources/targets are rejected without residual files', async () => fixture(async ({ dir, file, manifest, receipt }) => {
  await assert.rejects(publishPreviewManifest(file, manifest, { ...receipt, media: `${'a'.repeat(65536)}.mp4` }), /64 KiB/)
  await mkdir(manifest)
  await assert.rejects(publishPreviewManifest(file, manifest, receipt, { expectedRevision: hash('') }), /regular/)
  await assert.rejects(publishPreviewManifest(dir, path.join(dir, 'other.json'), receipt), /regular/)
  assert.deepEqual((await readdir(dir)).sort(), ['timeline.otio', 'timeline.otio.preview.json'])
}))
