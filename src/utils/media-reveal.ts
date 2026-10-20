import { createHmac, timingSafeEqual } from 'node:crypto'

/** An authorized attachment, attested by an Electron-owned backend, never a renderer path grant. */
export interface MediaRevealProof { path: string; expires: number; signature: string }
export function signMediaReveal(path: string, key: string, now = Date.now()): MediaRevealProof {
  const expires = now + 60_000
  return { path, expires, signature: createHmac('sha256', key).update(JSON.stringify([path, expires])).digest('hex') }
}
export function verifyMediaReveal(value: unknown, key: string, now = Date.now()): value is MediaRevealProof {
  if (!value || typeof value !== 'object') return false
  const p = value as MediaRevealProof
  if (typeof p.path !== 'string' || p.path.includes('\0') || p.path.length > 32768 || !Number.isSafeInteger(p.expires)
    || p.expires < now || p.expires > now + 60_000 || typeof p.signature !== 'string' || !/^[a-f0-9]{64}$/.test(p.signature)) return false
  const expected = createHmac('sha256', key).update(JSON.stringify([p.path, p.expires])).digest()
  return timingSafeEqual(expected, Buffer.from(p.signature, 'hex'))
}
