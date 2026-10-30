import { createHash } from 'node:crypto'
import type { SessionManager } from './session-manager.ts'
import { parseSessionActivityReadModel, type SessionActivityReadModel } from './activity-read-model.ts'

type ActivitySource = Pick<SessionManager, 'getActiveSession' | 'isWaitingForCall' | 'getSessionRecovery' | 'yields' | 'inputs'>

export function sessionActivityReadModel(sessions: ActivitySource, sessionId: string): SessionActivityReadModel {
  const active = sessions.getActiveSession(sessionId)
  const waitingForCall = !!sessions.isWaitingForCall?.(sessionId)
  const stage = waitingForCall || sessions.yields.get(sessionId) || sessions.inputs?.get(sessionId)
    ? 'waiting' : active?.rateLimitWait ? 'rate-limit' : active ? active.phase : 'inactive'
  const activeRequestId = active && active.phase !== 'idle' && 'activeRequestId' in active && typeof active.activeRequestId === 'string'
    ? active.activeRequestId : null
  const model = parseSessionActivityReadModel({ stage, waitingForCall, activeRequestId,
    recovery: sessions.getSessionRecovery?.(sessionId) ?? null })
  if (!model) throw new TypeError('Invalid session activity read model')
  return model
}

/** Fingerprint visible activity and pending question metadata. Questions can
 * change while the stage remains waiting, so they must still notify /ask views.
 * Tool progress/internal wakeups need not trigger identical snapshot reads. */
export function sessionActivityFingerprint(sessions: Pick<SessionManager,
  'getActiveSession' | 'isWaitingForCall' | 'getSessionRecovery' | 'yields' | 'inputs'>, sessionId: string): string {
  return createHash('sha256').update(JSON.stringify({ ...sessionActivityReadModel(sessions, sessionId),
    question: sessions.yields.get(sessionId), input: sessions.inputs?.get(sessionId) })).digest('hex')
}

/** Bounded, Project-local notification deduplication, never an authority/cache
 * for reads. Eviction only causes an extra notification, never a missed one. */
export function createActivityInvalidator(fingerprint: (sessionId: string) => string, notify: (sessionId: string) => void, limit = 2048) {
  const seen = new Map<string, string>()
  return {
    changed(sessionId: string) {
      let next: string
      try { next = fingerprint(sessionId) }
      catch { seen.delete(sessionId); notify(sessionId); return }
      if (seen.has(sessionId) && seen.get(sessionId) === next) return
      seen.delete(sessionId)
      seen.set(sessionId, next)
      while (seen.size > Math.max(0, limit)) seen.delete(seen.keys().next().value!)
      notify(sessionId)
    },
    dispose() { seen.clear() },
  }
}
