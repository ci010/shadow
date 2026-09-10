import assert from 'node:assert/strict'
import test from 'node:test'
import { groupProjectSessions, isAbsoluteProjectPath, parseSessionGraph, PROJECT_ACTIONS, suggestCloneDirectory, visibleSessions } from './projects-sidebar.ts'

const project = { id: 'project-a', name: 'same-name', path: 'C:\\fixtures\\one', createdAt: '2026-09-10T00:00:00Z' }

test('the project menu contains exactly the three specified actions in order', () => {
  assert.deepEqual(PROJECT_ACTIONS, [
    { id: 'open', label: 'Open folder' },
    { id: 'clone', label: 'Clone repo' },
    { id: 'scratch', label: 'Start from scratch' },
  ])
})

test('stable project IDs group conversations, never projectName planning notes or matching labels', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-one', projectId: project.id },
      { sessionId: 'web:chat-two', projectId: 'project-b' },
      { sessionId: 'web:chat-legacy', projectName: project.name, title: project.name },
      { sessionId: 'web:chat-unknown', projectId: 'missing-project' },
    ],
    nodes: [],
  })
  const groups = groupProjectSessions([project, { ...project, id: 'project-b', path: 'C:\\fixtures\\two' }], sessions)
  assert.deepEqual(groups.projects.map(group => group.sessions.map(session => session.sessionId)), [['web:chat-one'], ['web:chat-two']])
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['web:chat-legacy', 'web:chat-unknown'])
  assert.equal('projectName' in sessions[2], false)
})

test('registered empty projects are retained, independent of session activity', () => {
  assert.deepEqual(groupProjectSessions([project], []).projects, [{ project, sessions: [] }])
})

test('physical parent lineage, logical compaction, label, model and collapse interaction survive grouping', () => {
  const config = { model: 'provider/model', thinking: { type: 'enabled' }, reasoningEffort: 'high' }
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-child', projectId: project.id, description: 'A child' },
      { sessionId: 'web:chat-root', projectId: project.id, title: 'Root title', current: 'root-new', config },
      { sessionId: 'web:chat-grandchild', projectId: project.id },
      { sessionId: 'web:chat-legacy-child' },
      { sessionId: 'web:chat-legacy' },
    ],
    nodes: [
      { physicalId: 'root', logicalId: 'web:chat-root', parentPhysicalId: null },
      { physicalId: 'root-new', logicalId: 'web:chat-root', parentPhysicalId: 'root' },
      { physicalId: 'child', logicalId: 'web:chat-child', parentPhysicalId: 'root' },
      { physicalId: 'grandchild', logicalId: 'web:chat-grandchild', parentPhysicalId: 'child' },
      { physicalId: 'legacy', logicalId: 'web:chat-legacy', parentPhysicalId: null },
      { physicalId: 'legacy-child', logicalId: 'web:chat-legacy-child', parentPhysicalId: 'legacy' },
    ],
  })
  const groups = groupProjectSessions([project], sessions)
  assert.deepEqual(groups.projects[0].sessions.map(session => [session.sessionId, session.depth]), [
    ['web:chat-root', 0], ['web:chat-child', 1], ['web:chat-grandchild', 2],
  ])
  assert.equal(groups.projects[0].sessions[0].label, 'Root title')
  assert.deepEqual(groups.projects[0].sessions[0].config, config)
  assert.equal(groups.projects[0].sessions[0].isCurrent, true)
  assert.deepEqual(visibleSessions(groups.projects[0].sessions, new Set(['web:chat-root'])).map(session => session.sessionId), ['web:chat-root'])
  assert.deepEqual(groups.chats.map(session => session.depth), [0, 1])
})

test('cross-project parents do not hide or reassign sessions; invalid cycles remain bounded', () => {
  const sessions = parseSessionGraph({
    sessions: [{ sessionId: 'web:chat-a', projectId: project.id }, { sessionId: 'web:chat-b' }],
    nodes: [
      { physicalId: 'a', logicalId: 'web:chat-a', parentPhysicalId: 'b' },
      { physicalId: 'b', logicalId: 'web:chat-b', parentPhysicalId: 'a' },
    ],
  })
  assert.equal(sessions.length, 2)
  const groups = groupProjectSessions([project], sessions)
  assert.equal(groups.chats[0].parentSessionId, 'web:chat-a')
  assert.equal(groups.chats[0].depth, 0)
  assert.equal(visibleSessions(groups.chats, new Set(['web:chat-a'])).length, 1)
  assert.equal(visibleSessions(sessions, new Set()).length, 2)
})

test('malformed graph data is rejected instead of emptying the sidebar silently', () => {
  for (const graph of [null, {}, { sessions: null, nodes: [] }, { sessions: [{ sessionId: 1 }], nodes: [] }, { sessions: [], nodes: [null] }]) {
    assert.throws(() => parseSessionGraph(graph), /Cannot read conversations/)
  }
})

test('directory suggestion handles HTTPS and SSH without carrying URL tokens', () => {
  assert.equal(suggestCloneDirectory('https://example.invalid/owner/demo.git?token=synthetic'), 'demo')
  assert.equal(suggestCloneDirectory('git@example.invalid:owner/demo.git'), 'demo')
  assert.equal(suggestCloneDirectory('ssh://git@example.invalid/owner/demo.git/'), 'demo')
  assert.equal(suggestCloneDirectory(''), '')
})

test('browser fallback accepts explicit absolute paths, not folder upload names or relative guesses', () => {
  for (const path of ['C:\\fixtures\\project', 'D:/fixture/project', '\\\\server\\share\\project', '/fixture/project']) assert.equal(isAbsoluteProjectPath(path), true)
  for (const path of ['', 'project', './project', 'C:project', '~\\project']) assert.equal(isAbsoluteProjectPath(path), false)
})
