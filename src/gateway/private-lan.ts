import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'

/** Numeric RFC1918 IPv4 only: no DNS, wildcard, public or link-local binds. */
export function isPrivateLanAddress(value: string): boolean {
  if (isIP(value) !== 4) return false
  const [a, b] = value.split('.').map(Number)
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}

export function privateLanAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => !entry.internal && isPrivateLanAddress(entry.address)).map(entry => entry.address)))].sort()
}
