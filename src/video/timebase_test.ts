import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { initialTimeline, plan, render } from './index.ts'
import { run } from './process.ts'

const ffmpeg = process.env.TEST_FFMPEG ?? 'ffmpeg', ffprobe = process.env.TEST_FFPROBE ?? 'ffprobe'
const options = { ffmpeg, ffprobe }
const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
function timeline(rate: number, frames: number, target?: string) {
  const raw = initialTimeline(5, rate, frames)
  if (target) Object.assign(raw.tracks.children[0]!.children[0]!, { OTIO_SCHEMA: 'Clip.2', media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: target } })
  return raw
}

test('initialTimeline preserves integer frame values and validates bounds', () => {
  assert.equal(initialTimeline().tracks.children[0]!.children[0]!.source_range.duration.value, 120)
  for (const rate of [24000 / 1001, 30000 / 1001, 60000 / 1001, 24]) {
    assert.equal(initialTimeline(NaN, rate, 17).tracks.children[0]!.children[0]!.source_range.duration.value, 17)
    assert.equal(initialTimeline(17 / rate, rate).tracks.children[0]!.children[0]!.source_range.duration.value, 17)
  }
  for (const frames of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 86400 * 120 + 1]) assert.throws(() => initialTimeline(5, 120, frames))
  for (const rate of [0, 0.99, 121, NaN, Infinity]) assert.throws(() => initialTimeline(5, rate, 1))
  for (const duration of [0, -1, NaN, Infinity, 86401, 1 / 48]) assert.throws(() => initialTimeline(duration, 24))
})

test('plan rejects fractional timeline frames and accepts floating-point roundoff', async () => {
  const dir = await mkdtemp(path.resolve('.video-timebase-unit-'))
  try {
    const file = path.join(dir, 'edit.otio'), raw = timeline(24000 / 1001, 17)
    await writeFile(file, JSON.stringify(raw))
    const p = await plan(file)
    assert.equal(p.timelineFrames, 17)
    assert.deepEqual(p.warnings, [])
    raw.tracks.children[0]!.children[0]!.source_range.duration = rt(17.01, 24000 / 1001)
    await writeFile(file, JSON.stringify(raw))
    await assert.rejects(plan(file), /whole frames/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real FFmpeg fractional CFR and 25fps sampling: frame count, duration, tail and intervals', async () => {
  // Missing executables or codecs fail this regression rather than silently skip it.
  await run(ffmpeg, ['-version']); await run(ffprobe, ['-version'])
  const dir = await mkdtemp(path.resolve('.video-timebase-real-'))
  try {
    for (const [sourceRate, rate] of [[24000 / 1001, 24000 / 1001], [30000 / 1001, 30000 / 1001], [60000 / 1001, 60000 / 1001], [25, 30000 / 1001]]) {
      const prefix = `${sourceRate}-${rate}`, source = path.join(dir, `${prefix}-source.mp4`)
      await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `nullsrc=s=64x64:r=${sourceRate}:d=2,geq=lum='16+mod(N*7,200)':cb=128:cr=128`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source])
      const frames = 24, file = path.join(dir, `${prefix}.otio`)
      await writeFile(file, JSON.stringify(timeline(rate, frames, path.basename(source))))
      const p = await plan(file, options)
      assert.equal(p.timelineFrames, frames)
      const timing = Object.values(p.assets)[0]!.timing
      assert.equal(timing.outputRate, rate)
      assert.ok(timing.avg_frame_rate && timing.r_frame_rate && timing.time_base)
      assert.equal(timing.streamDurationSource, 'duration')
      assert.match(timing.sampling, /sampled to constant output rate/)
      const full = path.join(dir, `${prefix}-full.mp4`), interval = path.join(dir, `${prefix}-interval.mp4`)
      const rendered = await render(file, full, { ...options, revision: p.revision, width: 64, height: 64 })
      assert.equal(rendered.frames, frames)
      const startFrame = 7, endFrame = 19
      const preview = await render(file, interval, { ...options, revision: p.revision, width: 64, height: 64, start: startFrame / rate, end: endFrame / rate })
      assert.equal(preview.frames, endFrame - startFrame)
      const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-show_frames', '-of', 'json', full]))
      assert.equal(Number(probe.streams[0].nb_read_frames), frames)
      assert.ok(Math.abs(Number(probe.streams[0].duration) - frames / rate) < 0.00001)
      assert.ok(Math.abs(Number(probe.frames.at(-1).best_effort_timestamp_time) - (frames - 1) / rate) < 0.00001)
      const decode = async (input: string, name: string, filter?: string) => {
        const output = path.join(dir, `${prefix}-${name}.rgb`)
        await run(ffmpeg, ['-v', 'error', '-i', input, ...(filter ? ['-vf', filter] : []), '-pix_fmt', 'rgb24', '-f', 'rawvideo', output])
        return readFile(output)
      }
      const whole = await decode(full, 'full'), segment = await decode(interval, 'interval')
      assert.equal(whole.length, frames * 64 * 64 * 3)
      assert.equal(segment.length, (endFrame - startFrame) * 64 * 64 * 3)
      // Independent lossy encodes need not be byte equal; per-frame image error
      // must remain small (a one-frame shift in the seven-level luminance ramp exceeds this bound).
      for (let frame = 0; frame < endFrame - startFrame; frame++) {
        let error = 0
        for (let i = 0; i < 64 * 64 * 3; i++) error += Math.abs(whole[(startFrame + frame) * 64 * 64 * 3 + i]! - segment[frame * 64 * 64 * 3 + i]!)
        assert.ok(error / (64 * 64 * 3) < 3, `interval differs at frame ${frame}: ${error / (64 * 64 * 3)}`)
      }
      const sourcePixels = await decode(source, 'sampled', `fps=${rate},trim=end_frame=${frames}`)
      assert.equal(sourcePixels.length, whole.length)
      let tailError = 0
      for (let i = whole.length - 64 * 64 * 3; i < whole.length; i++) tailError += Math.abs(whole[i]! - sourcePixels[i]!)
      assert.ok(tailError / (64 * 64 * 3) < 3, `tail frame must match source sampled to output rate: mean error ${tailError / (64 * 64 * 3)}`)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
