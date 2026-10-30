import type { Bus } from '../bus/bus.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { resolveAutomationSession } from './contracts.ts'

/** Project-local lifecycle adapter. Retain identities so deleting an archived run
 * also invalidates the historical automation row after its state disappears. */
export function watchAutomationSessions(bus: Bus, options: {
  projectId: string
  initial: SessionState[]
  state: (id: string) => SessionState | null | undefined
  changed: () => void
}) {
  const known = new Set<string>()
  const owns = (state: SessionState) => (!state.projectId || state.projectId === options.projectId)
    && !!resolveAutomationSession(state)
  for (const state of options.initial) if (owns(state)) known.add(state.sessionId)
  const subscriptions = (['session.changed', 'session.ended', 'session.renamed', 'session.handoff',
    'session.turn.started', 'session.turn.finished'] as const).map(topic => bus.on(topic, fact => {
    const state = options.state(fact.sessionId)
    const wasKnown = known.has(fact.sessionId)
    if (state && owns(state)) known.add(fact.sessionId)
    else known.delete(fact.sessionId)
    if (wasKnown || known.has(fact.sessionId)) options.changed()
  }))
  subscriptions.push(bus.on('session.deleted', fact => {
    known.delete(fact.sessionId)
    if (fact.automationJobId && (!fact.projectId || fact.projectId === options.projectId)) options.changed()
  }))
  return () => { for (const subscription of subscriptions) bus.off(subscription); known.clear() }
}
