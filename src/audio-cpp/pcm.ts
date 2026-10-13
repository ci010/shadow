/** Composer ingress: uncompressed mono signed little-endian PCM at 16 kHz. */
export const PCM_RATE = 16000
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2
export function pcm16Wav(pcm: Buffer): Buffer {
  if (pcm.length % 2) throw new TypeError('PCM must contain complete s16le samples')
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
/** Digital-silence gate, NOT speech detection/VAD. Never treats quiet audio as silence. */
export function isDigitalSilence(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i += 2) if (pcm.readInt16LE(i) !== 0) return false
  return true
}
