import { ProtectedKeyStoreError } from '../cluster/protected-device-key-stores.ts'

/** Only finite categories cross the desktop boundary. Never serialize caught errors. */
export function childPairingFailureCode(error: unknown): string {
  if (error instanceof ProtectedKeyStoreError) return 'key-store'
  if (!(error instanceof Error)) return 'unknown'
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout'
  if (/^Main pairing request failed with status (401|403|404|409|410|429)$/.test(error.message)) return 'offer-rejected'
  if (/^Main pairing request failed with status \d{3}$/.test(error.message) || error.message === 'Main pairing response is invalid') return 'main-response'
  if (error.message === 'fetch failed' || error.message === 'Failed to fetch') return 'network'
  const cause = error.cause as { code?: unknown } | undefined
  if (cause && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(String(cause.code))) return 'network'
  if (error instanceof TypeError) return 'configuration'
  if ('code' in error && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(String(error.code))) return 'storage'
  return 'unknown'
}
