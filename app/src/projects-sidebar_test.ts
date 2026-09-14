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

test('self reflections use stable heartbeat agent IDs, not mutable titles or other heartbeat tasks', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'heartbeat:reflector-1789000000000', title: 'Renamed to an ordinary title' },
      { sessionId: 'heartbeat:soul-reflector-1789000000001', title: 'Also renamed' },
      { sessionId: 'web:chat-reflect', title: 'Reflect: this is a normal conversation' },
      { sessionId: 'heartbeat:encapsulator-1789000000002', title: 'Reflect: not a reflector' },
      { sessionId: 'heartbeat:heartbeat', title: 'Soul Reflect: also not a reflector' },
      { sessionId: 'web:reflector-1789000000003' },
      { sessionId: 'heartbeat:reflector' },
    ],
    nodes: [],
  })
  const groups = groupProjectSessions([], sessions)
  assert.deepEqual(groups.reflections.map(session => session.sessionId), [
    'heartbeat:reflector-1789000000000', 'heartbeat:soul-reflector-1789000000001',
  ])
  assert.equal(groups.reflections[0].label, 'Renamed to an ordinary title')
  assert.deepEqual(groups.chats.map(session => session.sessionId), sessions.slice(2).map(session => session.sessionId))
})

test('reflection descendants cross project boundaries without changing associations or full text', () => {
  const title = '完整标题 https://example.invalid/' + '很长的内容\n'.repeat(300)
  const description = 'Original description\n'.repeat(100)
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-regular', projectId: project.id },
      { sessionId: 'web:chat-grandchild', projectId: 'missing-project', title, description },
      { sessionId: 'heartbeat:reflector-1789000000000', projectId: project.id },
      { sessionId: 'web:chat-child', projectId: 'project-b' },
    ],
    nodes: [
      { physicalId: 'reflection', logicalId: 'heartbeat:reflector-1789000000000' },
      { physicalId: 'child', logicalId: 'web:chat-child', parentPhysicalId: 'reflection' },
      { physicalId: 'grandchild', logicalId: 'web:chat-grandchild', parentPhysicalId: 'child' },
    ],
  })
  const before = structuredClone(sessions)
  const groups = groupProjectSessions([project, { ...project, id: 'project-b' }], sessions)
  assert.deepEqual(groups.projects.map(group => group.sessions.map(session => session.sessionId)), [['web:chat-regular'], []])
  assert.deepEqual(groups.chats, [])
  assert.deepEqual(groups.reflections.map(session => [session.sessionId, session.depth, session.projectId]), [
    ['heartbeat:reflector-1789000000000', 0, project.id],
    ['web:chat-child', 1, 'project-b'],
    ['web:chat-grandchild', 2, 'missing-project'],
  ])
  assert.equal(groups.reflections[2].label, title)
  assert.equal(groups.reflections[2].description, description)
  assert.deepEqual(sessions, before)
  assert.deepEqual(visibleSessions(groups.reflections, new Set(['web:chat-child'])).map(session => session.sessionId), [
    'heartbeat:reflector-1789000000000', 'web:chat-child',
  ])
})

test('missing reflection roots and malformed cycles retain every session exactly once', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-cycle-child', projectId: project.id },
      { sessionId: 'heartbeat:soul-reflector-1789000000001' },
      { sessionId: 'web:chat-orphan' },
      { sessionId: 'web:chat-orphan-child' },
      { sessionId: 'web:chat-unrelated-orphan' },
      { sessionId: 'heartbeat:encapsulator-1789000000002' },
    ],
    nodes: [
      { physicalId: 'cycle-child', logicalId: 'web:chat-cycle-child', parentPhysicalId: 'cycle-root' },
      { physicalId: 'cycle-root', logicalId: 'heartbeat:soul-reflector-1789000000001', parentPhysicalId: 'cycle-child' },
      { physicalId: 'missing', logicalId: 'heartbeat:reflector-1789000000000' },
      { physicalId: 'orphan', logicalId: 'web:chat-orphan', parentPhysicalId: 'missing' },
      { physicalId: 'orphan-child', logicalId: 'web:chat-orphan-child', parentPhysicalId: 'orphan' },
      { physicalId: 'missing-normal', logicalId: 'web:chat-missing' },
      { physicalId: 'unrelated-orphan', logicalId: 'web:chat-unrelated-orphan', parentPhysicalId: 'missing-normal' },
    ],
  })
  const groups = groupProjectSessions([project], sessions)
  const all = [...groups.projects.flatMap(group => group.sessions), ...groups.chats, ...groups.reflections]
  assert.equal(all.length, sessions.length)
  assert.equal(new Set(all.map(session => session.sessionId)).size, sessions.length)
  assert.deepEqual(new Set(groups.reflections.map(session => session.sessionId)), new Set([
    'heartbeat:soul-reflector-1789000000001', 'web:chat-cycle-child', 'web:chat-orphan', 'web:chat-orphan-child',
  ]))
  assert.equal(visibleSessions(groups.reflections, new Set()).length, 4)
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['web:chat-unrelated-orphan', 'heartbeat:encapsulator-1789000000002'])
  assert.equal(groups.reflections.find(session => session.sessionId === 'web:chat-orphan')?.depth, 0)
  assert.equal(groups.reflections.find(session => session.sessionId === 'web:chat-orphan-child')?.depth, 1)
  const root = groups.reflections[0]
  assert.equal(root.depth, 0)
  assert.ok(visibleSessions(groups.reflections, new Set(groups.reflections.map(session => session.sessionId))).includes(root))
})

test('physical parent lineage, logical compaction, label, model and collapse interaction survive grouping', () => {
  const config = { model: 'provider/model', thinking: { type: 'enabled' }, reasoningEffort: 'low' }
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
