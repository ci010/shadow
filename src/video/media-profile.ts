import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Pure preflight: must run before stat/open, including on non-Windows hosts. */
export function assertLocalPath(value: string) {
  if (!value || value.includes('\0')) throw new Error('Invalid local media path')
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') throw new Error('Only local media is supported; remote file host is forbidden')
    assertLocalPath(decodeURIComponent(url.pathname))
  }
  // UNC, Win32 device namespaces, NT object paths and slash-mixed equivalents.
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('//') || /^\/(?:\?\?|device)(?:\/|$)/i.test(normalized)) throw new Error('Only local media is supported; network/device paths are forbidden')
}
export function localMediaPath(value: string, directory: string, windows = process.platform === 'win32') {
  assertLocalPath(value)
  if (/^file:/i.test(value)) {
    const url = new URL(value)
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') throw new Error('Only local media is supported; remote file host is forbidden')
    assertLocalPath(decodeURIComponent(url.pathname))
    value = fileURLToPath(url, { windows })
    assertLocalPath(value)
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error('Only local media is supported')
  }
  return (windows ? path.win32 : path).resolve(directory, value)
}
export interface MediaStream {
  codec_type: string; codec_name?: string; duration?: string; duration_ts?: number | string; time_base?: string
  start_time?: string; start_pts?: number | string
  nb_read_frames?: string; width?: number; height?: number; pix_fmt?: string; sample_aspect_ratio?: string
  tags?: Record<string, string>; side_data_list?: { rotation?: number }[]
}
/** Container duration is deliberately never evidence for a selected stream. */
export function streamDuration(stream: MediaStream): number | null {
  const positive = (n: number) => Number.isFinite(n) && n > 0 ? n : null
  const duration = positive(Number(stream.duration))
  if (duration !== null) return duration
  const base = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? '')
  if (base) {
    const ticks = positive(Number(stream.duration_ts) * Number(base[1]) / Number(base[2]))
    if (ticks !== null) return ticks
  }
  const tag = Object.entries(stream.tags ?? {}).find(([k]) => k.toUpperCase() === 'DURATION')?.[1]
  const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(tag ?? '')
  // Matroska/WebM DURATION is an end timestamp (including a nonzero
  // stream start), not elapsed media length. Require a known start to use it.
  const start = stream.start_time !== undefined ? Number(stream.start_time)
    : base && stream.start_pts !== undefined ? Number(stream.start_pts) * Number(base[1]) / Number(base[2]) : NaN
  return clock && Number.isFinite(start) ? positive(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) - start) : null
}
export function alphaDecoder(stream: MediaStream | undefined) {
  // Native VP8/VP9 decoders discard WebM BlockAdditional alpha. Force libvpx
  // even when ffprobe reports yuv420p; AlphaMode is not always reported.
  return stream?.codec_name === 'vp9' ? 'libvpx-vp9' : stream?.codec_name === 'vp8' ? 'libvpx' : undefined
}
