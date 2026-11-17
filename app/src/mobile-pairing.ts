import { validateMainOrigin } from './mobile-client.ts'
import { t } from './i18n.ts'

export interface PhonePairing { url: string; code: string; expiresAt?: string }
const invalid = () => new Error(t('Paste the complete phone pairing details copied on Main, including the address and one-use code.'))

// Both the versioned payload and Main's original three-line clipboard format.
// Transport permission always comes from the phone's separate consent control.
export function parsePhonePairing(value: string, allowLanHttp = false): PhonePairing {
  const parts = value.trim().split(/\s+/)
  if (parts[0] === 'Shadow-Phone/1') parts.shift()
  else if (parts[0]?.startsWith('Shadow-Phone/')) throw invalid()
  if (parts.length < 2 || parts.length > 3) throw invalid()
  const [address, code, expiresAt] = parts
  const url = validateMainOrigin(address!, allowLanHttp)
  if (!/^(?:[a-f\d]+-)*[a-f\d]+$/i.test(code!) || code!.replaceAll('-', '').length !== 24) throw invalid()
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw invalid()
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new Error(t('This code is invalid, expired, or already used. Generate a new code on Main.'))
  }
  return { url, code: code!, ...(expiresAt ? { expiresAt } : {}) }
}

export function formatPhonePairing(value: PhonePairing): string {
  // Formatting does not grant consent. HTTP still requires explicit phone opt-in.
  const url = validateMainOrigin(value.url, true)
  const text = `Shadow-Phone/1\n${url}\n${value.code}\n${value.expiresAt ?? ''}`.trim()
  parsePhonePairing(text, true)
  return text
}
