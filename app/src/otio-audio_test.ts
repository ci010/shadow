import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOtioAudio, otioAudioPosition, otioAudioTracks } from './otio-audio.ts'
import type { OtioModel, OtioNode } from './otio-model.ts'
import { resolveOtioMedia } from './otio-review.ts'

const track: OtioNode = { id: 'a', parentId: null, depth: 0, name: '', kind: 'Track', schema: '', trackKind: 'Audio', enabled: true, start: 0, end: 4, sourceStart: null }
const clip: OtioNode = { ...track, id: 'c', parentId: 'a', kind: 'Clip', start: 1, end: 2,
  targetUrl: 'voice.wav', sourceStart: { value: 30, rate: 10 }, mediaStart: { value: 20, rate: 10 } }

test('audio projection respects trims, media origins, gaps and disabled clips', () => {
  const model: OtioModel = { root: track, nodes: [track, clip, { ...clip, id: 'disabled', enabled: false }], rate: 24, duration: 4, globalStart: null, warnings: [] }
  assert.deepEqual(otioAudioTracks(model), { explicit: true, clips: [{ node: clip, track: 'a' }] })
  assert.equal(otioAudioPosition(clip, 0.99), null)
  assert.equal(otioAudioPosition(clip, 1), 1)
  assert.equal(otioAudioPosition(clip, 1.5), 1.5)
  assert.equal(otioAudioPosition(clip, 2), null)
  assert.deepEqual(resolveOtioMedia('cuts/cut.otio', '../voice.wav'), { path: 'voice.wav', kind: 'audio' })
  assert.equal(resolveOtioMedia('cuts/cut.otio', '../../voice.wav'), null)
  assert.equal(resolveOtioMedia('cuts/cut.otio', 'https://example.test/voice.wav'), null)
})

test('audio controller starts overlapping voices at current trim and releases them on exit', () => {
  const created: Media[] = []
  class Media {
    readyState = 0
    duration = 10
    currentTime = 0
    plays = 0
    pauses = 0
    loads = 0
    src = ''
    onloadedmetadata: (() => void) | null = null
    play() { this.plays++; return Promise.resolve() }
    pause() { this.pauses++ }
    load() { this.loads++ }
    removeAttribute() { this.src = '' }
  }
  const audio = createOtioAudio(() => {
    const media = new Media()
    created.push(media)
    return media as unknown as HTMLAudioElement
  })
  const a = { id: 'a', url: '/raw/voice.wav', seconds: 1 }
  const b = { id: 'b', url: '/raw/music.wav', seconds: 3 }
  audio.sync([a, b])
  audio.sync([{ ...a, seconds: 1.25 }, b])
  assert.equal(created[0].plays, 0)
  const late = created[0].onloadedmetadata!
  for (const media of created) { media.readyState = 1; media.onloadedmetadata!() }
  assert.deepEqual(created.map(media => [media.plays, media.currentTime]), [[1, 1.25], [1, 3]])
  audio.sync([b])
  late()
  assert.equal(created[0].src, '')
  assert.equal(created[0].plays, 1)
  audio.stop()
  assert.deepEqual(created.map(media => [media.pauses, media.loads]), [[1, 1], [1, 1]])
})
