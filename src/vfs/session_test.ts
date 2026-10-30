import assert from 'node:assert/strict'
import test from 'node:test'
import { createSelfSessionHandler } from './session.ts'
import { VirtualFs } from './virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { WriteTool } from '../tools/filesystem.ts'

test('current session JSON uses dedicated virtual write routing and validates exact edit results', async () => {
  const state = { name: 'Current', description: 'Purpose', completed: false }
  const writes: unknown[] = []
  const handler = createSelfSessionHandler({ getSelfWorkingPaths: () => ({ projectDir: null, cwd: null }), updateSelfMetadata: async (id, value, expected) => {
    assert.equal(id, 'web:self')
    writes.push({ value, expected })
    Object.assign(state, { completed: (value as { completed: boolean }).completed })
  } }, () => ({ assertActor: (project, id) => {
    assert.equal(project, 'p'); assert.equal(id, 'web:self'); return state as never
  } }))
  const vfs = new VirtualFs()
  vfs.mount('v:session', 'self metadata', handler.read, undefined, handler.write)
  const context = { projectId: 'p', sessionId: 'web:self', tools: { executionMode: 'session' }, signal: new AbortController().signal } as ExecutionContext
  const writer = new WriteTool('/workspace', false, vfs)
  const original = await vfs.resolve('v:session/self.json', context)
  assert.deepEqual(JSON.parse(original!), { projectDir: null, cwd: null, title: 'Current', description: 'Purpose', completed: false })
  const result = await writer.execute({ path: 'v:session/self.json', match: 'false', content: 'true' }, context)
  assert.equal(JSON.parse(result).completed, true)
  assert.deepEqual(writes, [{ value: { projectDir: null, cwd: null, title: 'Current', description: 'Purpose', completed: true }, expected: original }])
  await assert.rejects(writer.execute({ path: 'v:session/self.json', content: '{' }, context), /Invalid JSON/)
  await assert.rejects(writer.execute({ path: 'v:session/self.json', match: 'true', content: 'invalid' }, context), /Invalid JSON/)
  await assert.rejects(writer.execute({ path: 'v:session/self.json', match: 'absent', content: 'x' }, context), /Exact match/)
  assert.match(await writer.execute({ path: 'v:session/self.json', content: '{}', flag: 'a' }, context), /append is unsupported/)
  await assert.rejects(vfs.write('v:session/other.json', { content: '{}' }, context)!, /self.json/)
  assert.throws(() => vfs.write('v:unknown/self.json', { content: '{}' }, context), /Unknown/)
  assert.throws(() => vfs.write('v:session/self.json', { content: '{}' }, { ...context, tools: { executionMode: 'call' } } as ExecutionContext), /call mode/)
  const remoteContext = { ...context, remoteWorkdir: {
    nodeId: 'remote', capabilityId: 'opaque',
    get executor(): never { throw new Error('Self metadata must not access the remote executor') },
  } } as ExecutionContext
  const remoteResult = await writer.execute({ path: 'v:session/self.json', match: 'true', content: 'false' }, remoteContext)
  assert.equal(JSON.parse(remoteResult).completed, false)
  assert.equal(writes.length, 2)
  assert.throws(() => vfs.write('v:session/self.json', { content: '{}' }, { ...remoteContext, tools: { executionMode: 'call' } } as ExecutionContext), /call mode/)
  await assert.rejects(writer.execute({ path: 'v:session/self.json', match: '"', content: 'x' }, context), /Multiple matches/)
  assert.equal(writes.length, 2)
})
