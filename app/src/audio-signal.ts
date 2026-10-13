/** A conservative energy gate, NOT a speech detector. Near-digital silence only. */
export class AudioSignalMeter {
  samples = 0
  activeSamples = 0
  level = 0
  constructor(readonly sampleRate: number) {}
  push(data: Float32Array): number {
    if (!data.length) return this.level
    let sum = 0, square = 0
    for (const value of data) { const x = Number.isFinite(value) ? value : 0; sum += x; square += x * x }
    // Remove DC bias, so a stuck microphone isn't treated as speech.
    const rms = Math.sqrt(Math.max(0, square / data.length - (sum / data.length) ** 2))
    this.samples += data.length
    if (rms >= 0.00015) this.activeSamples += data.length
    const target = Math.min(1, Math.sqrt(rms / 0.08))
    this.level = target > this.level ? target : this.level * 0.75 + target * 0.25
    return this.level
  }
  get hasSignal(): boolean { return this.samples / this.sampleRate >= 0.12 && this.activeSamples / this.sampleRate >= 0.04 }
}

/** Windowed-sinc low-pass before rate conversion; unlike sample skipping or linear
 * interpolation this suppresses frequencies above the new Nyquist frequency. */
export function resampleMono(input: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) throw new Error('Invalid sample rate')
  if (fromRate === toRate) return input.slice()
  const output = new Float32Array(Math.floor(input.length * toRate / fromRate))
  const cutoff = Math.min(1, toRate / fromRate) * 0.9
  const radius = Math.ceil(24 / cutoff)
  for (let i = 0; i < output.length; i++) {
    const position = i * fromRate / toRate
    let value = 0, weight = 0
    for (let j = Math.max(0, Math.ceil(position - radius)); j <= Math.min(input.length - 1, Math.floor(position + radius)); j++) {
      const distance = j - position
      const sinc = distance === 0 ? cutoff : Math.sin(Math.PI * cutoff * distance) / (Math.PI * distance)
      const w = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius))
      value += input[j]! * w; weight += w
    }
    output[i] = weight ? value / weight : 0
  }
  return output
}

/** Stateful conversion keeps fractional phase and filter history across chunks. */
export class Pcm16StreamConverter {
  private buffer = new Float32Array(0)
  private base = 0
  private total = 0
  private outputIndex = 0
  private readonly cutoff: number
  private readonly radius: number
  constructor(readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Unsupported sample rate')
    this.cutoff = Math.min(1, 16000 / sampleRate) * 0.9
    this.radius = Math.ceil(24 / this.cutoff)
  }
  push(input: Float32Array, final = false): Uint8Array {
    const joined = new Float32Array(this.buffer.length + input.length)
    joined.set(this.buffer); joined.set(input, this.buffer.length); this.buffer = joined; this.total += input.length
    const end = final ? Math.floor(this.total * 16000 / this.sampleRate) : Math.max(0, Math.ceil((this.total - this.radius) * 16000 / this.sampleRate))
    const bytes = new Uint8Array(Math.max(0, end - this.outputIndex) * 2), view = new DataView(bytes.buffer)
    let offset = 0
    for (; this.outputIndex < end; this.outputIndex++) {
      const position = this.outputIndex * this.sampleRate / 16000
      let value = 0, weight = 0
      for (let j = Math.max(0, Math.ceil(position - this.radius)); j <= Math.min(this.total - 1, Math.floor(position + this.radius)); j++) {
        const d = j - position
        const sinc = d === 0 ? this.cutoff : Math.sin(Math.PI * this.cutoff * d) / (Math.PI * d)
        const w = sinc * (0.5 + 0.5 * Math.cos(Math.PI * d / this.radius))
        value += this.buffer[j - this.base]! * w; weight += w
      }
      const sample = Math.max(-1, Math.min(1, weight ? value / weight : 0))
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true); offset += 2
    }
    const retainFrom = Math.max(this.base, Math.floor(this.outputIndex * this.sampleRate / 16000) - this.radius)
    this.buffer = this.buffer.slice(retainFrom - this.base); this.base = retainFrom
    return bytes
  }
}
