import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionListMetadata } from './session-list-metadata.ts'
import type { SidebarSession } from './folders-sidebar.ts'
import type { FolderRecord } from './folders-client.ts'

const session: SidebarSession = { sessionId: 'web:one', label: 'One', folderId: 'remote', isDirectChat: true, isCurrent: false, parentSessionId: null, depth: 0 }
const local: FolderRecord = { id: 'local', name: 'shadow', path: '/repo/shadow', createdAt: '' }
const remote: FolderRecord = { id: 'remote', name: 'shadow', path: '/remote/shadow', createdAt: '', kind: 'remote', workdir: { version: 2, nodeId: 'child', workdirId: 'repo' } }

test('shared metadata preserves folder identity, remote fallback, and stable namesake tones', () => {
  const metadata = sessionListMetadata(session, [local, remote], [], 0)
  assert.equal(metadata.folder, 'shadow')
  assert.equal(metadata.folderTitle, 'shadow · child')
  assert.equal(metadata.node, 'child')
  assert.equal(metadata.folderTone, sessionListMetadata(session, [remote, local], [], 0).folderTone)
  assert.equal(metadata.time, '')
  assert.equal(metadata.absoluteTime, '')
  const missing = sessionListMetadata(session, [], [], 0)
  assert.equal(missing.folder, 'remote')
  assert.equal(missing.folderTitle, 'remote')
  assert.equal(missing.folderTone, undefined)
  assert.equal(missing.node, undefined)
})
