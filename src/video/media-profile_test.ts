import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { localMediaPath, assertLocalPath, streamDuration, streamDurationEvidence } from './media-profile.ts'
import { plan, render } from './index.ts'
import { run } from './process.ts'
import { runVideoCli } from './cli.ts'
import { OTIO_PROFILE_EXAMPLES } from '../shared/otio-effects.ts'

const ffmpeg = process.env.TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.TEST_FFPROBE ?? 'ffprobe'
const options = { ffmpeg, ffprobe }
const rt = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 24 })
const clip = (target_url: string, frames = 48) => ({ OTIO_SCHEMA: 'Clip.2', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(0), duration: rt(frames) }, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url } })
const track = (target: string, kind = 'Video', frames = 48) => ({ OTIO_SCHEMA: 'Track.1', kind, children: [clip(target, frames)] })
const timeline = (...children: unknown[]) => ({ OTIO_SCHEMA: 'Timeline.1', tracks: { OTIO_SCHEMA: 'Stack.1', children } })

test('pure local preflight rejects UNC/device/remote file URLs on every platform', async () => {
  for (const target of ['\\\\host\\share\\clip.mp4', '//host/share/clip.mp4', '\\/host/share/clip.mp4', '\\\\?\\UNC\\host\\share\\clip.mp4', '\\??\\UNC\\host\\share\\clip.mp4', '\\\\.\\pipe\\clip.mp4', 'file://host/share/clip.mp4', 'file:////host/share/clip.mp4', 'file:///C:/%5c%5chost/clip.mp4']) {
    // URL decoding may either reject an encoded separator or expose the network prefix.
    if (target.includes('C:/%5c')) { assert.throws(() => localMediaPath(target, 'C:\\work', true)); continue }
    assert.throws(() => localMediaPath(target, 'C:\\work', true), /local|host/i, target)
  }
  assert.equal(localMediaPath('file:///C:/clips/a.mp4', 'C:\\work', true), 'C:\\clips\\a.mp4')
  assert.equal(localMediaPath('file://localhost/C:/clips/a.mp4', 'C:\\work', true), 'C:\\clips\\a.mp4')
  assert.equal(localMediaPath('C:\\clips\\a.mp4', 'C:\\work', true), 'C:\\clips\\a.mp4')
  assert.doesNotThrow(() => assertLocalPath('/tmp/a.mp4'))
  // No stat, ffprobe or network request can precede this rejection.
  await assert.rejects(plan('\\\\host\\share\\edit.otio', { ffprobe: 'must-not-launch' }), /network\/device/)
  await assert.rejects(render('unused.otio', '\\\\host\\share\\out.mp4', { revision: '' }), /network\/device/)
})

test('duration evidence is stream-specific and unknown streams fail closed', () => {
  assert.equal(streamDuration({ codec_type: 'video', duration: '1' }), 1)
  assert.equal(streamDuration({ codec_type: 'audio', duration_ts: 48000, time_base: '1/48000' }), 1)
  assert.equal(streamDuration({ codec_type: 'video', start_time: '0', tags: { DURATION: '00:00:02.125000000' } }), 2.125)
  assert.equal(streamDuration({ codec_type: 'video', start_time: '2', tags: { DURATION: '00:00:03.000' } }), 1)
  assert.equal(streamDuration({ codec_type: 'video', tags: { DURATION: '00:00:03.000' } }), null)
  assert.equal(streamDuration({ codec_type: 'video' }), null)
})

test('real VP9 alpha pixels, ordinary WebM and unequal selected-stream ranges', async t => {
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']) } catch (e) { t.skip(String(e)); return }
  const dir = await mkdtemp(path.resolve('.video-media-profile-test-'))
  try {
    const file = path.join(dir, 'edit.otio')
    const save = async (raw: unknown) => { await writeFile(file, JSON.stringify(raw)); return plan(file, options) }
    const generate = (args: string[]) => run(ffmpeg, ['-v', 'error', ...args])
    await generate(['-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', path.join(dir, 'red.png')])
    await generate(['-f', 'lavfi', '-i', 'color=blue@0.5:s=64x64:r=24:d=2,format=yuva420p', '-c:v', 'libvpx-vp9', '-auto-alt-ref', '0', path.join(dir, 'alpha.webm')])
    const p = await save(timeline(track('red.png'), track('alpha.webm')))
    assert.equal(Object.values(p.assets).find(a => a.file.endsWith('.webm'))!.decoder, 'libvpx-vp9')
    const output = path.join(dir, 'alpha.mp4')
    await render(file, output, { ...options, revision: p.revision, width: 64, height: 64 })
    const raw = path.join(dir, 'pixel.rgb')
    await generate(['-i', output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw])
    const rgb = [...(await readFile(raw)).subarray((32 * 64 + 32) * 3, (32 * 64 + 32) * 3 + 3)]
    assert.ok(rgb[0]! > 110 && rgb[0]! < 145 && rgb[2]! > 110 && rgb[2]! < 145, `Expected red/blue alpha blend, got ${rgb}`)
    await generate(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=2', '-c:v', 'libvpx-vp9', path.join(dir, 'plain.webm')])
    const plain = await save(timeline(track('plain.webm')))
    assert.equal(Object.values(plain.assets)[0]!.alpha, true, 'VP9 without AlphaMode is not proven opaque')
    const transitionTrack = { OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [clip('plain.webm', 24), OTIO_PROFILE_EXAMPLES.dissolve, { ...clip('plain.webm', 24), source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(12), duration: rt(24) } }] }
    await assert.rejects(save(timeline(transitionTrack)), /alpha-capable/)
    await save(timeline(track('plain.webm')))
    // Explicit executable options must reach capability preflight for both commands.
    for (const command of ['plan', 'validate']) {
      await assert.rejects(runVideoCli([command, file, '--ffmpeg', path.join(dir, 'missing-ffmpeg'), '--ffprobe', ffprobe]), /Cannot execute/)
      await runVideoCli([command, file, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe])
    }
    await save(timeline(track('red.png')))
    await runVideoCli(['plan', file, '--ffmpeg', path.join(dir, 'missing-ffmpeg'), '--ffprobe', ffprobe])
    await generate(['-f', 'lavfi', '-i', 'color=blue:s=64x64:r=24:d=1', '-vf', 'setpts=PTS+2/TB', '-c:v', 'libvpx-vp9', path.join(dir, 'offset.webm')])
    const offsetProbe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(dir, 'offset.webm')]))
    assert.equal(Number(offsetProbe.streams[0].start_time), 2)
    assert.equal(offsetProbe.streams[0].tags.DURATION, '00:00:03.000000000')
    assert.equal(streamDuration(offsetProbe.streams[0]), 1)
    await save(timeline(track('offset.webm', 'Video', 24)))
    await assert.rejects(save(timeline(track('offset.webm'))), /Source range outside media duration/)

    for (const [name, video, audio, kind] of [['short-video', 1, 3, 'Video'], ['short-audio', 3, 1, 'Audio']] as const) {
      await generate(['-f', 'lavfi', '-i', `color=red:s=64x64:r=24:d=${video}`, '-f', 'lavfi', '-i', `sine=duration=${audio}`, '-c:v', 'libx264', '-c:a', 'aac', path.join(dir, `${name}.mp4`)])
      await assert.rejects(save(timeline(track(`${name}.mp4`, kind))), /Source range outside media duration/)
    }
    await writeFile(file, JSON.stringify(timeline(track('file://host/share/clip.mp4'))))
    await assert.rejects(plan(file, { ffprobe: 'must-not-launch' }), /remote file host/)
    await writeFile(file, JSON.stringify(timeline(track('\\\\host\\share\\clip.mp4'))))
    await assert.rejects(plan(file, { ffprobe: 'must-not-launch' }), /network\/device/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('CLI rejects init/manifest network destinations before file access or tool execution', async () => {
  for (const target of ['\\\\host\\share\\new.json', '//host/share/new.json', 'file://host/share/new.json', '\\\\?\\UNC\\host\\share\\new.json']) {
    await assert.rejects(runVideoCli(['init', target]), /network\/device|remote file host/)
    // Source deliberately nonexistent: network manifest must fail before source stat.
    await assert.rejects(runVideoCli(['preview', 'must-not-stat.otio', '--output', 'must-not-create.mp4', '--revision', 'x', '--start', '0', '--end', '1', '--manifest', target, '--ffmpeg', 'must-not-launch']), /network\/device|remote file host/)
  }
})


test('duration evidence reports provenance without container fallback', () => {
  assert.deepEqual(streamDurationEvidence({ codec_type: 'video', duration: '2', duration_ts: 48, time_base: '1/24' }), { duration: 2, source: 'duration' })
  assert.deepEqual(streamDurationEvidence({ codec_type: 'video', duration_ts: 48, time_base: '1/24' }), { duration: 2, source: 'duration_ts*time_base' })
  assert.deepEqual(streamDurationEvidence({ codec_type: 'video', start_time: '1', tags: { DURATION: '00:00:03' } }), { duration: 2, source: 'tags.DURATION-start' })
  assert.deepEqual(streamDurationEvidence({ codec_type: 'video', time_base: '0/0' }), { duration: null, source: 'unknown' })
})

test('plan warnings are relevant, separate from diagnostics, and preserve audio policy', async () => {
  const dir = await mkdtemp(path.resolve('.video-audio-warnings-'))
  try {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, 'av.mp4')])
    const file = path.join(dir, 'edit.otio')
    const save = async (...tracks: unknown[]) => { await writeFile(file, JSON.stringify(timeline(...tracks))); return plan(file, options) }
    const video = track('av.mp4')
    assert.deepEqual((await save(video)).warnings, [])
    const empty = { OTIO_SCHEMA: 'Track.1', kind: 'Audio', children: [] }
    const suppressed = await save(video, empty)
    assert.equal(suppressed.audioPolicy, 'explicit-audio-tracks')
    assert.equal(suppressed.audio.length, 0)
    assert.match(suppressed.warnings.join('\n'), /^AUDIO_EMPTY_EXPLICIT_SUPPRESSES_EMBEDDED:/)
    assert.deepEqual(suppressed.profile.diagnostics, [])
    const cuts = { OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [clip('av.mp4', 24), clip('av.mp4', 24)] }
    const embedded = await save(cuts)
    assert.equal(embedded.audioPolicy, 'visible-video-embedded')
    assert.match(embedded.warnings.join('\n'), /^AUDIO_EMBEDDED_VISIBLE_HARD_CUT:/)
    const additive = await save(video, track('av.mp4', 'Audio'), track('av.mp4', 'Audio'))
    assert.equal(additive.audio.length, 2)
    assert.match(additive.warnings.join('\n'), /^AUDIO_ADDITIVE_UNNORMALIZED_CLIPPING:/)
    assert.deepEqual((await save(video, { OTIO_SCHEMA: 'Track.1', kind: 'Audio', children: [clip('av.mp4', 24), clip('av.mp4', 24)] })).warnings, [])
    // Disabled tracks must not suppress or warn.
    assert.deepEqual((await save(video, { ...empty, enabled: false })).warnings, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
