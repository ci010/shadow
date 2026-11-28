import { createHash } from 'node:crypto'
import { readFile, stat, lstat, mkdtemp, rm, link } from 'node:fs/promises'
import path from 'node:path'
import { localMediaPath, assertLocalPath, streamDuration, streamDurationEvidence, alphaDecoder, type MediaStream } from './media-profile.ts'
import { otioPictureSpans, type OtioNode, MAX_OTIO_BYTES } from '../shared/otio-model.ts'
import { run } from './process.ts'
import { prepareOtioProfile } from '../shared/otio-effects.ts'
export const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex')
export interface Options { ffmpeg?: string; ffprobe?: string; signal?: AbortSignal }
export interface RenderOptions extends Options { revision: string; start?: number; end?: number; width?: number; height?: number }
const formats: Record<string, string> = { '.mp4': 'mov', '.mov': 'mov', '.m4a': 'mov', '.mkv': 'matroska', '.webm': 'matroska', '.wav': 'wav', '.mp3': 'mp3', '.flac': 'flac', '.ogg': 'ogg', '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.webp': 'webp_pipe' }
const images = new Set(['png_pipe', 'jpeg_pipe', 'webp_pipe'])
function inputArgs(file: string, format: string, decoder?: string): string[] { return ['-protocol_whitelist', 'file,pipe', ...(decoder ? ['-c:v', decoder] : []), '-f', format, '-i', file] }
function sourceOffset(n: OtioNode) { return n.sourceStart!.value / n.sourceStart!.rate - (n.mediaStart ? n.mediaStart.value / n.mediaStart.rate : 0) }
/** Frame comparisons use an absolute tolerance of 1e-6 frame, not seconds. */
export const FRAME_TOLERANCE = 1e-6
function wholeFrames(value: number) {
  const rounded = Math.round(value)
  if (!Number.isSafeInteger(rounded) || rounded < 1 || Math.abs(value - rounded) >= FRAME_TOLERANCE) throw new Error('Timeline duration must align to whole frames')
  return rounded
}
export function initialTimeline(duration = 5, rate = 24, frames?: number) {
  if (!Number.isFinite(rate) || rate < 1 || rate > 120) throw new Error('init rate must be 1..120')
  const count = frames === undefined ? wholeFrames(duration * rate) : frames
  if (!Number.isSafeInteger(count) || count <= 0 || count / rate > 86400) throw new Error('init duration must be positive whole frames <= 24h; frames must be a positive safe integer')
  const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
  return { OTIO_SCHEMA: 'Timeline.1', name: 'Agent video', global_start_time: time(0), tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Gap.1', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: time(0), duration: time(count) } }] }] } }
}
export async function plan(file: string, options: Options = {}) {
  assertLocalPath(file)
  options.signal?.throwIfAborted()
  if ((await stat(file)).size > MAX_OTIO_BYTES) throw new Error('OTIO file exceeds size limit')
  const text = await readFile(file, 'utf8'), profile = prepareOtioProfile(text), { model } = profile
  if (!(model.duration > 0) || model.duration > 86400 || model.rate < 1 || model.rate > 120) throw new Error('Supported timeline: duration > 0 and <= 24h, rate 1..120')
  const timelineFrames = wholeFrames(model.duration * model.rate)
  const placements = new Map(model.nodes.filter(n => n.kind === 'Clip').map(n => [n.id, { start: n.start, end: n.end }]))
  for (const t of Object.values(profile.transitions)) {
    placements.get(t.from)!.end += t.outOffset
    placements.get(t.to)!.start -= t.inOffset
  }
  const assets: Record<string, { file: string; format: string; image: boolean; video: boolean; audio: boolean; duration: number | null; audioDuration: number | null; decoder?: string; aspect: number; alpha: boolean; timing: { avg_frame_rate: string | null; r_frame_rate: string | null; time_base: string | null; streamDurationSource: string; outputRate: number; sampling: string } }> = {}
  let decoders: string | undefined
  const clips = model.nodes.filter(n => n.kind === 'Clip' && n.enabled && n.end > n.start)
  if (clips.length > 256) throw new Error('At most 256 active clips supported')
  for (const n of clips) {
    if (!n.targetUrl || !n.sourceStart || !['Video', 'Audio'].includes(n.trackKind ?? '')) throw new Error(`Unsupported media/placement at ${n.id}; use ExternalReference on Video/Audio tracks. Three shots must be pre-rendered to a local MP4/image.`)
    const local = localMediaPath(n.targetUrl, path.dirname(path.resolve(file)))
    const format = formats[path.extname(local).toLowerCase()]
    if (!format) throw new Error(`Unsupported media extension: ${local}`)
    if (!(await stat(local)).isFile()) throw new Error(`Not a regular media file: ${local}`)
    const image = images.has(format)
    const probe = JSON.parse(await run(options.ffprobe ?? 'ffprobe', ['-v', 'error', ...inputArgs(local, format), ...(image ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json'], options.signal, 60000))
    const streams = probe.streams as MediaStream[]
    if (image && (streams.length !== 1 || Number(streams[0]?.nb_read_frames) !== 1)) throw new Error(`Only single-frame images are supported: ${local}`)
    const visual = streams.find(s => s.codec_type === 'video')
    const sound = streams.find(s => s.codec_type === 'audio')
    const selected = n.trackKind === 'Video' ? visual : sound
    if (!selected || (n.trackKind === 'Audio' && image)) throw new Error(`Missing ${n.trackKind} stream: ${n.id}`)
    const decoder = alphaDecoder(visual)
    if (decoder) {
      decoders ??= await run(options.ffmpeg ?? 'ffmpeg', ['-hide_banner', '-decoders'], options.signal, 60000)
      if (!decoders.split('\n').some(line => line.trim().split(/\s+/)[1] === decoder)) throw new Error(`Alpha-preserving decoder ${decoder} is required; refusing potentially opaque VP8/VP9 decode`)
    }
    const square = !visual?.sample_aspect_ratio || ['1:1', 'N/A', '0:1'].includes(visual.sample_aspect_ratio)
    const alpha = !!decoder || !/^(?:yuv(?:j)?(?:420|422|444|440|411|410)p(?:\d+(?:le|be))?|rgb24|bgr24|gray(?:\d+(?:le|be))?|gbrp(?:\d+(?:le|be))?|nv12|nv21)$/.test(visual?.pix_fmt ?? '') || visual?.tags?.alpha_mode === '1' || !square || !!visual?.side_data_list?.some(s => s.rotation)
    const timing = { avg_frame_rate: selected.avg_frame_rate ?? null, r_frame_rate: selected.r_frame_rate ?? null, time_base: selected.time_base ?? null, streamDurationSource: streamDurationEvidence(selected).source, outputRate: model.rate, sampling: image ? 'still-image' : n.trackKind === 'Video' ? 'source timestamps sampled to constant output rate; complete VFR support and color fidelity are not guaranteed' : 'audio resampled to 48000 Hz' }
    const asset = { timing, aspect: (visual?.width ?? 0)/(visual?.height ?? 1), alpha, file: local, format, image, video: streams.some(s => s.codec_type === 'video'), audio: streams.some(s => s.codec_type === 'audio'), duration: streamDuration(selected), audioDuration: sound ? streamDuration(sound) : null, decoder }
    const placement = placements.get(n.id)!
    const source = sourceOffset(n) + placement.start - n.start
    if (source < -1e-8 || (!image && (asset.duration === null || source + placement.end - placement.start > asset.duration + 0.001))) throw new Error(`Source range outside media duration (selected stream unknown or too short): ${n.id}`)
    if (n.trackKind === 'Video' ? !asset.video : !asset.audio || image) throw new Error(`Missing ${n.trackKind} stream: ${n.id}`)
    assets[n.id] = asset
  }
  for (const t of Object.values(profile.transitions)) {
    const a = assets[t.from]!, b = assets[t.to]!
    if (a.alpha || b.alpha) throw new Error(`Unsupported transition endpoint at ${a.alpha ? t.from : t.to}: alpha-capable/unknown pixel format or non-square/rotated pixels; only proven opaque endpoints supported`)
    if (Math.abs(a.aspect-b.aspect) > 1e-8) throw new Error(`Unsupported transition endpoints at ${t.from} and ${t.to}: matching aspect ratio required`)
  }
  // Check all layers, not just the highest visible clip.
  if (model.nodes.filter(n => n.kind === 'Clip' && n.trackKind === 'Video' && n.enabled).some(n => { const s = placements.get(n.id)!; return [s.start, s.end].some(t => Math.abs(t * model.rate - Math.round(t * model.rate)) >= 1e-6) })) throw new Error('Video cuts/handles must align to timeline frames')
  const pictures = otioPictureSpans(model)
  if (pictures.some(s => [s.start, s.end].some(t => Math.abs(t * model.rate - Math.round(t * model.rate)) >= 1e-6))) throw new Error('Video cuts must align to timeline frames; no implicit retiming')
  const explicitAudio = model.nodes.some(n => n.kind === 'Track' && n.trackKind === 'Audio' && n.enabled)
  const audio = explicitAudio ? clips.filter(n => n.trackKind === 'Audio').map(node => ({ node, start: node.start, end: node.end })) : pictures.filter(s => s.node && assets[s.node.id]?.audio).map(s => ({ ...s, node: s.node! }))
  for (const span of audio) {
    const a = assets[span.node.id]!, source = sourceOffset(span.node) + span.start - span.node.start
    if (a.audioDuration === null || source + span.end - span.start > a.audioDuration + 0.001) throw new Error(`Source range outside media duration (selected audio stream unknown or too short): ${span.node.id}`)
  }
  const warnings: string[] = []
  if (explicitAudio && audio.length === 0 && pictures.some(s => s.node && assets[s.node.id]?.audio)) warnings.push('AUDIO_EMPTY_EXPLICIT_SUPPRESSES_EMBEDDED: Enabled empty Audio tracks suppress visible video embedded audio.')
  if (!explicitAudio && audio.length > 0 && (pictures.length > 1 || Object.keys(profile.transitions).length > 0)) warnings.push('AUDIO_EMBEDDED_VISIBLE_HARD_CUT: Embedded audio follows the highest visible picture with hard cuts; visual transitions do not automatically crossfade audio.')
  if (explicitAudio && audio.some((a, i) => audio.slice(i + 1).some(b => Math.max(a.start, b.start) < Math.min(a.end, b.end)))) warnings.push('AUDIO_ADDITIVE_UNNORMALIZED_CLIPPING: Overlapping explicit audio is mixed additively without normalization and may clip.')
  return { warnings, timelineFrames, profile, placements, revision: revisionOf(text), duration: model.duration, rate: model.rate, model, assets, pictures, audio, audioPolicy: explicitAudio ? 'explicit-audio-tracks' : 'visible-video-embedded' }
}
export async function render(file: string, output: string, options: RenderOptions) {
  assertLocalPath(output)
  try { await lstat(output); throw new Error(`EEXIST: output already exists: ${output}`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const p = await plan(file, options)
  if (options.revision !== p.revision) throw new Error(`Revision mismatch; run plan again. Current revision: ${p.revision}`)
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Output must use .mp4')
  const start = options.start ?? 0, end = options.end ?? p.duration
  if (![start, end].every(Number.isFinite) || start < 0 || end > p.duration || end <= start) throw new Error('Invalid render interval')
  const width = options.width ?? 1280, height = options.height ?? 720
  if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 3840 && n % 2 === 0)) throw new Error('Dimensions must be even integers in 16..3840')
  const aligned = (n: number) => Math.abs(n * p.rate - Math.round(n * p.rate)) < 1e-6
  if (![start, end, ...p.pictures.flatMap(s => [s.start, s.end])].every(aligned)) throw new Error('Video cuts and render boundaries must align to timeline frames; no implicit retiming')
  const directory = await mkdtemp(path.join(path.dirname(path.resolve(output)), '.shadow-video-'))
  const temp = path.join(directory, 'render.mp4')
  try {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n'], filters: string[] = [], audio: string[] = []
    let index = 0
    const input = (n: OtioNode, at: number, duration: number) => {
      const a = p.assets[n.id]!, i = index++
      if (a.image) args.push('-loop', '1', '-framerate', String(p.rate))
      if (!a.image) args.push('-ss', String(Math.max(0, sourceOffset(n) + at - n.start)))
      args.push('-t', String(duration), ...inputArgs(a.file, a.format, a.decoder))
      return i
    }
    // Compile from timeline zero, then trim the finished composition. This keeps
    // effect clocks and transition samples identical for interval previews.
    const duration = end
    const byId = new Map(p.model.nodes.map(n => [n.id, n]))
    const tracks = p.model.nodes.filter(n => n.kind === 'Track' && n.trackKind === 'Video' && n.enabled)
    filters.push(`color=c=black:s=${width}x${height}:r=${p.rate}:d=${duration},format=rgba[base]`)
    let composed = 'base', serial = 0
    for (const track of tracks) {
      const members = p.model.nodes.filter(n => n.kind === 'Clip' && n.enabled && n.trackKind === 'Video' && n.end > n.start && (() => { let current: OtioNode | undefined = n; while (current && current.parentId !== track.id) current = current.parentId === null ? undefined : byId.get(current.parentId); return !!current })())
      filters.push(`color=c=black@0:s=${width}x${height}:r=${p.rate}:d=${duration},format=rgba[track${serial}]`)
      let layer = `track${serial++}`
      for (const n of members) {
        const placement = p.placements.get(n.id)!, a = placement.start, b = Math.min(end, placement.end)
        if (b <= a) continue
        const i = input(n, a, b-a), label = `clip${serial++}`
        const fx: string[] = []
        let x = 0, y = 0, scale = 1
        for (const e of p.profile.effects[n.id] ?? []) {
          if (e.profile === 'crop') fx.push(`crop=iw*${1-e.left-e.right}:ih*${1-e.top-e.bottom}:iw*${e.left}:ih*${e.top}`)
          if (e.profile === 'color') fx.push(`eq=brightness=${e.brightness}:contrast=${e.contrast}:saturation=${e.saturation}`)
          if (e.profile === 'opacity') fx.push(`colorchannelmixer=aa=${e.value}`)
          if (e.profile === 'transform') { x += e.x; y += e.y; scale *= e.scale }
        }
        const incoming = Object.entries(p.profile.transitions).find(([,t]) => t.to === n.id)
        if (incoming) {
          const t = incoming[1]
          if (t.profile === 'dissolve') fx.push(`fade=t=in:st=0:d=${t.inOffset+t.outOffset}:alpha=1`)
          else fx.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*lt(X/W,T/${t.inOffset+t.outOffset})'`)
        }
        // RGBA throughout: pixels outside fitted clips reveal lower layers.
        filters.push(`[${i}:v:0]setpts=PTS-STARTPTS,fps=${p.rate},format=rgba,${fx.length ? fx.join(',')+',' : ''}scale=${Math.max(2,Math.round(width*scale/2)*2)}:${Math.max(2,Math.round(height*scale/2)*2)}:force_original_aspect_ratio=decrease,setsar=1,trim=duration=${b-a},setpts=PTS+${a}/TB[${label}]`)
        const next = `layer${serial++}`
        filters.push(`[${layer}][${label}]overlay=x=(W-w)/2+${x*width}:y=(H-h)/2+${y*height}:eof_action=pass:repeatlast=0:format=auto:enable='gte(t,${a})*lt(t,${b})'[${next}]`)
        layer = next
      }
      const next = `stack${serial++}`
      filters.push(`[${composed}][${layer}]overlay=eof_action=pass:repeatlast=0:format=auto[${next}]`)
      composed = next
    }
    filters.push(`[${composed}]trim=start_frame=${Math.round(start*p.rate)}:end_frame=${Math.round(end*p.rate)},setpts=PTS-STARTPTS,format=yuv420p[vout]`)
    for (const s of p.audio) {
      const a = s.start, b = Math.min(end, s.end)
      if (b <= a) continue
      const i = input(s.node, a, b - a), label = `a${audio.length}`
      const fx: string[] = []
      for (const e of p.profile.effects[s.node.id] ?? []) {
        if (e.profile === 'volume') fx.push(`volume=${e.value}`)
        if (e.profile === 'audioFade') {
          if (e.in) fx.push(`afade=t=in:st=0:d=${e.in}`)
          if (e.out) fx.push(`afade=t=out:st=${s.node.end-s.node.start-e.out}:d=${e.out}`)
        }
      }
      filters.push(`[${i}:a:0]atrim=duration=${b-a},asetpts=PTS-STARTPTS,${fx.length ? fx.join(',')+',' : ''}aresample=48000,adelay=${Math.round(a*48000)}S:all=1[${label}]`)
      audio.push(`[${label}]`)
    }
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${end}[silence]`)
    filters.push(`[silence]${audio.join('')}amix=inputs=${audio.length+1}:normalize=0:duration=first:dropout_transition=0,atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[aout]`)
    args.push('-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(end-start), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', temp)
    await run(options.ffmpeg ?? 'ffmpeg', args, options.signal)
    const probe = JSON.parse(await run(options.ffprobe ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', temp], options.signal))
    const frames = Number(probe.streams?.[0]?.nb_read_frames), expected = Math.round((end-start)*p.rate)
    if (frames !== expected) throw new Error(`Rendered frame count mismatch: ${frames} != ${expected}`)
    options.signal?.throwIfAborted()
    if (revisionOf(await readFile(file, 'utf8')) !== p.revision) throw new Error('OTIO changed during rendering; output discarded')
    await link(temp, path.resolve(output))
    return { output: path.resolve(output), revision: p.revision, start, end, width, height, rate: p.rate, frames, audioPolicy: p.audioPolicy }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
