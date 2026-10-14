import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceEvidence, voiceGroups } from '../../src/testing/voice-presentation.ts'
import { overviewGraph, overviewLayout } from './project-overview-graph.ts'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'
import { projectTopics, projectFocusGroups } from './project-topic-history.ts'

test('semantic voice cards replace execution hierarchy, preserve discussed option and render disclosure regions', () => {
  const item = { key: 'topic:web:chat-voice', title: 'Local ASR', revision: 1, sequence: 1, status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-11T00:00:00Z' }
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'delegate', title: 'Inspect ASR flags', parentKey: item.key, assignee: 'sub-worker' }], sessions: [{ sessionId: 'web:chat-voice', title: 'Voice', assignable: true }, { sessionId: 'sub-worker', title: 'ASR helper', assignable: false, parentSessionId: 'web:chat-voice' }], requests: [], effects: [], focus: { origin: 'model_interpretation', inferredAt: '2026-10-11T00:00:00Z', inputCount: 1, omittedCount: 0, sources: [{ key: item.key, sequence: 1 }], evidence: voiceEvidence, result: { groups: voiceGroups } } })
  const graph = overviewGraph(data)
  assert.equal(graph.nodes.length, 3)
  assert(!graph.nodes.some(node => node.title.includes('flags') || node.title.includes('helper')))
  assert.deepEqual(graph.nodes.map(node => node.status), ['mixed', 'abandoned', 'reported_complete'])
  assert.equal(overviewLayout(graph, new Set()).nodes.length, 1)
  const expanded = overviewLayout(graph, new Set(['presentation:0']))
  assert.equal(expanded.nodes.length, 3)
  assert.equal(expanded.regions.length, 1)
  assert(graph.nodes[2]!.evidence.includes('voice.1/record:0 (state)'))
  assert.match(graph.nodes[2]!.evidence, /Human conversation/)
  assert.match(graph.nodes[2]!.evidence, /Model statement \(not human approval\)/)
  assert.equal(graph.nodes[2]!.workKey, undefined, 'presentation cards do not edit execution work')
  const groups = projectFocusGroups(projectTopics(data), data.focus)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.stale, false)
  data.items[0]!.sequence++
  assert.equal(projectFocusGroups(projectTopics(data), data.focus)[0]!.stale, true)
  delete data.focus
  assert(!overviewGraph(data).nodes.some(node => node.id === 'delegate' || node.sessionId === 'sub-worker'))
})


test('saved abstract hierarchy is sole ownership truth; bounded leftovers stay behind one unorganized root', () => {
  const item = { key: 'topic:web:chat-voice', title: 'Voice', revision: 1, sequence: 1, status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-11T00:00:00Z' }
  const data = projectWorkOverviewSchema.parse({ items: [item, { ...item, key: 'older', title: 'Older unorganized topic', changedAt: '2026-09-01T00:00:00Z' }], sessions: [], requests: [], effects: [], focus: { origin: 'model_interpretation', inferredAt: '2026-10-12T00:00:00Z', inputCount: 1, omittedCount: 1, sources: [{ key: item.key, sequence: 1 }], evidence: voiceEvidence, result: { groups: voiceGroups, hierarchy: [{ id: 'experience', title: 'Improve local experience', purpose: 'Inferred purpose', groupIndexes: [] }, { id: 'voice', title: 'Voice interaction', purpose: 'Voice subgroup', parentId: 'experience', groupIndexes: [0] }] } } })
  const graph = overviewGraph(data)
  assert.deepEqual(overviewLayout(graph, new Set()).nodes.map(node => node.id), ['organized-hierarchy:experience', 'organized:unclassified'])
  assert.equal(graph.nodes.find(node => node.id === 'presentation:0')?.parentId, 'organized-hierarchy:voice')
  assert.equal(graph.nodes.find(node => node.id === 'older')?.parentId, 'organized:unclassified')
  assert.equal(graph.nodes.find(node => node.id === 'organized-hierarchy:experience')?.status, 'mixed')
  assert.equal(graph.nodes.find(node => node.id === 'organized-hierarchy:experience')?.at, item.changedAt)
  const expanded = overviewLayout(graph, new Set(['organized-hierarchy:experience', 'organized-hierarchy:voice', 'presentation:0', 'organized:unclassified']))
  assert.equal(new Set(expanded.nodes.map(node => node.id)).size, expanded.nodes.length)
  assert(expanded.nodes.some(node => node.id === 'older'))
  assert(expanded.nodes.some(node => node.detail === voiceGroups[0]!.cards![1]!.markdown))
  const filters = projectFocusGroups(projectTopics(data), data.focus)
  assert.deepEqual(filters.map(group => group.key), ['organized-hierarchy:experience', 'organized:unclassified'])
  assert.equal(filters[0]!.topics.length, 1)
  assert.equal(filters[1]!.topics[0]!.key, 'older')
})
