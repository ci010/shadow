import { ToolNoEffectError } from '../../tools/tool.ts'

/** One import budget, passed explicitly to the pinned SDK in every route.
 * Heartbeats attest only helper liveness. Silence is lost observation, not an
 * import deadline or evidence that native work stopped.
 */
export const IMPORT_TIMEOUT = Object.freeze({
  defaultMs: 300_000,
  minMs: 1_000,
  maxMs: 1_800_000,
  heartbeatMs: 1_000,
  silenceMs: 90_000,
})

export function importTimeoutMs(value: unknown = IMPORT_TIMEOUT.defaultMs): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < IMPORT_TIMEOUT.minMs || value > IMPORT_TIMEOUT.maxMs) {
    throw new ToolNoEffectError(`Import timeout must be ${IMPORT_TIMEOUT.minMs}–${IMPORT_TIMEOUT.maxMs} ms.`)
  }
  return value
}
