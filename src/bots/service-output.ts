import type { OutboundMessage } from '../bus/events.ts'

// A live process lease, deliberately absent from serialized platform/user data.
const leases = new WeakMap<OutboundMessage, () => void>()
export function stampServiceOutput(message: OutboundMessage, assertCurrent: () => void): OutboundMessage {
  assertCurrent()
  const stamped = { ...message }
  leases.set(stamped, assertCurrent)
  return stamped
}
export function assertServiceOutput(message: OutboundMessage): void {
  const assertCurrent = leases.get(message)
  if (!assertCurrent) throw new Error('Current service output lease required')
  assertCurrent()
}
