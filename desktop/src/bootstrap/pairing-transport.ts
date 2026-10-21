/** Deliberately conservative desktop HTTP exception: literal LAN/VPN addresses only.
 * DNS endpoints require HTTPS (except localhost), avoiding public plaintext opt-in.
 */
export function childTransportError(endpoint: string, consent: boolean) {
  let url: URL
  try { url = new URL(endpoint) } catch { return 'Enter a valid Main HTTP(S) endpoint.' }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return 'Use an HTTP(S) endpoint without credentials, query or fragment.'
  if (url.protocol === 'https:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const octets = host.split('.').map(Number)
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every(v => v >= 0 && v <= 255)
  const local = host === 'localhost' || host === '::1'
    || ipv4 && (octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168
      || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
    || /^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  if (!local) return 'Public or DNS HTTP endpoints are not allowed. Use HTTPS, or a private LAN/VPN IP address.'
  if (!consent) return 'HTTP sends the PIN and traffic without encryption. Explicitly allow trusted LAN/VPN HTTP before pairing.'
  return null
}
