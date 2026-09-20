import type { AgentCredentialStore } from './credentials.ts'
import { redact } from './capabilities.ts'

export class AuthoringEvidenceError extends Error {}

/** Evidence is data, never a new authority source. Also scrub cross-grant echoes. */
export function redactAuthoringEvidence(value: unknown, credentials: Pick<AgentCredentialStore, 'names' | 'resolve'>): unknown {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > 1024 * 1024) {
    throw new AuthoringEvidenceError('Authoring evidence must be JSON of at most 1 MiB. Reduce the test result or scenario size.')
  }
  let safe: unknown = JSON.parse(text)
  for (const name of credentials.names()) safe = redact(safe, credentials.resolve(name))
  return safe
}
