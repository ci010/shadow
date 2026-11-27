import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { initialTimeline, plan, render } from './index.ts'
import { run } from './process.ts'
import { runVideoCli } from './cli.ts'
const ffmpeg = process.env.TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.TEST_FFPROBE ?? 'ffprobe'
const opts = { ffmpeg, ffprobe }
const rt = (v: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value: v, rate: 24 })
const range = (start = 0, duration = 24) => ({ OTIO_SCHEMA: 'TimeRange.1', start_time: rt(start), duration: rt(duration) })
const clip = (url: string, start = 0, duration = 24) => ({ OTIO_SCHEMA: 'Clip.2', source_range: range(start, duration), media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: url } })
const timeline = (tracks: unknown[]) => ({ OTIO_SCHEMA: 'Timeline.1', tracks: { OTIO_SCHEMA: 'Stack.1', children: tracks } })
const track = (kind: string, children: unknown[]) => ({ OTIO_SCHEMA: 'Track.1', kind, children })
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.resolve('.video-test-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
test('CLI init is no-clobber; revision, validation and strict options', () => fixture(async dir => {
  const file = path.join(dir, 'edit.otio')
  const init = await runVideoCli(['init', file, '--duration', '1', '--rate', '30']) as { revision: string }
  assert.equal((await plan(file)).revision, init.revision)
  assert.equal((await plan(file)).rate, 30, 'gap-only initialization must preserve the requested display rate')
  await assert.rejects(runVideoCli(['init', file]), /EEXIST/)
  await assert.rejects(runVideoCli(['export', file, '--bad', '1']), /Invalid/)
  await assert.rejects(render(file, path.join(dir, 'x.mp4'), { revision: 'stale' }), /Revision mismatch/)
  await assert.rejects(render(file, path.join(dir, 'x.mp4'), { revision: init.revision, end: 0.11 }), /align/)
  const raw = initialTimeline(1) as any
  raw.tracks.children[0].children[0].effects = [{ OTIO_SCHEMA: 'LinearTimeWarp.1' }]
  await writeFile(file, JSON.stringify(raw))
  await assert.rejects(plan(file), /Effects/)
}))
test('network targets and unsupported features rejected without launching probe', () => fixture(async dir => {
  const file = path.join(dir, 'edit.otio')
  await writeFile(file, JSON.stringify(timeline([track('Video', [clip('https://example.com/a.mp4')])])))
  await assert.rejects(plan(file, { ffprobe: '/missing/probe' }), /Only local/)
  await writeFile(file, JSON.stringify(timeline([track('Video', [clip('local.m3u8')])])))
  await assert.rejects(plan(file), /extension/)
}))
test('missing executable actionable; pre-abort and in-flight abort clean processes', async () => {
  await assert.rejects(run('/no/such/ffmpeg', []), /nothing is installed/)
  const c = new AbortController(); c.abort(new Error('stop'))
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], c.signal), /stop/)
  const d = new AbortController()
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], d.signal)
  d.abort(new Error('stop running'))
  await assert.rejects(pending, /stop running/)
})
test('real ffmpeg: image + gap + multitrack video, audio mix, interval, no-clobber, cleanup', async t => {
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']) } catch (e) { t.skip(String(e)); return }
  await fixture(async dir => {
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-t', '2', path.join(dir, 'red.mp4')])
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x64', '-frames:v', '1', path.join(dir, 'blue.png')])
    const file = path.join(dir, 'edit.otio'), output = path.join(dir, 'result.mp4')
    await writeFile(file, JSON.stringify(timeline([track('Video', [clip('red.mp4', 0, 48)]), track('Video', [{ OTIO_SCHEMA: 'Gap.1', source_range: range(0, 24) }, clip('blue.png')]), track('Audio', [clip('red.mp4', 0, 48)]), track('Audio', [clip('red.mp4', 0, 48)])])))
    const p = await plan(file, opts)
    assert.equal(p.pictures.length, 2); assert.equal(p.audio.length, 2)
    const result = await render(file, output, { ...opts, revision: p.revision, width: 64, height: 64, start: 0.5, end: 1.5 })
    assert.equal(result.frames, 24)
    assert.equal(result.audioPolicy, 'explicit-audio-tracks')
    const streams = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output])).streams
    const sound = streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
    assert.equal(sound.codec_name, 'aac')
    assert.equal(Number(sound.sample_rate), 48000)
    const levels = await run(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-af', 'astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'])
    assert.ok([...levels.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/g)].some(m => Number(m[1]) > -60), 'mixed audio must contain the source tone, not only generated silence')
    const before = await readFile(output)
    await assert.rejects(render(file, output, { ...opts, revision: p.revision, width: 64, height: 64 }), /EEXIST/)
    assert.deepEqual(await readFile(output), before)
    assert.equal((await readdir(dir)).some(n => n.startsWith('.shadow-video-')), false)
    await writeFile(file, JSON.stringify(initialTimeline(1)))
    const gap = await plan(file)
    assert.equal((await render(file, path.join(dir, 'gap.mp4'), { ...opts, revision: gap.revision, width: 64, height: 64 })).frames, 24)
    await writeFile(file, JSON.stringify(timeline([track('Video', [clip('red.mp4')])])))
    assert.equal((await plan(file, opts)).audioPolicy, 'visible-video-embedded')
  })
})
test('transition, fractional cuts, invalid source ranges and abort cleanup', async t => {
  await fixture(async dir => {
    const file = path.join(dir, 'edit.otio')
    const transition = { OTIO_SCHEMA: 'Transition.1', in_offset: rt(1), out_offset: rt(1) }
    await writeFile(file, JSON.stringify(timeline([track('Video', [transition, { OTIO_SCHEMA: 'Gap.1', source_range: range() }])])) )
    await assert.rejects(plan(file), /Unsupported|Transitions/)
    try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']) } catch (e) { t.skip(String(e)); return }
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=64x64:r=24:d=1', '-c:v', 'libx264', path.join(dir, 'media.mp4')])
    const offsetClip: any = clip('media.mp4', 240)
    offsetClip.media_reference.available_range = range(240)
    await writeFile(file, JSON.stringify(timeline([track('Video', [offsetClip])])))
    let p = await plan(file, opts)
    const result = await render(file, path.join(dir, 'offset.mp4'), { ...opts, revision: p.revision, width: 64, height: 64 })
    assert.equal(result.frames, 24)
    offsetClip.source_range = range(260)
    await writeFile(file, JSON.stringify(timeline([track('Video', [offsetClip])])))
    await assert.rejects(plan(file, opts), /outside media/)
    await writeFile(file, JSON.stringify(initialTimeline(1)))
    p = await plan(file)
    await assert.rejects(render(file, path.join(dir, 'missing.mp4'), { revision: p.revision, ffmpeg: '/missing/ffmpeg' }), /nothing is installed/)
    assert.equal((await readdir(dir)).some(n => n.startsWith('.shadow-video-')), false)
    const c = new AbortController(); c.abort(new Error('cancelled'))
    await assert.rejects(render(file, path.join(dir, 'aborted.mp4'), { ...opts, signal: c.signal, revision: p.revision }), /cancelled/)
    assert.equal((await readdir(dir)).some(n => n.startsWith('.shadow-video-')), false)
  })
})
test('process deadline and stdout byte cap terminate and await close', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], undefined, 30), /timed out/)
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(5*1024*1024));setInterval(()=>{},1000)']), /output limit/)
})
