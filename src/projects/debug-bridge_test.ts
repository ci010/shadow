import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectDebugBridge } from './debug-bridge.ts'
import { createProjectScope, getProjectScope } from './scope.ts'
import { createRuntimeHandler } from '../vfs/runtime.ts'
import { RuntimeDiagnosticLog } from '../runtime/diagnostic-log.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'

const context = { projectId: 'forged', sessionId: 'child', signal: new AbortController().signal } as ExecutionContext
function fixture() {
  const source = createProjectScope('default'), target = createProjectScope('other')
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' }
  const reads: string[] = []
  const host = {
    metadata: () => [{ id: 'other', name: 'Other' }, { id: 'offline', name: 'Offline' }],
    lookup: (id: string) => id === 'other' ? { scope: target, read: (path: string, ctx: ExecutionContext) => {
      assert.equal(getProjectScope(), target); assert.equal(ctx.projectId, 'other'); reads.push(path); return 'target data'
    } } : undefined,
  }
  return { source, target, env, reads, host, read: createProjectDebugBridge(source, host, () => env) }
}

test('development default reads target scope without an extra environment toggle, provenance and status without actor/source authentication restrictions', async () => {
  const f = fixture()
  for (const path of ['sessions', 'sessions/local:session/full', 'runtime/logs', 'runtime/sessions', 'runtime/sessions/local%3Asession/captures']) {
    assert.match(await f.source.run(() => f.read(`other/${path}`, context)), /source: other/)
  }
  assert.equal(f.reads.length, 5)
  assert.match(await f.source.run(() => f.read('', context)), /unavailable/)
  assert.match(await f.source.run(() => f.read('offline/status', context)), /unavailable/)
  await assert.rejects(f.source.run(() => f.read('offline/sessions', context)), /unavailable/)
  await assert.rejects(f.source.run(() => f.read('missing/status', context)), /Unknown/)
})

test('other runtime and absent/forged ambient scope cannot impersonate default via context', async () => {
  const f = fixture()
  const forged = { ...context, projectId: 'default', admin: true }
  const otherRead = createProjectDebugBridge(f.target, f.host, () => f.env)
  await assert.rejects(f.target.run(() => otherRead('other/sessions', forged)), /bound default/)
  await assert.rejects(f.target.run(() => f.read('other/sessions', forged)), /bound default/)
  await assert.rejects(f.read('other/sessions', forged), /bound default/)
  assert.deepEqual(f.reads, [])
})

test('non-development environments and closed source deny reads', async () => {
  const f = fixture()
  for (const nodeEnv of ['production', 'test', undefined]) {
    f.env.NODE_ENV = nodeEnv
    await assert.rejects(f.source.run(() => f.read('other/sessions', context)), /bound default/)
  }
  f.env.NODE_ENV = 'development'
  f.source.close()
  await assert.rejects(f.read('other/sessions', context), /bound default/)
  assert.deepEqual(f.reads, [])
})

test('strict read-only allowlist rejects arbitrary files, write/execute and encoded traversal', async () => {
  const f = fixture()
  for (const path of ['other/config', 'other/memory', 'other/sql', 'other/runtime/current/preview', 'other/runtime/sessions/id/preview', 'other/sessions/remote:id', 'other/sessions/id/../../config', 'other/sessions/%2e%2e', 'other/sessions/id%2ffull', 'other/sessions/id?projectId=default']) {
    await assert.rejects(f.source.run(() => f.read(path, context)), /path|resource/)
  }
  const vfs = new VirtualFs()
  const runtime = createRuntimeHandler(new RuntimeDiagnosticLog(), 'forged', () => {}, undefined, undefined, undefined, f.read)
  vfs.mount('v:runtime', 'diagnostics', runtime.read, runtime.list)
  assert.throws(() => vfs.write('v:runtime/projects/other/sessions', { content: 'write' }, context), /read-only/)
  assert.throws(() => vfs.resolve('v:sessions/other', context), /Unknown/)
  assert.throws(() => vfs.resolve('v:memory/other', context), /Unknown/)
  assert.throws(() => vfs.list('v:runtime/projects', context), /do not support search/)
  assert.equal(f.reads.length, 0)
})

test('in-flight revocation discards result', async () => {
  const f = fixture()
  f.host.lookup = id => id === 'other' ? { scope: f.target, read: () => { f.env.NODE_ENV = 'production'; return 'secret' } } : undefined
  await assert.rejects(f.source.run(() => f.read('other/runtime/logs', context)), /bound default/)
})

test('read entry dispatch and closed target fail without target startup', async () => {
  const f = fixture(), vfs = new VirtualFs()
  const runtime = createRuntimeHandler(new RuntimeDiagnosticLog(), 'forged', () => {}, undefined, undefined, undefined, f.read)
  vfs.mount('v:runtime', 'diagnostics', runtime.read, runtime.list)
  assert.deepEqual(vfs.prefixes().map(entry => entry.prefix), ['v:runtime'])
  const discovery = await vfs.list('v:runtime', context, { content: true })
  assert.match(JSON.stringify(discovery), /v:runtime\/projects/)
  assert.doesNotMatch(JSON.stringify(discovery), /target data|Other|Offline/)
  assert.deepEqual(f.reads, [])
  assert.throws(() => vfs.resolve('v:debug/projects', context), /Unknown/)
  assert.match((await f.source.run(() => vfs.resolve('v:runtime/projects', context)))!, /v:runtime\/projects\/other/)
  for (const content of [true, false]) {
    assert.throws(() => vfs.list('v:runtime/projects/other', context, { content }), /do not support search/)
  }
  assert.match((await f.source.run(() => vfs.resolve('v:runtime/projects/other/runtime/logs', context)))!, /target data/)
  f.target.close()
  await assert.rejects(f.source.run(() => f.read('other/sessions', context)), /unavailable/)
  assert.equal(f.reads.length, 1)
})
