// Decode only bounded, uncompressed WAV. A playback decoder's input byte limit
// alone does not bound its decoded allocation (or require starting an AudioContext).
export const MAX_WAVE_BYTES = 8 * 1024 * 1024
export const WAVE_HEIGHT = 24
const STRIDE = 128

export async function readOtioWave(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    credentials: 'same-origin', referrerPolicy: 'no-referrer', redirect: 'error' })
  const reader = response.body?.getReader()
  if (!reader) return null
  try {
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_WAVE_BYTES) return null
    const parts: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_WAVE_BYTES) return null
      parts.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    signal.throwIfAborted()
    return decodeOtioWave(bytes)
  } finally { void reader.cancel().catch(() => {}) }
}

export function decodeOtioWave(bytes: Uint8Array) {
  if (bytes.length < 12 || bytes.length > MAX_WAVE_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (i: number) => view.getUint16(i, true)
  const u32 = (i: number) => view.getUint32(i, true)
  const tag = (i: number, n: number) => u32(i) === n
  const end = 8 + u32(4)
  if (!tag(0, 0x46464952) /* RIFF */ || !tag(8, 0x45564157) /* WAVE */ || end < 12 || end > bytes.length) return null
  let fmt = -1, fmtSize = 0, data = -1, length = 0
  for (let i = 12; i + 8 <= end;) {
    const size = u32(i + 4), content = i + 8
    if (content + size > end) return null
    if (fmt < 0 && size >= 16 && tag(i, 0x20746d66) /* fmt */) { fmt = content; fmtSize = size }
    if (data < 0 && tag(i, 0x61746164) /* data */) { data = content; length = size }
    if (fmt >= 0 && data >= 0) break
    i = content + size + size % 2
  }
  if (fmt < 0 || data < 0) return null
  let format = u16(fmt)
  const channels = u16(fmt + 2), rate = u32(fmt + 4), bits = u16(fmt + 14)
  // WAVE_FORMAT_EXTENSIBLE stores the PCM or float subtype in a GUID.
  if (format === 0xfffe && fmtSize >= 40 && u16(fmt + 16) >= 22
    && u32(fmt + 28) === 0x00100000 && u32(fmt + 32) === 0xaa000080 && u32(fmt + 36) === 0x719b3800) {
    format = u32(fmt + 24)
  }
  if (!(format === 1 && [8, 16, 24, 32].includes(bits) || format === 3 && bits === 32)
    || channels < 1 || channels > 32 || rate < 1 || rate > 384_000) return null
  const sampleBytes = bits / 8, stride = sampleBytes * channels
  if (u16(fmt + 12) !== stride || length % stride || !length) return null
  const frames = length / stride
  function peakAt(frame: number) {
    let peak = 0
    for (let i = data + frame * stride, stop = i + stride; i < stop; i += sampleBytes) {
      const sample = format === 3 ? view.getFloat32(i, true) : bits === 8 ? (bytes[i] - 128) / 128
        : bits === 16 ? view.getInt16(i, true) / 32768
        : bits === 24 ? ((bytes[i] << 8) | (bytes[i + 1] << 16) | (bytes[i + 2] << 24)) / 2147483648
        : view.getInt32(i, true) / 2147483648
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample))
    }
    return Math.min(1, peak)
  }
  // A segment tree makes repeated trims independent of the media length.
  const blocks = 2 ** Math.ceil(Math.log2(Math.ceil(frames / STRIDE)))
  const index = new Float32Array(2 * blocks)
  for (let frame = 0; frame < frames; frame++) {
    const i = blocks + Math.floor(frame / STRIDE)
    index[i] = Math.max(index[i], peakAt(frame))
  }
  for (let i = blocks - 1; i > 0; i--) index[i] = Math.max(index[i * 2], index[i * 2 + 1])
  function blockPeak(first: number, last: number) {
    let peak = 0
    for (first += blocks, last += blocks; first < last; first >>= 1, last >>= 1) {
      if (first % 2) peak = Math.max(peak, index[first++])
      if (last % 2) peak = Math.max(peak, index[--last])
    }
    return peak
  }
  return {
    peaks(start: number, duration: number, bins: number) {
      // Each bin covers a half-open source interval, including silence outside
      // the media. Scan partial blocks exactly so a trim can't leak an adjacent hit.
      const frameAt = (i: number) => Math.max(0, Math.min(frames, Math.ceil((start + duration * i / bins) * rate)))
      return Array.from({ length: bins }, (_, i) => {
        let first = frameAt(i), last = frameAt(i + 1), peak = 0
        while (first < last && first % STRIDE) peak = Math.max(peak, peakAt(first++))
        const fullEnd = last - last % STRIDE
        if (first < fullEnd) {
          peak = Math.max(peak, blockPeak(first / STRIDE, fullEnd / STRIDE))
          first = fullEnd
        }
        while (first < last) peak = Math.max(peak, peakAt(first++))
        return peak
      })
    },
  }
}

export function otioWavePath(peaks: readonly number[]) {
  const half = WAVE_HEIGHT / 2
  return peaks.map((peak, i) => {
    if (!peak) return ''
    const span = (peak * half).toFixed(2)
    return `M${i + 0.5} ${(half - Number(span)).toFixed(2)}v${(2 * Number(span)).toFixed(2)}`
  }).join('')
}
