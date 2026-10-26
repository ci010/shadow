/** Numeric private/loopback literals only: never resolve names or trust DNS rebinding. */
export function isLanHttpHost(host: string): boolean {
  if (host === '[::1]') return true
  if (/^\[(?:f[cd][0-9a-f]{2}:)/i.test(host)) return true
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}
