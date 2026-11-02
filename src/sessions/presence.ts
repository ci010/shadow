import { z } from 'zod'

/** No input contents, wall-clock timestamps or caller-supplied user identities. */
export const presenceReportSchema = z.object({
  clientId: z.string().uuid(),
  visible: z.boolean(), focused: z.boolean(),
  interactionAgeMs: z.number().int().min(0).max(86_400_000).nullable(),
  system: z.object({ idleSeconds: z.number().int().min(0), locked: z.boolean().nullable() }).strict().nullable(),
}).strict()
export type PresenceReport = z.infer<typeof presenceReportSchema>
export type PresenceState = 'active' | 'away' | 'unknown'
export class UserPresence {
  private users = new Map<string, Map<string, { report: PresenceReport; received: number }>>()
  private truncated = new Set<string>()
  constructor(private now = Date.now, readonly freshnessMs = 45_000, readonly idleMs = 120_000) {}
  report(user: string, value: unknown): void {
    const report = presenceReportSchema.parse(value)
    let clients = this.users.get(user)
    if (!clients) this.users.set(user, clients = new Map())
    // Forgetting a client must never turn incomplete evidence into all-away.
    if (!clients.has(report.clientId) && clients.size >= 128) {
      clients.delete(clients.keys().next().value!)
      this.truncated.add(user)
    }
    clients.set(report.clientId, { report, received: this.now() })
  }
  state(user: string): PresenceState {
    const clients = this.users.get(user)
    if (!clients?.size) return 'unknown'
    let unknown = this.truncated.has(user)
    for (const { report: r, received } of clients.values()) {
      const age = this.now() - received
      if (age < 0 || age > this.freshnessMs) { unknown = true; continue }
      if (r.system?.locked === true) continue
      if (r.system && r.system.idleSeconds * 1000 + age < this.idleMs) return 'active'
      if (r.visible && r.focused && r.interactionAgeMs !== null && r.interactionAgeMs + age < this.idleMs) return 'active'
      // Hidden/unfocused Web is NOT proof that the human is away.
      if (!r.system || r.system.locked === null) unknown = true
    }
    return unknown ? 'unknown' : 'away'
  }
}

export interface UserWaitPolicy { timeoutMs: number | null; awayGraceMs: number }
export function resolveUserWaitPolicy(session: { timeoutMs: number | null } | undefined,
  global: { timeoutMs: number | null } | undefined,
  unattended: UserWaitPolicy = { timeoutMs: 600_000, awayGraceMs: 30_000 }): UserWaitPolicy {
  const configured = session ?? global
  return { ...unattended, timeoutMs: configured ? configured.timeoutMs : unattended.timeoutMs }
}
/** Polling lives exclusively on the backend. Activity never extends the fixed deadline. */
export function watchUserWait(policy: UserWaitPolicy, state: () => PresenceState, expired: () => void,
  now = Date.now): () => void {
  if (policy.timeoutMs === null) return () => {}
  const deadline = now() + policy.timeoutMs
  let awaySince: number | undefined
  const tick = () => {
    const time = now()
    if (state() === 'away') awaySince ??= time
    else awaySince = undefined
    if (time >= deadline || awaySince !== undefined && time - awaySince >= policy.awayGraceMs) {
      clearInterval(timer)
      expired()
    }
  }
  const timer = setInterval(tick, Math.min(1000, policy.timeoutMs, Math.max(1, policy.awayGraceMs)))
  tick()
  return () => clearInterval(timer)
}
