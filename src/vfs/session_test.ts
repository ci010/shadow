import assert from 'node:assert/strict'
import test from 'node:test'
import { createSelfSessionHandler, withSelfSession } from './session.ts'
import { VirtualFs } from './virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { WriteTool } from '../tools/filesystem.ts'

test('current session JSON uses dedicated virtual write routing and validates exact edit results', async () => {
  const state = { name: 'Current', description: 'Purpose', completed: false }
  const writes: unknown[] = []
  const handler = createSelfSessionHandler({ updateSelfMetadata: async (id, value, expected) => {
    assert.equal(id, 'web:self')
    writes.push({ value, expected })
    Object.assign(state, { completed: (value as { completed: boolean }).completed })
  } }, () => ({ assertActor: (project, id) => {
    assert.equal(project, 'p'); assert.equal(id, 'web:self'); return state as never
  } }))
  const vfs = new VirtualFs()
  vfs.mount('v:sessions', 'self metadata', handler.read, undefined, handler.write)
  const context = { projectId: 'p', sessionId: 'web:self', tools: { executionMode: 'session' }, signal: new AbortController().signal } as ExecutionContext
  const writer = new WriteTool('/workspace', false, vfs)
  const original = await vfs.resolve('v:sessions/self.json', context)
  assert.deepEqual(JSON.parse(original!), { topic: 'Current', focus: '', completed: false })
  const result = await writer.execute({ path: 'v:sessions/self.json', match: 'false', content: 'true' }, context)
  assert.equal(JSON.parse(result).completed, true)
  assert.deepEqual(writes, [{ value: { topic: 'Current', focus: '', completed: true }, expected: original }])
  await assert.rejects(writer.execute({ path: 'v:sessions/self.json', content: '{' }, context), /Invalid JSON/)
  await assert.rejects(writer.execute({ path: 'v:sessions/self.json', match: 'true', content: 'invalid' }, context), /Invalid JSON/)
  await assert.rejects(writer.execute({ path: 'v:sessions/self.json', match: 'absent', content: 'x' }, context), /Exact match/)
  assert.match(await writer.execute({ path: 'v:sessions/self.json', content: '{}', flag: 'a' }, context), /append is unsupported/)
  await assert.rejects(vfs.write('v:sessions/other.json', { content: '{}' }, context)!, /self.json/)
  assert.throws(() => vfs.write('v:unknown/self.json', { content: '{}' }, context), /Unknown/)
  assert.throws(() => vfs.write('v:sessions/self.json', { content: '{}' }, { ...context, tools: { executionMode: 'call' } } as ExecutionContext), /call mode/)
  const remoteContext = { ...context, remoteWorkdir: {
    nodeId: 'remote', workdirId: 'opaque',
    get executor(): never { throw new Error('Self metadata must not access the remote executor') },
  } } as ExecutionContext
  const remoteResult = await writer.execute({ path: 'v:sessions/self.json', match: 'true', content: 'false' }, remoteContext)
  assert.equal(JSON.parse(remoteResult).completed, false)
  assert.equal(writes.length, 2)
  assert.throws(() => vfs.write('v:sessions/self.json', { content: '{}' }, { ...remoteContext, tools: { executionMode: 'call' } } as ExecutionContext), /call mode/)
  await assert.rejects(writer.execute({ path: 'v:sessions/self.json', match: '"', content: 'x' }, context), /Multiple matches/)
  assert.equal(writes.length, 2)
})

test('one sessions namespace routes metadata and history without allowing history writes', async () => {
  const self = createSelfSessionHandler({ updateSelfMetadata: async () => {} }, () => ({ assertActor: () => ({ topic: 'Self', completed: false }) as never }))
  const history = {
    read: async (path: string) => `history:${path}`,
    list: async () => [{ name: 'web:other', content: 'history' }],
    directory: async () => null,
  }
  const handler = withSelfSession(history, self)
  const vfs = new VirtualFs()
  vfs.mount('v:sessions', 'Sessions', handler.read, handler.list, handler.write, handler.directory)
  const context = { projectId: 'p', sessionId: 'web:self', tools: { executionMode: 'session' }, signal: new AbortController().signal } as ExecutionContext
  assert.equal(await vfs.resolve('v:sessions/web:other/brief', context), 'history:web:other/brief')
  assert.equal(JSON.parse((await vfs.resolve('v:sessions/self.json', context))!).topic, 'Self')
  assert.deepEqual((await vfs.list('v:sessions', context))!.map(entry => entry.name), ['self.json', 'web:other'])
  assert.deepEqual((await vfs.list('v:sessions/self.json', context))!.map(entry => entry.name), ['self.json'])
  assert.equal(await vfs.directory('v:sessions/self.json', context), null)
  await assert.rejects(vfs.write('v:sessions/web:other/brief', { content: '{}' }, context)!, /self.json/)
  assert.throws(() => vfs.resolve('v:session/self.json', context), /Unknown/)
  assert.throws(() => vfs.write('v:session/self.json', { content: '{}' }, context), /Unknown/)
})
