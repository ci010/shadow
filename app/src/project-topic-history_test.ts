import test from 'node:test'
import assert from 'node:assert/strict'
import { projectFocusGroups, projectTopics } from './project-topic-history.ts'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'

test('topic history retains ended work, follows explicit links, and does not infer topics from session lineage', () => {
  const item = { key: 'root', title: 'Release', revision: 1, sequence: 1, status: 'done', parentKey: null,
    dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false,
    proposals: 0, interpretationReview: false, changedAt: '2026-10-10', notes: { kind: 'goal', summary: 'Report delivered' } }
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'child', parentKey: 'root', status: 'blocked' }],
    sessions: [{ sessionId: 'linked', title: 'Worker', assignable: false, workKey: 'child', activity: 'completed' },
      { sessionId: 'unlinked', title: 'Another discussion', assignable: true, parentSessionId: 'linked', lastActivityAt: '2026-10-11' }], requests: [], effects: [] })
  const topics = projectTopics(data)
  assert.equal(topics.length, 2)
  assert.equal(topics[0].fallback, true)
  assert.equal(topics[1].root?.status, 'done')
  assert.equal(topics[1].root?.notes?.summary, 'Report delivered')
  assert.deepEqual(topics[1].items.map(item => item.key), ['root', 'child'])
  assert.deepEqual(topics[1].sessions.map(session => session.sessionId), ['linked'])
})

test('focus categories are display hypotheses, preserve separate topics and leave legacy topics unclassified', () => {
  const item = { key: 'a', title: 'Release evidence', revision: 1, sequence: 1, status: 'done', parentKey: null,
    dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false,
    proposals: 0, interpretationReview: false, changedAt: '2026-10-11', observation: {
      sessionId: 'a', observedAt: '2026-10-11T00:00:00Z', sources: [{ id: 'request', physicalId: 'segment' }],
      focus: { category: 'Release confidence', purpose: 'Understand impact', motivation: 'May want confidence', evidence: [{ id: 'request', physicalId: 'segment' }] },
    } }
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'b' }, { ...item, key: 'legacy', observation: undefined }], sessions: [], requests: [], effects: [] })
  const topics = projectTopics(data)
  const groups = projectFocusGroups(topics)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].topics.length, 2)
  assert.equal(groups[1].inferred, false)
  assert.equal(topics.length, 3, 'No inferred category merges work or topic boundaries')
  const snapshot = { inferredAt: '2026-10-11T00:00:00Z', origin: 'model_interpretation' as const, inputCount: 2, omittedCount: 1,
    sources: [{ key: 'a', sequence: 1 }, { key: 'b', sequence: 1 }], result: { groups: [
      { category: 'A different purpose', purpose: 'User-triggered model organization', motivation: 'Tentative concern', topicKeys: ['a', 'b'] },
    ] } }
  assert.equal(projectFocusGroups(topics, snapshot)[0].title, 'A different purpose')
  data.items[0].sequence++
  assert.equal(projectFocusGroups(projectTopics(data), snapshot)[0].stale, true)
  assert.equal(projectFocusGroups(projectTopics(data), snapshot)[1].topics[0].key, 'legacy')
})
