import assert from 'node:assert/strict'
import test from 'node:test'
import { sidebarFolderLabels } from './sidebar-folder-labels.ts'
import type { FolderRecord } from './folders-client.ts'
import type { NodeInventoryEntry } from './node-inventory.ts'

const local: FolderRecord = { id: 'local', name: 'shadow', path: '/repo/shadow', createdAt: '' }
const remote: FolderRecord = { id: 'remote', name: 'shadow', path: 'C:\\repo\\shadow', createdAt: '', kind: 'remote', workdir: { version: 1, nodeId: 'child', capabilityId: 'repo' } }
const nodes: NodeInventoryEntry[] = [
  { nodeId: 'main', displayName: 'Mac', role: 'main', connection: 'connected', capabilities: [] },
  { nodeId: 'child', displayName: 'Windows', role: 'child', connection: 'offline', capabilities: [] },
]

test('single device keeps compact folder names', () => {
  assert.equal(sidebarFolderLabels([local], nodes.slice(0, 1), 'This computer').get('local'), 'shadow')
})
test('multiple devices identify both local and remote folders, including offline devices', () => {
  const labels = sidebarFolderLabels([local, remote], nodes, 'This computer')
  assert.equal(labels.get('local'), 'shadow · Mac')
  assert.equal(labels.get('remote'), 'shadow · Windows')
  assert.equal(sidebarFolderLabels([{ ...local, name: 'other' }], nodes, 'This computer').get('local'), 'other · Mac')
})
test('inventory failure preserves remote identity rather than implying local execution', () => {
  const labels = sidebarFolderLabels([local, remote], [], 'This computer')
  assert.equal(labels.get('local'), 'shadow · This computer')
  assert.equal(labels.get('remote'), 'shadow · child')
})
test('same-device duplicate names include paths', () => {
  const labels = sidebarFolderLabels([local, { ...local, id: 'second', path: '/other/shadow' }], nodes.slice(0, 1), 'This computer')
  assert.equal(labels.get('local'), 'shadow · Mac · /repo/shadow')
  assert.equal(labels.get('second'), 'shadow · Mac · /other/shadow')
})

 test('namesake folders get distinct, order-independent colors; unique names stay neutral', async () => {
  const { sidebarFolderTones } = await import('./sidebar-folder-labels.ts')
  const unique = { ...local, id: 'unique', name: 'other' }
  const tones = sidebarFolderTones([local, remote, unique])
  assert.notEqual(tones.get(local.id), tones.get(remote.id))
  assert.equal(tones.has(unique.id), false)
  assert.deepEqual(tones, sidebarFolderTones([unique, remote, local]))
  assert.equal(sidebarFolderTones([local]).size, 0)
})
