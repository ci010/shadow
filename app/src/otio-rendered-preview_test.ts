import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateOtioPreview, renderedPreviewPosition } from './otio-rendered-preview.ts'
import { otioReviewAnchor } from './otio-review.ts'
import { parseOtio } from './otio-model.ts'
const sha = 'a'.repeat(64)
const manifest = { version: 1, profileVersion: 1, sourceSha256: sha, media: 'renders/composite.mp4', start: 1, end: 3, rate: 24, frames: 48 }
const validate = (patch = {}) => validateOtioPreview({ ...manifest, ...patch }, sha, 'cuts/edit.otio', 4, 24)
test('composite manifest binds source bytes, versions, frame grid and covered interval', () => {
  const preview = { ...validate(), url: '/owner/raw' }
  assert.equal(preview.path, 'cuts/renders/composite.mp4')
  assert.equal(validate({ media: '../out/preview.MP4' }).path, 'out/preview.MP4')
  assert.equal(validate({ media: 'renders/../preview.mp4' }).path, 'cuts/preview.mp4')
  assert.equal(preview.manifestPath, 'cuts/edit.otio.preview.json')
  assert.equal(renderedPreviewPosition(preview, 1), 0)
  assert.equal(renderedPreviewPosition(preview, 2), 1)
  assert.equal(renderedPreviewPosition(preview, 3), null)
  assert.equal(renderedPreviewPosition(preview, 0), null)
  assert.equal(renderedPreviewPosition(undefined, 1), null)
  for (const patch of [{ version: 2 }, { profileVersion: 2 }, { sourceSha256: 'b'.repeat(64) }, { sourceSha256: sha.toUpperCase() }, { start: -1 }, { start: 1.01 }, { end: 5 }, { end: 1 }, { rate: 30 }, { frames: 47 }, { frames: NaN }, { frames: 48.5 }]) assert.throws(() => validate(patch))
  assert.throws(() => validateOtioPreview(manifest, undefined, 'edit.otio', 4, 24))
})
test('composite media never selects another owner, namespace, absolute path or URL', () => {
  for (const media of ['../../outside.mp4', '/outside.mp4', 'C:/outside.mp4', '//server/a.mp4', 'https://x/a.mp4', 'attachment:x.mp4', 'v:archive/a.mp4', 'remote:a.mp4', 'a\\b.mp4', '%2e%2e/a.mp4', 'a.mp4?token=secret', 'a.mp4#x', 'a.webm', 'a\u0000.mp4']) assert.throws(() => validate({ media }), media)
})
test('rendered monitor provenance does not attribute composite pixels to selected clip', () => {
  const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 24 })
  const model = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.1', name: 'Source', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: time(48), duration: time(96) }, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'source.mp4' } }] }] } }))
  model.warnings.push('transition-cut')
  const clip = model.nodes.find(n => n.kind === 'Clip')!
  const document = { path: 'cuts/edit.otio', owner: { folder: 'owner' }, sha256: sha }
  const preview = { ...validate(), url: '/raw' }
  const anchor = otioReviewAnchor(document, model, clip, 24, clip, 'timeline', { path: preview.path, kind: 'video' }, undefined, { required: true, preview, mediaSeconds: 0 })
  assert.equal(anchor.document, document)
  assert.equal(anchor.element.pointer, clip.id)
  assert.equal(anchor.element.sourceAtPlayhead?.value, 72)
  assert.equal(anchor.monitor.clip, null)
  assert.equal(anchor.monitor.previewLimits, undefined)
  assert.deepEqual(otioReviewAnchor(document, model, clip, 24, clip, 'timeline').monitor.previewLimits, ['transition-cut'])
  assert.equal(anchor.monitor.renderedPreview?.manifest.sourceSha256, sha)
  assert.equal(anchor.monitor.renderedPreview?.requestedMediaSeconds, 0)
})
test('viewer integration gates independent audio and false source/storyboard modes', async () => {
  const viewer = await readFile(new URL('./components/files/OtioViewer.vue', import.meta.url), 'utf8')
  assert.match(viewer, /if \(props.requiresCompositePreview \|\| !props.active/)
  assert.match(viewer, /!props.requiresCompositePreview && mode.value === 'timeline' && audioTracks.value.explicit/)
  assert.match(viewer, /!props.requiresCompositePreview && canSolo.value \? 'clip' : 'timeline'/)
  assert.match(viewer, /requiresCompositePreview && view.board/)
  const file = await readFile(new URL('./components/files/OtioFilePreview.vue', import.meta.url), 'utf8')
  assert.match(file, /composite && !unlinked.value && !previewError/)
  assert.doesNotMatch(file, /ffmpeg|\/api\/video|child_process/i)
})
