import { createHash } from 'node:crypto'
import { readFile, stat, lstat, mkdtemp, rm, link } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOtio, otioPictureSpans, type OtioNode, MAX_OTIO_BYTES } from '../shared/otio-model.ts'
import { run } from './process.ts'
export const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex')
export interface Options { ffmpeg?: string; ffprobe?: string; signal?: AbortSignal }
export interface RenderOptions extends Options { revision: string; start?: number; end?: number; width?: number; height?: number }
const formats: Record<string, string> = { '.mp4': 'mov', '.mov': 'mov', '.m4a': 'mov', '.mkv': 'matroska', '.webm': 'matroska', '.wav': 'wav', '.mp3': 'mp3', '.flac': 'flac', '.ogg': 'ogg', '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe', '.webp': 'webp_pipe' }
const images = new Set(['png_pipe', 'jpeg_pipe', 'webp_pipe'])
function mediaPath(url: string, directory: string) {
  if (/^file:/i.test(url)) return fileURLToPath(url)
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^[a-z]:[\\/]/i.test(url)) throw new Error(`Only local media is supported: ${url}`)
  if (!url || url.includes('\0')) throw new Error('Invalid local media path')
  return path.resolve(directory, url)
}
function inputArgs(file: string, format: string): string[] { return ['-protocol_whitelist', 'file,pipe', '-f', format, '-i', file] }
function sourceOffset(n: OtioNode) { return n.sourceStart!.value / n.sourceStart!.rate - (n.mediaStart ? n.mediaStart.value / n.mediaStart.rate : 0) }
export function initialTimeline(duration = 5, rate = 24) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !Number.isFinite(rate) || rate < 1 || rate > 120 || !Number.isSafeInteger(duration * rate)) throw new Error('init duration must be positive whole frames <= 24h, rate 1..120')
  const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
  return { OTIO_SCHEMA: 'Timeline.1', name: 'Agent video', global_start_time: time(0), tracks: { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Gap.1', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: time(0), duration: time(duration * rate) } }] }] } }
}
export async function plan(file: string, options: Options = {}) {
  options.signal?.throwIfAborted()
  if ((await stat(file)).size > MAX_OTIO_BYTES) throw new Error('OTIO file exceeds size limit')
  const text = await readFile(file, 'utf8'), model = parseOtio(text)
  if (model.warnings.length) throw new Error(`Unsupported OTIO features: ${model.warnings.join(', ')}`)
  if (!(model.duration > 0) || model.duration > 86400 || model.rate < 1 || model.rate > 120) throw new Error('Supported timeline: duration > 0 and <= 24h, rate 1..120')
  const inspect = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(inspect); return }
    const o = v as Record<string, unknown>
    if (Array.isArray(o.effects) && o.effects.length) throw new Error('Effects/time warps are unsupported')
    if (String(o.OTIO_SCHEMA).startsWith('Transition.')) throw new Error('Transitions are unsupported')
    for (const [k, value] of Object.entries(o)) if (k !== 'metadata') inspect(value)
  }
  inspect(JSON.parse(text))
  const assets: Record<string, { file: string; format: string; image: boolean; video: boolean; audio: boolean; duration: number | null }> = {}
  const clips = model.nodes.filter(n => n.kind === 'Clip' && n.enabled && n.end > n.start)
  if (clips.length > 256) throw new Error('At most 256 active clips supported')
  for (const n of clips) {
    if (!n.targetUrl || !n.sourceStart || !['Video', 'Audio'].includes(n.trackKind ?? '')) throw new Error(`Unsupported media/placement at ${n.id}; use ExternalReference on Video/Audio tracks. Three shots must be pre-rendered to a local MP4/image.`)
    const local = mediaPath(n.targetUrl, path.dirname(path.resolve(file)))
    const format = formats[path.extname(local).toLowerCase()]
    if (!format) throw new Error(`Unsupported media extension: ${local}`)
    if (!(await stat(local)).isFile()) throw new Error(`Not a regular media file: ${local}`)
    const image = images.has(format)
    const probe = JSON.parse(await run(options.ffprobe ?? 'ffprobe', ['-v', 'error', ...inputArgs(local, format), ...(image ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json'], options.signal, 60000))
    const streams = probe.streams as { codec_type: string; nb_read_frames?: string }[]
    if (image && (streams.length !== 1 || Number(streams[0]?.nb_read_frames) !== 1)) throw new Error(`Only single-frame images are supported: ${local}`)
    const duration = Number(probe.format?.duration)
    const asset = { file: local, format, image, video: streams.some(s => s.codec_type === 'video'), audio: streams.some(s => s.codec_type === 'audio'), duration: Number.isFinite(duration) ? duration : null }
    const source = sourceOffset(n)
    if (source < -1e-8 || (!image && (asset.duration === null || source + n.end - n.start > asset.duration + 0.001))) throw new Error(`Source range outside media duration: ${n.id}`)
    if (n.trackKind === 'Video' ? !asset.video : !asset.audio || image) throw new Error(`Missing ${n.trackKind} stream: ${n.id}`)
    assets[n.id] = asset
  }
  const pictures = otioPictureSpans(model)
  if (pictures.some(s => [s.start, s.end].some(t => Math.abs(t * model.rate - Math.round(t * model.rate)) >= 1e-6))) throw new Error('Video cuts must align to timeline frames; no implicit retiming')
  const explicitAudio = model.nodes.some(n => n.kind === 'Track' && n.trackKind === 'Audio' && n.enabled)
  const audio = explicitAudio ? clips.filter(n => n.trackKind === 'Audio').map(node => ({ node, start: node.start, end: node.end })) : pictures.filter(s => s.node && assets[s.node.id]?.audio).map(s => ({ ...s, node: s.node! }))
  return { revision: revisionOf(text), duration: model.duration, rate: model.rate, model, assets, pictures, audio, audioPolicy: explicitAudio ? 'explicit-audio-tracks' : 'visible-video-embedded' }
}
export async function render(file: string, output: string, options: RenderOptions) {
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
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n'], filters: string[] = [], video: string[] = [], audio: string[] = []
    let index = 0
    const input = (n: OtioNode, at: number, duration: number) => {
      const a = p.assets[n.id]!, i = index++
      if (a.image) args.push('-loop', '1', '-framerate', String(p.rate))
      if (!a.image) args.push('-ss', String(Math.max(0, sourceOffset(n) + at - n.start)))
      args.push('-t', String(duration), ...inputArgs(a.file, a.format))
      return i
    }
    for (const s of p.pictures) {
      const a = Math.max(start, s.start), b = Math.min(end, s.end)
      if (b <= a) continue
      const label = `v${video.length}`, duration = b - a
      if (s.node) {
        const i = input(s.node, a, duration)
        filters.push(`[${i}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${p.rate},trim=duration=${duration},format=yuv420p[${label}]`)
      } else filters.push(`color=c=black:s=${width}x${height}:r=${p.rate}:d=${duration},setsar=1[${label}]`)
      video.push(`[${label}]`)
    }
    filters.push(`${video.join('')}concat=n=${video.length}:v=1:a=0[vout]`)
    for (const s of p.audio) {
      const a = Math.max(start, s.start), b = Math.min(end, s.end)
      if (b <= a) continue
      const i = input(s.node, a, b - a), label = `a${audio.length}`
      filters.push(`[${i}:a:0]atrim=duration=${b-a},asetpts=PTS-STARTPTS,aresample=48000,adelay=${Math.round((a-start)*48000)}S:all=1[${label}]`)
      audio.push(`[${label}]`)
    }
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${end-start}[silence]`)
    filters.push(`[silence]${audio.join('')}amix=inputs=${audio.length+1}:normalize=0:duration=first:dropout_transition=0[aout]`)
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(end-start), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', temp)
    await run(options.ffmpeg ?? 'ffmpeg', args, options.signal)
    const probe = JSON.parse(await run(options.ffprobe ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', temp], options.signal))
    const frames = Number(probe.streams?.[0]?.nb_read_frames), expected = Math.round((end-start)*p.rate)
    if (frames !== expected) throw new Error(`Rendered frame count mismatch: ${frames} != ${expected}`)
    options.signal?.throwIfAborted()
    if (revisionOf(await readFile(file, 'utf8')) !== p.revision) throw new Error('OTIO changed during rendering; output discarded')
    await link(temp, path.resolve(output))
    return { output: path.resolve(output), revision: p.revision, start, end, width, height, frames, audioPolicy: p.audioPolicy }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
