import assert from 'node:assert/strict'
import test from 'node:test'
import { isLearningSourceEligible } from './source-eligibility.ts'
import { systemAutomationRef } from '../../cron/contracts.ts'
import type { SessionState } from '../../sessions/session-store.ts'

test('learning eligibility uses provenance and lineage, not agent names', () => {
  const states: Record<string, SessionState> = {}
  const add = (id: string, extra: Partial<SessionState> = {}) => states[id] = { sessionId: id, segmentIndex: 0, projectId: 'p', ...extra }
  const eligible = (id: string) => isLearningSourceEligible(states[id], id => states[id], id => id === 'managed', 'p')
  add('root', { agentType: 'reflector' }); add('child', { parentSessionId: 'root' })
  assert(eligible('root')); assert(eligible('child'))
  for (const agentType of ['work-observer', 'work-organizer'] as const) {
    add(agentType, { automation: systemAutomationRef(agentType, agentType) })
    add(`${agentType}-child`, { parentSessionId: agentType })
    assert(!eligible(agentType)); assert(!eligible(`${agentType}-child`))
    add(`user-${agentType}`, { agentType }); assert(eligible(`user-${agentType}`))
  }
  for (const agentType of ['reflector', 'encapsulator', 'soul-reflector']) {
    add(agentType, { automation: { jobId: `learning:${agentType}`, name: agentType, runId: agentType, startedAt: new Date(0).toISOString(), contextMode: 'fresh', config: { source: 'learning', schedule: 'manual', agentType } } })
    assert(!eligible(agentType))
  }
  add('cron', { automation: { jobId: 'user-job', name: 'User work', runId: 'run', startedAt: new Date(0).toISOString(), contextMode: 'fresh', config: { source: 'cron', schedule: 'manual' } } })
  assert(eligible('cron'))
  add('work-observer:work-observer-1700000000000', { agentType: 'work-observer' })
  assert(!eligible('work-observer:work-observer-1700000000000'))
  add('heartbeat:soul-reflector-1700000000000', { agentType: 'soul-reflector' })
  assert(!eligible('heartbeat:soul-reflector-1700000000000'))
  add('managed'); assert(!eligible('managed'))
  add('channel', { channelBoundary: {} as SessionState['channelBoundary'] }); assert(!eligible('channel'))
  add('missing-parent', { parentSessionId: 'missing' }); assert(!eligible('missing-parent'))
  add('cycle', { parentSessionId: 'cycle' }); assert(!eligible('cycle'))
  add('other', { projectId: 'other' }); assert(!eligible('other'))
})
