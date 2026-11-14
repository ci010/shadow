import type { OutboundMessage } from '../bus/events.ts'

// Process-local execution lease: queued output never gains authority from replay
// or from a new activation that happens to have the same BOT source bytes.
const leases = new WeakMap<OutboundMessage, () => void>()
export function stampPersonalOutput(message: OutboundMessage, assertCurrent: () => void): OutboundMessage {
  assertCurrent()
  const stamped = { ...message }
  leases.set(stamped, assertCurrent)
  return stamped
}
export function assertPersonalOutput(message: OutboundMessage): void {
  const check = leases.get(message)
  if (!check) throw new Error('Current personal output lease required')
  check()
}
