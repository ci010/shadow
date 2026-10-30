import { parseSessionRecovery, type SessionRecovery } from './session-store.ts'

/** Complete per-session replacement, including explicit absence of optional state. */
export interface SessionActivityReadModel {
  stage: 'idle' | 'llm' | 'tool' | 'waiting' | 'rate-limit' | 'inactive'
  waitingForCall: boolean
  activeRequestId: string | null
  recovery: SessionRecovery | null
}

export function parseSessionActivityReadModel(value: unknown): SessionActivityReadModel | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (!['idle', 'llm', 'tool', 'waiting', 'rate-limit', 'inactive'].includes(v.stage as string)
    || typeof v.waitingForCall !== 'boolean' || (v.waitingForCall && v.stage !== 'waiting')
    || !(v.activeRequestId === null || typeof v.activeRequestId === 'string' && v.activeRequestId.length > 0)
    || !Object.hasOwn(v, 'recovery')) return
  try {
    const recovery = v.recovery === null ? null : parseSessionRecovery(v.recovery)
    if (recovery === undefined) return
    return { stage: v.stage as SessionActivityReadModel['stage'], waitingForCall: v.waitingForCall,
      activeRequestId: v.activeRequestId as string | null, recovery }
  } catch { return }
}
