import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionLocationDraft, projectFolderTargets } from './execution-locations.ts'
import { createFoldersClient, type FolderRecord } from './folders-client.ts'
import type { NodeInventoryEntry } from './node-inventory.ts'

const local: FolderRecord = { projectId: 'a', id: 'local', name: 'Local code', path: 'C:\\fixture\\code', createdAt: '2026-09-17' }
const remote: FolderRecord = {
  projectId: 'a', id: 'remote', name: 'Remote code', path: '/display/code', createdAt: '2026-09-17', kind: 'remote',
  workdir: { version: 2, nodeId: 'child', workdirId: 'code' },
  identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
}
const node: NodeInventoryEntry = { nodeId: 'child', displayName: 'Laptop', role: 'child', connection: 'connected', executionProtocol: 'compatible', workdirs: [
  { version: 2 as const, nodeId: 'child', workdirId: 'code', displayName: 'Code', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } },
  { version: 2 as const, nodeId: 'child', workdirId: 'foreign', displayName: 'Other project folder', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } },
], support: { operations: [] } }

test('project execution options include all local and remote folders in that project, never global capabilities', () => {
  const targets = projectFolderTargets('a', [local, remote, { ...remote, id: 'foreign', projectId: 'b' }], [node])
  assert.deepEqual(targets.map(target => target.folder.id), ['local', 'remote'])
  assert.ok(targets.every(target => target.available))
  assert.match(targets[1].detail, /Laptop.*\/display\/code/)
  assert.deepEqual(projectFolderTargets('a', [{ ...local, projectId: undefined }], [node]), [])
  assert.deepEqual(projectFolderTargets('a', [], [node]), [])
})

test('unavailable remote folders remain visible but never become local execution choices', () => {
  for (const nodes of [[], [{ ...node, connection: 'offline' as const }], [{ ...node, workdirs: node.workdirs.map(w => ({ ...w, support: { operations: [] } })) }],
    [{ ...node, executionProtocol: 'upgrade-required' as const }], [{ ...node, workdirs: [] }],
    [{ ...node, workdirs: node.workdirs.map(resource => ({ ...resource, online: false })) }],
    [{ ...node, workdirs: node.workdirs.map(w => ({ ...w, support: { operations: [] } })) }]]) {
    const targets = projectFolderTargets('a', [local, remote], nodes)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].available, true)
    assert.equal(targets[1].available, false)
    assert.equal(targets[1].folder.kind, 'remote')
  }
})

test('selecting either project folder defers creation and first send uses its scoped folder endpoint', async () => {
  const requests: string[] = []
  const client = createFoldersClient('http://fixture/projects/a/', async (url, init) => {
    requests.push(String(url))
    assert.equal(init?.method, 'POST')
    return Response.json({ sessionId: 'web:chat-folder', chatId: 'chat-folder' })
  })
  for (const folder of [local, remote]) {
    const draft = createExecutionLocationDraft('http://fixture/projects/a/', 'a', client, { kind: 'folder', folder })
    const before = requests.length
    assert.equal(draft.folder, folder)
    assert.equal(await draft.prepare(), 'web:chat-folder')
    assert.equal(await draft.prepare(), 'web:chat-folder')
    assert.equal(requests.length, before + 1)
    assert.equal(requests.at(-1), `http://fixture/projects/a/api/folders/${folder.id}/sessions`)
  }
  assert.throws(() => createExecutionLocationDraft('http://fixture/projects/a/', 'a', client,
    { kind: 'folder', folder: { ...remote, projectId: 'b' } }), /does not belong/)
  const scratch = createExecutionLocationDraft('http://fixture/projects/a/', 'a', client)
  assert.equal(scratch.folder, undefined, 'This computer clears any previously selected folder')
  assert.equal(requests.length, 2)
})

test('common folder shortcuts rank direct conversations by frequency then recency and cap at three', async () => {
  const { commonFolderTargets } = await import('./execution-locations.ts')
  const targets = projectFolderTargets('a', [local, remote, { ...local, id: 'third' }, { ...local, id: 'fourth' }], [])
  const session = (folderId: string, lastActivityAt = '2026-10-01') => ({ folderId, lastActivityAt, isDirectChat: true, parentSessionId: null })
  const ranked = commonFolderTargets(targets, [session('remote'), session('remote'), session('third', '2026-10-02'), session('local'),
    { ...session('fourth'), isDirectChat: false }, { ...session('fourth'), parentSessionId: 'parent' }, session('deleted')])
  assert.deepEqual(ranked.map(target => target.folder.id), ['remote', 'third', 'local'])
  assert.equal(ranked[0].available, false, 'offline folders preserve menu availability')
  assert.deepEqual(commonFolderTargets(targets, []).map(target => target.folder.id), ['local', 'remote', 'third'])
  assert.deepEqual(targets.map(target => target.folder.id), ['local', 'remote', 'third', 'fourth'], 'input is unchanged')
  assert.deepEqual(commonFolderTargets([], []), [])
  assert.equal(commonFolderTargets(targets.slice(0, 1), []).length, 1)
})
