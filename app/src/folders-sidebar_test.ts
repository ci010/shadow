import assert from 'node:assert/strict'
import test from 'node:test'
import { groupFolderSessions, isAbsoluteFolderPath, parseSessionGraph, FOLDER_ACTIONS, suggestCloneDirectory, visibleSessions } from './folders-sidebar.ts'

const folder = { id: 'folder-a', name: 'same-name', path: 'C:\\fixtures\\one', createdAt: '2026-09-10T00:00:00Z' }
const automation = { jobId: 'scheduled-task', name: 'Scheduled review', runId: 'run-1', startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh' }

test('the folder menu keeps remote folders beside local folders', () => {
  assert.deepEqual(FOLDER_ACTIONS, [
    { id: 'open', label: 'Open folder' },
    { id: 'remote', label: 'Open remote folder' },
    { id: 'clone', label: 'Clone repository' },
    { id: 'scratch', label: 'Start from scratch' },
  ])
})

test('stable folder IDs group conversations, never initiative IDs, legacy planning names or matching labels', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-one', folderId: folder.id },
      { sessionId: 'web:chat-two', folderId: 'folder-b' },
      { sessionId: 'web:chat-legacy', projectName: folder.name, title: folder.name },
      { sessionId: 'web:chat-initiative', initiativeName: folder.name, title: folder.name },
      { sessionId: 'web:chat-initiative-id', initiativeId: folder.id, title: folder.name },
      { sessionId: 'web:chat-unknown', folderId: 'missing-folder' },
    ],
    nodes: [],
  })
  const groups = groupFolderSessions([folder, { ...folder, id: 'folder-b', path: 'C:\\fixtures\\two' }], sessions)
  assert.deepEqual(groups.folders.map(group => group.sessions.map(session => session.sessionId)), [['web:chat-one'], ['web:chat-two']])
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['web:chat-legacy', 'web:chat-initiative', 'web:chat-initiative-id', 'web:chat-unknown'])
  assert.equal('projectName' in sessions[2], false)
  assert.equal('initiativeName' in sessions[3], false)
  assert.equal('initiativeId' in sessions[4], false)
})

test('registered empty folders are retained, independent of session activity', () => {
  assert.deepEqual(groupFolderSessions([folder], []).folders, [{ folder, sessions: [] }])
})

test('fresh tasks use explicit identity, not mutable titles, prompt matches or heartbeat ID patterns', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'cron:custom-fresh-run', title: 'Renamed to an ordinary title', automation },
      { sessionId: 'heartbeat:encapsulator-1789000000001', title: 'Also renamed', automation: { ...automation, runId: 'run-2' } },
      { sessionId: 'web:chat-reflect', title: 'Reflect: this is a normal conversation' },
      { sessionId: 'heartbeat:encapsulator-1789000000002', title: 'Reflect: not a reflector' },
      { sessionId: 'heartbeat:heartbeat', title: 'Soul Reflect: also not a reflector' },
      { sessionId: 'web:reflector-1789000000003' },
      { sessionId: 'heartbeat:reflector' },
    ],
    nodes: [],
  })
  const groups = groupFolderSessions([], sessions)
  assert.equal(groups.automations.length, 1)
  assert.deepEqual(groups.automations[0].sessions.map(session => session.sessionId), [
    'cron:custom-fresh-run', 'heartbeat:encapsulator-1789000000001',
  ])
  assert.equal(groups.automations[0].sessions[0].label, 'Renamed to an ordinary title')
  assert.deepEqual(groups.chats.map(session => session.sessionId), sessions.slice(2).map(session => session.sessionId))
})

test('append cron remains an ordinary chat while an opaque fresh run uses its explicit automation owner', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'opaque-run-id', title: 'Weekly review', automation },
      { sessionId: 'web:chat-append', title: 'Weekly review' },
    ],
    nodes: [],
  })
  const groups = groupFolderSessions([], sessions)
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['web:chat-append'])
  assert.equal(groups.chats[0].isDirectChat, true)
  assert.deepEqual(groups.automations[0].sessions.map(session => session.sessionId), ['opaque-run-id'])
})

test('fresh run executions cross folder boundaries without changing associations or full text', () => {
  const title = '完整标题 https://example.invalid/' + '很长的内容\n'.repeat(300)
  const description = 'Original description\n'.repeat(100)
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-regular', folderId: folder.id },
      { sessionId: 'web:chat-grandchild', mode: 'call', folderId: 'missing-folder', title, description },
      { sessionId: 'heartbeat:reflector-1789000000000', folderId: folder.id, automation },
      { sessionId: 'web:chat-child', mode: 'task', folderId: 'folder-b' },
    ],
    nodes: [
      { physicalId: 'reflection', logicalId: 'heartbeat:reflector-1789000000000' },
      { physicalId: 'child', logicalId: 'web:chat-child', parentPhysicalId: 'reflection' },
      { physicalId: 'grandchild', logicalId: 'web:chat-grandchild', parentPhysicalId: 'child' },
    ],
  })
  const before = structuredClone(sessions)
  const groups = groupFolderSessions([folder, { ...folder, id: 'folder-b' }], sessions)
  const runs = groups.automations[0].sessions
  assert.deepEqual(groups.folders.map(group => group.sessions.map(session => session.sessionId)), [['web:chat-regular'], []])
  assert.deepEqual(groups.chats, [])
  assert.deepEqual(runs.map(session => [session.sessionId, session.depth, session.folderId]), [
    ['heartbeat:reflector-1789000000000', 0, folder.id],
    ['web:chat-child', 1, 'folder-b'],
    ['web:chat-grandchild', 2, 'missing-folder'],
  ])
  assert.equal(runs[2].label, title)
  assert.equal(runs[2].description, description)
  assert.deepEqual(sessions, before)
  assert.deepEqual(visibleSessions(runs, new Set(['web:chat-child'])).map(session => session.sessionId), [
    'heartbeat:reflector-1789000000000', 'web:chat-child',
  ])
})

test('explicit orphan ownership and malformed cycles retain every session exactly once', () => {
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-cycle-child', mode: 'task', folderId: folder.id },
      { sessionId: 'heartbeat:soul-reflector-1789000000001', automation },
      { sessionId: 'web:chat-orphan', automation: { ...automation, runId: 'orphan-run' } },
      { sessionId: 'web:chat-orphan-child', mode: 'call' },
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
  const groups = groupFolderSessions([folder], sessions)
  const runs = groups.automations[0].sessions
  const all = [...groups.folders.flatMap(group => group.sessions), ...groups.chats, ...runs]
  assert.equal(all.length, sessions.length)
  assert.equal(new Set(all.map(session => session.sessionId)).size, sessions.length)
  assert.deepEqual(new Set(runs.map(session => session.sessionId)), new Set([
    'heartbeat:soul-reflector-1789000000001', 'web:chat-cycle-child', 'web:chat-orphan', 'web:chat-orphan-child',
  ]))
  assert.equal(visibleSessions(runs, new Set()).length, 4)
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['web:chat-unrelated-orphan', 'heartbeat:encapsulator-1789000000002'])
  assert.equal(runs.find(session => session.sessionId === 'web:chat-orphan')?.depth, 0)
  assert.equal(runs.find(session => session.sessionId === 'web:chat-orphan-child')?.depth, 1)
  const root = runs[0]
  assert.equal(root.depth, 0)
  assert.ok(visibleSessions(runs, new Set(runs.map(session => session.sessionId))).includes(root))
})

test('fresh task roots stay grouped even when one-shot; invalid associations fail explicitly', () => {
  const graph = { sessions: [
    { sessionId: 'cron:new', mode: 'task', automation },
    { sessionId: 'child', parentSessionId: 'cron:new', mode: 'call' },
    { sessionId: 'cron:reused', mode: 'session' },
  ], nodes: [] }
  const groups = groupFolderSessions([], parseSessionGraph(graph))
  assert.deepEqual(groups.chats.map(session => session.sessionId), ['cron:reused'])
  assert.deepEqual(groups.automations[0].sessions.map(session => session.sessionId), ['cron:new', 'child'])
  for (const invalid of [null, {}, { ...automation, contextMode: 'origin' }, { ...automation, jobId: '' }, { ...automation, startedAt: 'bad' }]) {
    assert.throws(() => parseSessionGraph({ sessions: [{ sessionId: 'one', automation: invalid }], nodes: [] }), /Cannot read/)
  }
})

test('historical parent lineage cannot nest or collapse ordinary chats; compaction and labels survive', () => {
  const config = { model: 'provider/model', thinking: { type: 'enabled' }, reasoningEffort: 'low' }
  const sessions = parseSessionGraph({
    sessions: [
      { sessionId: 'web:chat-child', folderId: folder.id, description: 'A child' },
      { sessionId: 'web:chat-root', folderId: folder.id, title: 'Root title', current: 'root-new', config },
      { sessionId: 'web:chat-grandchild', folderId: folder.id },
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
  const groups = groupFolderSessions([folder], sessions)
  assert.deepEqual(groups.folders[0].sessions.map(session => [session.sessionId, session.depth]), [
    ['web:chat-child', 0], ['web:chat-root', 0], ['web:chat-grandchild', 0],
  ])
  assert.equal(groups.folders[0].sessions[1].label, 'Root title')
  assert.deepEqual(groups.folders[0].sessions[1].config, config)
  assert.equal(groups.folders[0].sessions[1].isCurrent, true)
  assert.deepEqual(visibleSessions(groups.folders[0].sessions, new Set(['web:chat-root'])).map(session => session.sessionId), ['web:chat-child', 'web:chat-root', 'web:chat-grandchild'])
  assert.deepEqual(groups.chats.map(session => session.depth), [0, 0])
})

test('cross-folder parents do not hide or reassign sessions; invalid cycles remain bounded', () => {
  const sessions = parseSessionGraph({
    sessions: [{ sessionId: 'web:chat-a', folderId: folder.id }, { sessionId: 'web:chat-b' }],
    nodes: [
      { physicalId: 'a', logicalId: 'web:chat-a', parentPhysicalId: 'b' },
      { physicalId: 'b', logicalId: 'web:chat-b', parentPhysicalId: 'a' },
    ],
  })
  assert.equal(sessions.length, 2)
  const groups = groupFolderSessions([folder], sessions)
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
  for (const path of ['C:\\fixtures\\folder', 'D:/fixture/folder', '\\\\server\\share\\folder', '/fixture/folder']) assert.equal(isAbsoluteFolderPath(path), true)
  for (const path of ['', 'folder', './folder', 'C:folder', '~\\folder']) assert.equal(isAbsoluteFolderPath(path), false)
})
