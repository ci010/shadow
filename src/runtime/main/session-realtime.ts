import type { Bus } from '../../bus/bus.ts'
import type { RealtimePublisher } from '../../realtime/hub.ts'

/** Keep cross-session structural facts global. Scoped legacy events may now
 * probe only their owning row, so handoff must not discard its target. */
export function observeSessionInvalidations(bus: Bus, realtime: Pick<RealtimePublisher, 'invalidateSessions'>): () => void {
  const subscriptions: string[] = []
  for (const topic of ['session.input.accepted', 'session.message.appended', 'session.handoff', 'session.ended', 'session.renamed', 'session.changed', 'background.task.changed'] as const) {
    subscriptions.push(bus.on(topic, fact => realtime.invalidateSessions(topic === 'session.handoff' ? undefined : fact.sessionId, undefined,
      topic === 'background.task.changed' ? ['background-tasks'] :
        topic === 'session.input.accepted' ? ['history', 'activity'] :
        topic === 'session.message.appended' ? ['history'] :
        topic === 'session.renamed' ? ['metadata'] :
        topic === 'session.changed' ? ('metadataOnly' in fact && fact.metadataOnly
          ? ['metadata'] : ['metadata', 'activity', 'work', 'background-tasks', 'scheduled-tasks']) : undefined)))
  }
  subscriptions.push(bus.on('session.turn.finished', fact =>
    realtime.invalidateSessions(fact.sessionId, fact.status === 'completed' ? fact.turnId : undefined, ['history', 'work', 'activity'])))
  return () => { for (const subscription of subscriptions) bus.off(subscription) }
}
