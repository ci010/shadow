import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOtio } from './otio-model.ts'
import { otioMarkerColor, otioMarkerGeometry, otioMarkerRows } from './otio-markers.ts'
const t = (value: number, rate = 16000) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
const r = (start: number, duration: number) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: t(start), duration: t(duration) })
const marker = (start: number, duration: number, version = 2) => ({ OTIO_SCHEMA: `Marker.${version}`, name: '镜 0001', color: 'GREEN', marked_range: r(start, duration) })
const fixture = () => ({ OTIO_SCHEMA: 'Timeline.1', global_start_time: t(57600000), markers: [marker(16000, 0, 1)], tracks: {
  OTIO_SCHEMA: 'Stack.1', source_range: r(16000, 48000), markers: [marker(32000, 0)], children: [{
    OTIO_SCHEMA: 'Track.1', kind: 'Video', source_range: r(16000, 80000), markers: [marker(32000, 16000)], children: [{
      OTIO_SCHEMA: 'Clip.2', name: 'source', source_range: r(160000, 96000), markers: [marker(176000, 0), marker(184000, 32000), marker(208000, 64000), marker(160000, 0)],
    }],
  }],
} })
test('Marker.1/.2 source coordinates compose through nested trims; ranges clip and points outside disappear', () => {
  const model = parseOtio(JSON.stringify(fixture()))
  assert.deepEqual(model.markers.map(m => [m.ownerId, m.start, m.end, m.point]), [
    ['', 1, 1, true], ['/tracks', 1, 1, true], ['/tracks/children/0', 0, 1, false],
    ['/tracks/children/0/children/0', 0, 1.5, false], ['/tracks/children/0/children/0', 1, 3, false],
  ])
  assert.equal(otioMarkerRows(model).length, 5)
  const mark = model.markers.at(-1)!
  assert.deepEqual(otioMarkerGeometry(mark, { start: 1.5, span: 1 }), { left: '0%', width: '100%' })
  assert.deepEqual(otioMarkerGeometry(mark, { start: 0, span: 4 }), { left: '25%', width: '50%' })
  assert.equal(otioMarkerGeometry(mark, { start: 3, span: 1 }), null)
  assert.equal(otioMarkerGeometry(model.markers[0]!, { start: 0, span: 1 }), null)
  assert.equal(otioMarkerColor('GREEN'), '#38935b')
  assert.equal(otioMarkerColor('url(evil)'), 'var(--c-control-border)')
})
test('rejects invalid marker ranges and bounded schema', () => {
  const data = fixture(); data.markers[0]!.marked_range.duration = t(-1)
  assert.throws(() => parseOtio(JSON.stringify(data)), /invalid RationalTime/)
})

test('16000 Hz adjoining ranges do not acquire overlap through floating-point addition', () => {
  const data = fixture()
  const clip = data.tracks.children[0]!.children[0]!
  clip.source_range = r(0, 23529066)
  clip.markers = [marker(12800, 252267), marker(265067, 13333), marker(278400, 9600)]
  data.tracks.source_range = r(0, 23529066)
  data.tracks.children[0]!.source_range = r(0, 23529066)
  data.markers = []; data.tracks.markers = []; data.tracks.children[0]!.markers = []
  const model = parseOtio(JSON.stringify(data))
  assert.equal(model.markers[0]!.end, model.markers[1]!.start)
  assert.equal(otioMarkerRows(model).length, 1)
})
