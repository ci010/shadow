import type { AlignmentTarget } from './alignment-lab-model.ts'

export const TIMELINE_MAX_BYTES = 40 * 1024 * 1024
export const TIMELINE_MAX_DURATION = 20 * 60
export type TimelineTrack = 'audio' | 'video' | 'subtitle' | 'shot'

export function timelineRange(start: number, end: number, duration: number, trackId: TimelineTrack, id: string, label: string): AlignmentTarget {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || start >= end || end > duration || duration > TIMELINE_MAX_DURATION) throw new Error('Invalid timeline range')
  return { id, label, selector: { type: 'time-range', start, end, duration, trackId } }
}

/** Deterministic mono PCM WAV: three quiet tones separated by silence, generated locally. */
export function timelineDemoWav(): Uint8Array<ArrayBuffer> {
  const rate = 16000, seconds = 12, samples = rate * seconds
  const bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const time = i / rate, phase = time % 4
    const envelope = phase < 3 ? Math.min(1, phase * 10, (3 - phase) * 10) : 0
    view.setInt16(44 + i * 2, Math.round(Math.sin(time * Math.PI * 2 * (220 + Math.floor(time / 4) * 110)) * envelope * 6000), true)
  }
  return bytes
}
