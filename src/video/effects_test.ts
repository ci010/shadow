import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { plan, render } from './index.ts'
import { run } from './process.ts'
import { runVideoCli } from './cli.ts'
import { prepareOtioProfile, OTIO_PROFILE_EXAMPLES } from '../shared/otio-effects.ts'
const ffmpeg = process.env.TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.TEST_FFPROBE ?? 'ffprobe'
const opts = { ffmpeg, ffprobe }
const rt = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 24 })
const range = (start = 0, duration = 48) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(duration) })
const effect = (profile: string, values: object) => ({ OTIO_SCHEMA: 'Effect.1', effect_name: `shadow.${profile}`, metadata: { shadow: { profile, ...values } } })
const clip = (target_url: string, effects: unknown[] = [], start = 0, duration = 48) => ({ OTIO_SCHEMA: 'Clip.2', source_range: range(start, duration), media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url }, effects })
const track = (children: unknown[], kind = 'Video') => ({ OTIO_SCHEMA: 'Track.1', kind, children })
const timeline = (...children: unknown[]) => ({ OTIO_SCHEMA: 'Timeline.1', tracks: { OTIO_SCHEMA: 'Stack.1', children } })

test('strict browser-safe profiles: disabled/unknown/injection rejected, timing preserved', () => {
  const raw = timeline(track([clip('red.png', [effect('opacity', { value: 0.5 })])]))
  const text = JSON.stringify(raw), p = prepareOtioProfile(text)
  assert.equal(p.model.nodes.find(n => n.kind === 'Clip')!.sourceStart!.value, 0)
  assert.equal(JSON.stringify(raw), text)
  assert.equal(p.requiresCompositePreview, true)
  for (const e of [effect('unknown', {}), effect('opacity', { value: '1;movie=evil' }), effect('opacity', { enabled: false }), { ...effect('opacity', {}), enabled: false }, { OTIO_SCHEMA: 'LinearTimeWarp.1' }, effect('transform', { rotate: 90 }), effect('crop', { left: 0.7, right: 0.7 })]) {
    assert.throws(() => prepareOtioProfile(JSON.stringify(timeline(track([clip('red.png', [e])])))), /Unsupported/)
  }
  for (const name of ['slide', 'fadeblack']) assert.throws(() => prepareOtioProfile(JSON.stringify(timeline(track([clip('a'), { ...OTIO_PROFILE_EXAMPLES.wiperight, metadata: { shadow: { profile: name } } }, clip('b')])))), /only SMPTE/)
})

test('nested parallel layers and alpha formats require composition; large plain documents remain readable', () => {
  const stack = { OTIO_SCHEMA: 'Stack.1', children: [clip('a.mp4'), clip('b.mp4')] }
  assert.equal(prepareOtioProfile(JSON.stringify(timeline(track([stack])))).requiresCompositePreview, true)
  assert.equal(prepareOtioProfile(JSON.stringify(timeline(track([clip('a.webp')])))).requiresCompositePreview, true)
  const plain = prepareOtioProfile(JSON.stringify(timeline(track(Array.from({ length: 18000 }, () => ({ OTIO_SCHEMA: 'Gap.1', source_range: range(0,1) }))))))
  assert.equal(plain.model.nodes.length, 18003)
  assert.equal(plain.requiresCompositePreview, false)
  assert.throws(() => prepareOtioProfile(JSON.stringify(timeline(track([{ OTIO_SCHEMA: 'Stack.1', children: [track([clip('a.png')])] }])))), /nested Tracks/)
})

test('real pixels/audio: alpha, PNG, effects, dissolve/wipe handles, interval clocks, manifest', async t => {
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']) } catch (e) { t.skip(String(e)); return }
  const dir = await mkdtemp(path.resolve('.video-profile-test-'))
  try {
    for (const [name, color] of [['red', 'red'], ['blue', 'blue'], ['alpha', 'blue@0.5']]) await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x64,format=${name === 'alpha' ? 'rgba' : 'rgb24'}`, '-frames:v', '1', path.join(dir, `${name}.png`)])
    const file = path.join(dir, 'edit.otio')
    let serial = 0
    async function movie(raw: unknown, start?: number, end?: number) {
      await writeFile(file, JSON.stringify(raw))
      const p = await plan(file, opts), out = path.join(dir, `out${serial++}.mp4`)
      await render(file, out, { ...opts, revision: p.revision, width: 64, height: 64, start, end })
      return out
    }
    async function pixels(out: string) {
      const raw = path.join(dir, `rgb${serial++}`)
      await run(ffmpeg, ['-v', 'error', '-i', out, '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw])
      const data = await readFile(raw)
      return (frame: number, x = 32, y = 32) => [...data.subarray((frame*64*64+y*64+x)*3, (frame*64*64+y*64+x)*3+3)]
    }
    const purple = (rgb: number[]) => { assert.ok(rgb[0]! > 110 && rgb[0]! < 145, String(rgb)); assert.ok(rgb[2]! > 110 && rgb[2]! < 145, String(rgb)) }
    let sample = await pixels(await movie(timeline(track([clip('red.png')]), track([clip('blue.png', [effect('opacity', { value: 0.5 })])]))))
    purple(sample(12))
    sample = await pixels(await movie(timeline(track([clip('red.png')]), track([clip('alpha.png')]))))
    purple(sample(12))
    sample = await pixels(await movie(timeline(track([clip('red.png')]), track([clip('alpha.png', [effect('color', { brightness: 0, contrast: 1, saturation: 1 }), effect('crop', { left: 0.1, right: 0.1 }), effect('transform', { scale: 0.75 }), effect('opacity', { value: 1 })])]))))
    purple(sample(12))
    assert.ok(sample(12, 0)[0]! > 240, 'alpha geometry outside must show lower red')
    sample = await pixels(await movie(timeline(track([clip('red.png')]), track([clip('blue.png', [effect('transform', { x: 0.4, scale: 0.5 }), effect('crop', { left: 0.25, right: 0.25 }), effect('color', { saturation: 0 })])]))))
    assert.ok(sample(12, 4)[0]! > 240, 'lower red track visible outside transformed upper layer')
    const grey = sample(12, 58); assert.ok(Math.max(...grey)-Math.min(...grey) < 10, String(grey))
    for (const transition of [OTIO_PROFILE_EXAMPLES.dissolve, OTIO_PROFILE_EXAMPLES.wiperight]) {
      const edit = timeline(track([clip('red.png', [], 0, 48), transition, clip('blue.png', [], 12, 48)]))
      const full = await pixels(await movie(edit)), partial = await pixels(await movie(edit, 1.75, 2.75))
      assert.ok(full(35)[0]! > 240 && full(35)[2]! < 10, String(full(35)))
      if (transition.transition_type === 'SMPTE_Dissolve') purple(full(48))
      else { assert.ok(full(48, 8)[2]! > 240, String(full(48,8))); assert.ok(full(48, 56)[0]! > 240, String(full(48,56))) }
      assert.ok(full(61)[2]! > 240 && full(61)[0]! < 10, String(full(61)))
      // Independent H.264 GOPs can ring differently exactly on a wipe edge.
      // Compare frame-wide mean: a one-frame wipe timing error is ~10 RGB levels.
      for (let i=0;i<24;i++) for (let k=0;k<3;k++) {
        let a=0, b=0
        for (let x=0;x<64;x++) { a += full(42+i,x)[k]!; b += partial(i,x)[k]! }
        assert.ok(Math.abs(a-b)/64 <= 4, `${i} channel ${k}: means ${a/64} != ${b/64}`)
      }
    }
    const dissolveTrack = track([clip('red.png'), OTIO_PROFILE_EXAMPLES.dissolve, clip('blue.png', [], 12)])
    const upperAlpha = await pixels(await movie(timeline(dissolveTrack, track([clip('alpha.png', [], 0, 96)]))))
    purple(upperAlpha(12))
    assert.ok(upperAlpha(70)[2]! > 240 && upperAlpha(70)[0]! < 10)
    const lowerAlpha = await pixels(await movie(timeline(track([clip('alpha.png', [], 0, 96)]), dissolveTrack)))
    purple(lowerAlpha(48))
    // These are rejected rather than approximated: RGBA endpoint blending needs
    // a premultiplied track-local crossfade, not ordinary over compositing.
    const half = effect('opacity', { value: 0.5 })
    await writeFile(file, JSON.stringify(timeline(track([clip('red.png')]), track([clip('red.png', [half]), OTIO_PROFILE_EXAMPLES.dissolve, clip('blue.png', [half], 12)]))))
    await assert.rejects(plan(file, opts), /at \/tracks\/children\/1\/children\/0: transitions require opaque/)
    await writeFile(file, JSON.stringify(timeline(track([clip('alpha.png'), OTIO_PROFILE_EXAMPLES.dissolve, clip('blue.png', [], 12)]))))
    await assert.rejects(plan(file, opts), /endpoint at \/tracks\/children\/0\/children\/0: alpha/)
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=96x64,format=rgb24', '-frames:v', '1', path.join(dir, 'wide.png')])
    await writeFile(file, JSON.stringify(timeline(track([clip('wide.png'), OTIO_PROFILE_EXAMPLES.dissolve, clip('blue.png', [], 12)]))))
    await assert.rejects(plan(file, opts), /matching aspect ratio/)
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=2', '-c:v', 'libx264', path.join(dir, 'short.mp4')])
    await writeFile(file, JSON.stringify(timeline(track([clip('short.mp4', [], 0, 48), OTIO_PROFILE_EXAMPLES.dissolve, clip('blue.png', [], 12, 48)]))))
    await assert.rejects(plan(file, opts), /outside media/)
    await writeFile(file, JSON.stringify(timeline(track([clip('red.png', [], 0, 48), OTIO_PROFILE_EXAMPLES.dissolve, clip('short.mp4', [], 0, 24)]))))
    await assert.rejects(plan(file, opts), /outside media/)
    // Time-varying media proves handles are decoded, not frozen or cut early.
    for (const [name, first, second, firstDuration] of [['outgoing', 'red', 'green', 2], ['incoming', 'blue', 'yellow', 1]] as const) {
      await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=${first}:s=64x64:r=24:d=${firstDuration}`, '-f', 'lavfi', '-i', `color=${second}:s=64x64:r=24:d=${3-firstDuration}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', path.join(dir, `${name}.mp4`)])
    }
    const handles = await pixels(await movie(timeline(track([clip('outgoing.mp4', [], 0, 48), OTIO_PROFILE_EXAMPLES.dissolve, clip('incoming.mp4', [], 12, 48)]))))
    const postroll = handles(54)
    assert.ok(postroll[0]! < 10 && postroll[1]! > 20 && postroll[2]! > 160, `postroll must be green/blue, not red/blue: ${postroll}`)
    assert.ok(handles(61)[0]! > 240 && handles(61)[1]! > 240, `incoming source must advance into yellow: ${handles(61)}`)
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000', path.join(dir, 'tone.wav')])
    const sound = await movie(timeline(track([clip('red.png')]), track([clip('tone.wav', [effect('volume', { value: 0.5 }), effect('audioFade', { in: 0.5, out: 0.5 })])], 'Audio')))
    const pcm = path.join(dir, 'pcm')
    await run(ffmpeg, ['-v', 'error', '-i', sound, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcm])
    const data = await readFile(pcm)
    const rms = (start: number, end: number) => { let sum=0, count=0; for(let i=Math.round(start*48000);i<Math.round(end*48000);i++){sum += data.readFloatLE(i*4)**2; count++}return Math.sqrt(sum/count) }
    assert.ok(rms(0.8,1.2) > 0.025 && rms(0.8,1.2) < 0.06, String(rms(0.8,1.2)))
    assert.ok(rms(0,0.1) < rms(0.8,1.2)*0.3)
    assert.ok(rms(1.9,1.99) < rms(0.8,1.2)*0.3)
    const p = await plan(file, opts), receipt = path.join(dir, 'edit.otio.preview.json'), output = path.join(dir, 'receipt.mp4')
    const args = ['preview', file, '--output', output, '--revision', p.revision, '--start', '0.5', '--end', '1.5', '--width', '64', '--height', '64', '--manifest', receipt, '--ffmpeg', ffmpeg, '--ffprobe', ffprobe]
    await runVideoCli(args)
    assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { version: 1, profileVersion: 1, sourceSha256: p.revision, media: 'receipt.mp4', start: 0.5, end: 1.5, rate: 24, frames: 24 })
    const again = [...args]; again[again.indexOf(output)] = path.join(dir, 'retained.mp4')
    await assert.rejects(runVideoCli(again), /video retained.*manifest failed/)
    assert.ok((await readFile(path.join(dir, 'retained.mp4'))).length > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
