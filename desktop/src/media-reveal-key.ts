import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
// Process-private: only runtimes launched by this Electron host can attest local files.
export const desktopMediaKey = randomBytes(32).toString('hex')

// Wire contract: src/utils/media-reveal.ts; do not accept unsigned renderer paths.
export interface MediaRevealProof { path: string; expires: number; signature: string }
export function verifyMediaReveal(value: unknown, key: string, now = Date.now()): value is MediaRevealProof {
  if (!value || typeof value !== 'object') return false
  const p = value as MediaRevealProof
  if (typeof p.path !== 'string' || p.path.includes('\0') || p.path.length > 32768 || !Number.isSafeInteger(p.expires)
    || p.expires < now || p.expires > now + 60_000 || typeof p.signature !== 'string' || !/^[a-f0-9]{64}$/.test(p.signature)) return false
  const expected = createHmac('sha256', key).update(JSON.stringify([p.path, p.expires])).digest()
  return timingSafeEqual(expected, Buffer.from(p.signature, 'hex'))
}
