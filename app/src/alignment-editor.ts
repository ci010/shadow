import { timelineDemoWav } from './alignment-timeline.ts'
const pcm = timelineDemoWav(), view = new DataView(pcm.buffer)
export const editorDemoSamples = Float32Array.from({ length: 192000 }, (_, i) => view.getInt16(44 + i * 2, true) / 32768)
/** Source PCM peak envelope; caller sets the physical width using source seconds * px/sec. */
export function editorWavePath(width: number, samples: Float32Array = editorDemoSamples): string {
  if (!Number.isFinite(width) || width <= 0) return ''
  let path = ''
  for (let x = 0; x < width; x += 2) {
    const begin = Math.floor(x / width * samples.length), end = Math.min(samples.length, Math.ceil((x + 2) / width * samples.length))
    let peak = 0
    for (let i = begin; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]!))
    const height = peak * 125
    path += `M${x},${30 - height}v${height * 2} `
  }
  return path
}
export function editorWaveThumbnail(samples: Float32Array): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60"><rect width="160" height="60" fill="#20342d"/><path d="${editorWavePath(160, samples)}" fill="none" stroke="#94c7a6"/></svg>`)}`
}
