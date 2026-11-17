import type { SessionInput } from '../sessions/input.ts'

// Host-only provenance, deliberately not serializable. A stored receipt is not
// permission to execute: ordinary live BOT admission must still succeed.
const recordedInputs = new WeakSet<SessionInput>()
export function markRecordedChannelInput(input: SessionInput): void { recordedInputs.add(input) }
export function isRecordedChannelInput(input: SessionInput): boolean { return recordedInputs.has(input) }

/** Migration visibility only; raw evidence/coordinates stay intact. */
export function isDisplayDuplicate(record: Record<string, unknown>): boolean { return typeof record.channel_history_duplicate_of === 'string' }
