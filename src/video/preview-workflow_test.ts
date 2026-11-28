import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { initialTimeline, revisionOf } from './index.ts'
import { runVideoCli } from './cli.ts'
import { pngFixture } from '../testing/image.ts'
import { validateOtioPreview } from '../../app/src/otio-rendered-preview.ts'

const ffmpeg = process.env.TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.TEST_FFPROBE ?? 'ffprobe'
test('real three-round preview publication stays revision-bound and a stale publisher retains its video only', async () => {
  const dir = await mkdtemp(path.resolve('.tmp-preview-workflow-'))
  try {
    const source = path.join(dir, 'edit.otio'), manifest = `${source}.preview.json`
    await writeFile(path.join(dir, 'picture.png'), pngFixture(64, 48))
    const raw: any = initialTimeline(1, 24)
    const gap = raw.tracks.children[0].children[0]
    raw.tracks.children[0].children = [{ OTIO_SCHEMA: 'Clip.1', name: 'Picture', source_range: gap.source_range, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'picture.png' }, effects: [{ OTIO_SCHEMA: 'Effect.1', effect_name: 'shadow.opacity', metadata: { shadow: { profile: 'opacity', value: 1 } } }] }]
    let previousManifest: string | undefined, previousRevision: string | undefined
    let lastArgs: string[] = []
    for (let round = 0; round < 3; round++) {
      raw.name = `Revision ${round}`
      raw.tracks.children[0].children[0].effects[0].metadata.shadow.value = 1 - round * 0.25
      const text = JSON.stringify(raw), revision = revisionOf(text)
      await writeFile(source, text)
      const output = path.join(dir, `preview-${round}.mp4`)
      lastArgs = ['preview', source, '--revision', revision, '--start', '0', '--end', '1', '--width', '64', '--height', '48', '--ffmpeg', ffmpeg, '--ffprobe', ffprobe, '--output', output, '--manifest', manifest]
      if (previousManifest) lastArgs.push('--manifest-revision', previousManifest)
      const receipt = await runVideoCli(lastArgs)
      assert.ok('manifestRevision' in receipt && typeof receipt.manifestRevision === 'string')
      assert.ok('frames' in receipt && 'revision' in receipt)
      assert.equal(receipt.revision, revision)
      assert.equal(receipt.frames, 24)
      const published = JSON.parse(await readFile(manifest, 'utf8'))
      assert.equal(published.media, `preview-${round}.mp4`)
      const accepted = validateOtioPreview(published, revision, 'edit.otio', 1, 24)
      assert.equal(accepted.path, `preview-${round}.mp4`)
      if (previousRevision) assert.throws(() => validateOtioPreview(published, previousRevision, 'edit.otio', 1, 24), /stale/)
      previousRevision = revision
      previousManifest = receipt.manifestRevision
    }
    const before = await readFile(manifest)
    const stale = [...lastArgs]
    stale[stale.indexOf('--output') + 1] = path.join(dir, 'retained-after-conflict.mp4')
    stale[stale.indexOf('--manifest-revision') + 1] = '0'.repeat(64)
    await assert.rejects(runVideoCli(stale), /Preview video retained.*manifest failed:.*revision conflict/)
    assert.deepEqual(await readFile(manifest), before)
    assert.ok((await readFile(path.join(dir, 'retained-after-conflict.mp4'))).length > 0)
    assert.equal((await readdir(dir)).filter(n => n.endsWith('.lock') || n.endsWith('.tmp')).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
