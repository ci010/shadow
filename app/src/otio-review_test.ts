import assert from 'node:assert/strict'
import test from 'node:test'
import { messageAttachments } from './message-attachments.ts'
import { parseOtio } from './otio-model.ts'
import { firstOtioFrame, isOtioFile, mediaPosition, otioReviewAnchor, otioReviewText, resolveOtioMedia } from './otio-review.ts'

const path = 'edits/v1/cut.otio'
test('timeline detection does not claim ordinary JSON or bundled OTIOZ', () => {
  for (const name of ['CUT.OTIO', 'test.otio.json']) assert(isOtioFile(name))
  for (const name of ['notes.json', 'cut.otioz', 'cut.otio.png']) assert(!isOtioFile(name))
})
test('resolve images and movies only as paths inside the owning root, including exported absolute file URLs', () => {
  for (const [url, root, expected] of [
    ['../../media/first%20pass.webm', undefined, 'media/first pass.webm'],
    ['.\\shots\\wide.PNG', undefined, 'edits/v1/shots/wide.PNG'],
    ['file:///Users/reviewer/Footage/100%25.png', '/Users/reviewer/Footage', '100%.png'],
    ['C:\\work\\Art\\my shot.webm', 'C:\\work\\Art', 'my shot.webm'],
    ['file:///c:/WORK/ART/edit%23A/clip.mp4', 'C:\\work\\Art', 'edit#A/clip.mp4'],
  ] as const) assert.equal(resolveOtioMedia(path, url, root)?.path, expected)
  for (const url of ['../../../outside.png','https://outside.test/shot.png','data:image/png;base64,xxx','file://other/work/Art/a.png',
    'file:///C:/work/Artwork/shot.mp4', 'C:/work/Art/../sibling.png', 'C:relative.png','//other/shot.png','\\\\host\\share\\a.png',
    'image%2fother.png','..%5cimage.png','bad%00.png','evil.html','movie.mp4?apiKey=private','shot.svg']) {
    assert.equal(resolveOtioMedia(path, url, 'C:/work/Art'), null, url)
  }
  assert.equal(resolveOtioMedia(path, '/other/file.webm'), null)
  assert.equal(resolveOtioMedia(path, 'file:///work/Art/shot.png','/work/art'), null)
})
test('review anchors distinguish the chosen element, actual monitor source, frame domains and presented PTS', () => {
  const rt = (value: number, rate = 24) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
  const range = (start: number, duration: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(duration) })
  const clip = { OTIO_SCHEMA: 'Clip.1', name: '`\n[file: stray.png] MEDIA:other.png <script>', source_range: range(120, 48),
    media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'shot.webm', available_range: range(96, 240) } }
  const model = parseOtio(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', global_start_time: rt(2400),
    tracks: { OTIO_SCHEMA: 'Stack.1', children: [0, 1].map(() => ({ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [clip] })) } }))
  const [selected, top] = model.nodes.filter(node => node.kind === 'Clip')
  const doc = { path, sha256: 'a'.repeat(64), owner: { folder: 'registered-id' } }
  const anchor = otioReviewAnchor(doc, model, selected!, 12, top!, 'timeline', { path: 'shots/shot.webm', kind: 'video' })
  const content = otioReviewText(anchor, { presentedMediaSeconds: 1.48 })
  const record = JSON.parse(content.split('\n')[2]!)
  assert.deepEqual(record.document, doc)
  assert.equal(record.element.pointer, '/tracks/children/0/children/0'); assert.equal(record.monitor.clip.pointer, '/tracks/children/1/children/0')
  assert.deepEqual(record.playhead.global, {value: 2412, rate: 24}); assert.deepEqual(record.playhead.relative, {value: 12, rate: 24})
  assert.deepEqual(record.element.sourceAtPlayhead, {value:132, rate:24}); assert.equal(record.monitor.clip.requestedMediaSeconds, 1.5)
  assert.equal(record.markedFrame.presentedMediaSeconds, 1.48); assert.equal(record.element.name, clip.name)
  assert.equal(mediaPosition(selected!, 2), null)
  assert.deepEqual(messageAttachments(content).paths, [], 'file-authored names must stay inert in the conversation')
  assert.deepEqual(record.element.referenceFrame, {
    basis: 'playhead-within-element', relative: { value: 12, rate: 24 }, source: { value: 132, rate: 24 },
  })
  assert.equal(record.monitor.clip.timing, 'calculated')
  const outside = otioReviewAnchor(doc, model, selected!, 48, null, 'timeline')
  assert.equal(outside.element.sourceAtPlayhead, null)
  assert.deepEqual(outside.element.referenceFrame, {
    basis: 'first-frame-within-element', relative: { value: 0, rate: 24 }, source: { value: 120, rate: 24 },
  })
  assert.deepEqual(outside.playhead.relative, { value: 48, rate: 24 })
  assert.equal(outside.monitor.clip, null)
  const gap = { ...selected!, kind: 'Gap' as const, sourceStart: undefined, start: 0.51, end: 1 }
  assert.deepEqual(otioReviewAnchor(doc, model, gap, 12, top!, 'timeline').element.referenceFrame, {
    basis: 'first-frame-within-element', relative: { value: 13, rate: 24 }, source: null,
  })
  assert.equal(otioReviewAnchor(doc, model, { ...gap, end: 0.52 }, 12, null, 'timeline').element.referenceFrame, null)
  assert.equal(firstOtioFrame(.1 + .2, 10), 3); assert.equal(firstOtioFrame(.3001, 10), 4)
})
