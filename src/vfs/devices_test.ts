import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NodeInventoryEntry } from '../cluster/node-inventory.ts'
import { FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION } from '../folders/picker-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { createDevicesHandler } from './devices.ts'
import { VirtualFs } from './virtual-fs.ts'

const context = { projectId: 'p', sessionId: 'web:owner', signal: new AbortController().signal } as ExecutionContext
const child: NodeInventoryEntry = {
  nodeId: 'child:1', displayName: 'Dev Tunnel Child', role: 'child', connection: 'connected', executionProtocol: 'compatible', workdirs: [],
  support: { operations: [FOLDER_BROWSE_OPERATION, FOLDER_SELECT_OPERATION] },
}

test('device VFS shows a live Child without a workspace and projects no private transport fields', async () => {
  let current = { ...child, privateKey: 'not-for-vfs', endpoint: 'https://private.example' }
  const handler = createDevicesHandler({ projectId: 'p', assertSession: () => {}, inventory: () => ({ version: 1, nodes: [current] }) })
  const vfs = new VirtualFs()
  vfs.mount('v:devices', 'Devices', handler.read, handler.list)
  const path = 'v:devices/child%3A1'
  const output = (await vfs.resolve('v:devices', context))!
  assert.match(output, /"projectDirectoryCount":0/)
  assert.match(output, /"remoteFolderPickerAvailable":true/)
  assert.match(output, /v:devices\/child%3A1/)
  const detail = (await vfs.resolve(path, context))!
  assert.deepEqual(JSON.parse(detail).directories, [])
  assert.doesNotMatch(detail, /not-for-vfs|private\.example/)
  assert.deepEqual(await handler.list(context, { subpath: 'child%3A1', content: false }), [{ name: 'child%3A1', content: '' }])
  current = { ...current, connection: 'offline' }
  const updated = JSON.parse((await vfs.resolve(path, context))!)
  assert.equal(updated.connection, 'offline')
  assert.equal(updated.remoteFolderPickerAvailable, false)
  assert.throws(() => vfs.write(path, { content: '{}' }, context), /read-only/)
})

test('device VFS advertises shell exec independently of Child home reads', () => {
  const contextFor = (connection: NodeInventoryEntry['connection'], enabled: boolean) => createDevicesHandler({
    projectId: 'p', assertSession: () => {}, execAvailable: () => enabled,
    inventory: () => ({ version: 1, nodes: [{ ...child, connection }] }),
  })
  const read = (connection: NodeInventoryEntry['connection'], enabled: boolean) =>
    JSON.parse(String(contextFor(connection, enabled).read('child%3A1', context)))
  assert.equal(read('connected', true).deviceExecWorkspace, 'device:child:1')
  assert.equal(read('connected', true).deviceHomeWorkspace, undefined)
  assert.equal(read('offline', true).deviceExecWorkspace, undefined)
  assert.equal(read('connected', false).deviceExecWorkspace, undefined)
})

test('device VFS checks session, Project and cancellation before inventory reads or search', () => {
  let reads = 0
  const handler = createDevicesHandler({ projectId: 'p', assertSession: ctx => {
    if (ctx.sessionId !== context.sessionId) throw new Error('Owner only')
  }, inventory: () => { reads++; return undefined } })
  assert.throws(() => handler.read('', { ...context, projectId: 'other' }), /Project mismatch/)
  assert.throws(() => handler.list({ ...context, sessionId: 'web:worker' }), /Owner only/)
  assert.throws(() => handler.read('', { ...context, signal: AbortSignal.abort() }), /aborted/)
  assert.equal(reads, 0)
  assert.throws(() => handler.read('', context), /unavailable/)
  assert.equal(reads, 1)
})
