import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdir, writeFile, readFile, readdir, symlink, lstat, unlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import type { Executor } from '../execution/executor.ts'
import type { ExecutionContext } from './context.ts'
import { CopyTool } from './copy.ts'
import { COPY_CHUNK, COPY_READ, COPY_WRITE, executeCopyFilesystem, parseCopyManifest } from '../execution/filesystem-copy.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import { assertExecutionSupported } from '../execution/workdir-contracts.ts'

async function fixture(t: TestContext) {
  const { root, workspace } = await folderFixture(t)
  const roots = { main: workspace, a: join(root, 'a'), b: join(root, 'b') }
  await mkdir(roots.a); await mkdir(roots.b)
  const requests: ExecutionRequestV2[] = []
  const executors: Record<string, Executor> = {}
  let hook: ((request: ExecutionRequestV2) => void) | undefined
  for (const nodeId of ['a', 'b'] as const) {
    const managed = new ManagedChildWorkdirs(join(root, `managed-${nodeId}`), nodeId, [{ workdirId: 'registered', rootPath: roots[nodeId] }])
    await managed.init()
    const local = new LocalExecutor(new ProcessManager(), nodeId, managed.operationHandlers, (r, s) => managed.assertCanExecute(r, s))
    executors[nodeId] = new ProjectExecutor('copy-project', local, request => {
      assert.equal(request.nodeId, nodeId)
      assert.equal(request.workdirId, 'registered')
      requests.push(structuredClone(request)); hook?.(request)
    })
  }
  const resolves: string[] = []
  const controller = new AbortController()
  const context = { sessionId: 'copy-session', physicalSessionId: 'physical', projectId: 'copy-project', signal: controller.signal, tools: {},
    // Deliberately wrong inherited locality: must never be used.
    cwd: join(root, 'nonexistent-main-fallback'),
    async resolveToolTarget(selector: string, operation: string) {
      resolves.push(`${selector}:${operation}`)
      if (selector === 'main') return { cwd: roots.main, fileChangeTarget: { nodeId: 'local', workdirId: 'main' } }
      if (!(selector in executors)) throw new Error('Workspace unavailable; no fallback')
      return { remoteWorkdir: { nodeId: selector, workdirId: 'registered', executor: executors[selector]! }, fileChangeTarget: { nodeId: selector, workdirId: 'registered' } }
    },
  } as unknown as ExecutionContext
  const copy = (source_workspace: string, source_path: string, destination_workspace: string, destination_path: string) => new CopyTool().execute({ source_workspace, source_path, destination_workspace, destination_path }, context)
  return { roots, requests, resolves, controller, context, copy, executors, setHook(value: typeof hook) { hook = value } }
}

test('Main↔Child and actual two-Child executor relay: binary, multi-chunk, empty files and nested empty directories', async t => {
  const f = await fixture(t)
  const bytes = randomBytes(COPY_CHUNK * 2 + 19)
  await mkdir(join(f.roots.a, 'tree', 'nested', 'empty'), { recursive: true })
  await writeFile(join(f.roots.a, 'tree', 'binary'), bytes)
  await writeFile(join(f.roots.a, 'tree', 'zero'), '')
  assert.match(await f.copy('a', 'tree', 'b', 'copied'), /completed/)
  assert.deepEqual(await readFile(join(f.roots.b, 'copied', 'binary')), bytes)
  assert((await lstat(join(f.roots.b, 'copied', 'nested', 'empty'))).isDirectory())
  assert.equal((await readFile(join(f.roots.b, 'copied', 'zero'))).length, 0)
  assert.match(await f.copy('b', 'copied/binary', 'main', 'from-child'), /completed/)
  assert.match(await f.copy('main', 'from-child', 'a', 'from-main'), /completed/)
  assert.deepEqual(await readFile(join(f.roots.a, 'from-main')), bytes)
  assert.deepEqual(await readFile(join(f.roots.a, 'tree', 'binary')), bytes)
  assert(f.requests.some(r => r.nodeId === 'a' && r.operation === COPY_READ))
  assert(f.requests.some(r => r.nodeId === 'b' && r.operation === COPY_WRITE))
  assert(f.requests.every(r => Buffer.byteLength(JSON.stringify(r.args)) < 512 * 1024))
  assert(!(await readdir(f.roots.b)).some(n => n.startsWith('.shadow-copy-')))
  assert(f.resolves.includes('a:filesystem.read')); assert(f.resolves.includes('b:filesystem.write'))
})

test('empty whole-workspace and local↔local copies', async t => {
  const f = await fixture(t)
  await f.copy('a', '', 'main', 'empty-workspace')
  assert.deepEqual(await readdir(join(f.roots.main, 'empty-workspace')), [])
  await writeFile(join(f.roots.main, 'file'), 'text')
  await f.copy('main', 'file', 'main', 'another')
  assert.equal(await readFile(join(f.roots.main, 'another'), 'utf8'), 'text')
})

test('collision never overwrites; traversal, special/portable paths, symlinks denied', async t => {
  const f = await fixture(t)
  await writeFile(join(f.roots.a, 'source'), 'source')
  await writeFile(join(f.roots.b, 'exists'), 'keep')
  await assert.rejects(f.copy('a', 'source', 'b', 'exists'), /already exists/)
  assert.equal(await readFile(join(f.roots.b, 'exists'), 'utf8'), 'keep')
  for (const path of ['../escape', '/absolute', 'x/../../escape', 'x\\escape', 'C:escape', 'CON', 'trailing.']) {
    await assert.rejects(f.copy('a', path, 'b', 'new'))
    await assert.rejects(f.copy('a', 'source', 'b', path))
  }
  await symlink(f.roots.a, join(f.roots.b, 'link'), 'junction')
  await assert.rejects(f.copy('a', 'source', 'b', 'link/new'))
  await symlink(join(f.roots.a, 'source'), join(f.roots.a, 'link-file'))
  await assert.rejects(f.copy('a', 'link-file', 'b', 'new'))
  await mkdir(join(f.roots.a, 'tree'))
  await symlink(f.roots.b, join(f.roots.a, 'tree', 'link'), 'junction')
  await assert.rejects(f.copy('a', 'tree', 'b', 'new'))
  assert(!(await readdir(f.roots.b)).includes('new'))
})

test('independent host resolution fails closed; raw device/LayerFS and recovery do not execute', async t => {
  const f = await fixture(t)
  await writeFile(join(f.roots.a, 'file'), 'data')
  await assert.rejects(f.copy('a', 'file', 'offline', 'new'), /unavailable/)
  assert.equal(f.requests.length, 0)
  for (const selector of ['device:b', 'layerfs:branch']) await assert.rejects(f.copy('a', 'file', selector, 'new'), /forbidden/)
  await assert.rejects(new CopyTool().execute({ source_workspace: 'a', source_path: 'file', destination_workspace: 'b', destination_path: 'new' }, { ...f.context, recoveringToolCall: true }), /not replayed/)
  assert.equal(f.requests.length, 0)
  const context = { ...f.context, resolveToolTarget: async () => ({ layerfsWorkdir: { workspace: 'layerfs:branch' }, fileChangeTarget: { nodeId: 'b', workdirId: 'branch' } }) }
  await assert.rejects(new CopyTool().execute({ source_workspace: 'a', source_path: 'file', destination_workspace: 'b', destination_path: 'new' }, context), /not a registered/)
})

test('cancel during chunk relay cleans staging without deleting source or creating destination', async t => {
  const f = await fixture(t)
  await writeFile(join(f.roots.a, 'file'), randomBytes(COPY_CHUNK + 1))
  f.setHook(r => { if (r.operation === COPY_WRITE && (r.args as { action: string }).action === 'chunk') f.controller.abort() })
  await assert.rejects(f.copy('a', 'file', 'b', 'new'), /Publication was not requested/)
  assert.deepEqual(await readdir(f.roots.b), [])
  assert((await lstat(join(f.roots.a, 'file'))).isFile())
})

test('failure before publication removes staging; lost commit receipt is honestly unknown', async t => {
  const f = await fixture(t)
  await writeFile(join(f.roots.a, 'file'), 'payload')
  f.setHook(r => { if (r.operation === COPY_WRITE && (r.args as { action: string }).action === 'chunk') throw new Error('connection lost') })
  await assert.rejects(f.copy('a', 'file', 'b', 'new'), /Publication was not requested.*Private staging removed/)
  assert.deepEqual(await readdir(f.roots.b), [])
  f.setHook(r => { if (r.operation === COPY_WRITE && (r.args as { action: string }).action === 'commit') throw new Error('connection lost') })
  await assert.rejects(f.copy('a', 'file', 'b', 'new'), /Publication started.*partial or complete/)
  assert.deepEqual(await readdir(f.roots.b), [])
})

test('bounded manifest validation, stage owner binding, sequential chunks and integrity checks', async t => {
  const { roots } = await fixture(t)
  const signal = new AbortController().signal
  const call = (owner: string, args: unknown) => executeCopyFilesystem(roots.b, owner, COPY_WRITE, args, signal)
  const entries = [{ path: '', kind: 'file', size: 1, hash: '0'.repeat(64) }]
  for (const value of [[], new Array(2049).fill(entries[0]), [{ ...entries[0], size: 2 ** 40 }], [{ ...entries[0], path: '../x' }], [{ ...entries[0], kind: 'directory' }]]) assert.throws(() => parseCopyManifest(value))
  const { id } = JSON.parse(await call('owner', { action: 'begin', path: 'new', entries }))
  await assert.rejects(call('other-owner', { action: 'abort', id }))
  await assert.rejects(call('owner', { action: 'chunk', id, path: '', offset: 1, data: 'eA==' }))
  await call('owner', { action: 'chunk', id, path: '', offset: 0, data: 'eA==' })
  await assert.rejects(call('owner', { action: 'commit', id }), /integrity/)
  await call('owner', { action: 'abort', id })
  assert.deepEqual(await readdir(roots.b), [])
})

test('lost terminal receipt after real publication reports unknown and retains destination', async t => {
  const f = await fixture(t)
  await writeFile(join(f.roots.a, 'file'), 'payload')
  const executor = f.executors.b!
  f.executors.b = {
    getStatus: id => executor.getStatus(id), cancel: id => executor.cancel(id),
    async *execute(request, signal) {
      const commit = request.operation === COPY_WRITE && (request.args as { action: string }).action === 'commit'
      for await (const event of executor.execute(request, signal)) {
        if (commit && 'receipt' in event) throw new Error('receipt lost after publication')
        yield event
      }
    },
  }
  await assert.rejects(f.copy('a', 'file', 'b', 'new'), /Publication started.*partial or complete.*cleanup unconfirmed/)
  assert.equal(await readFile(join(f.roots.b, 'new'), 'utf8'), 'payload')
  assert.equal(await readFile(join(f.roots.a, 'file'), 'utf8'), 'payload')
})

test('cancellation during directory publication preserves truthful partial output; cleanup removes only staging', async t => {
  const { roots } = await fixture(t)
  const normal = new AbortController().signal
  const entries = [{ path: '', kind: 'directory', size: 0, hash: '' }, { path: 'empty', kind: 'directory', size: 0, hash: '' }]
  const { id } = JSON.parse(await executeCopyFilesystem(roots.b, 'owner', COPY_WRITE, { action: 'begin', path: 'partial', entries }, normal))
  let checks = 0
  const interrupt = { throwIfAborted() { if (++checks === 5) throw new Error('cancel publication') } } as AbortSignal
  // admission + two integrity loop checks + first mkdir + interruption before second mkdir
  await assert.rejects(executeCopyFilesystem(roots.b, 'owner', COPY_WRITE, { action: 'commit', id }, interrupt), /cancel publication/)
  assert((await lstat(join(roots.b, 'partial'))).isDirectory())
  await executeCopyFilesystem(roots.b, 'owner', COPY_WRITE, { action: 'abort', id }, normal)
  assert.deepEqual(await readdir(roots.b), ['partial'])
  assert.deepEqual(await readdir(join(roots.b, 'partial')), [])
})

test('special files are rejected without opening a blocking FIFO', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const result = spawnSync('mkfifo', [join(f.roots.a, 'pipe')])
  assert.equal(result.status, 0)
  await assert.rejects(f.copy('a', 'pipe', 'b', 'new'), /denied/)
  assert.deepEqual(await readdir(f.roots.b), [])
})

test('staging-file replacement cannot overwrite another file', async t => {
  const { roots } = await fixture(t)
  const signal = new AbortController().signal
  const call = (args: unknown) => executeCopyFilesystem(roots.b, 'owner', COPY_WRITE, args, signal)
  await writeFile(join(roots.b, 'sentinel'), 'keep')
  const { id } = JSON.parse(await call({ action: 'begin', path: 'new', entries: [{ path: '', kind: 'file', size: 1, hash: '0'.repeat(64) }] }))
  const stage = (await readdir(roots.b)).find(name => name.startsWith('.shadow-copy-'))!
  const file = join(roots.b, stage, '0')
  await unlink(file)
  await link(join(roots.b, 'sentinel'), file)
  await assert.rejects(call({ action: 'chunk', id, path: '', offset: 0, data: 'eA==' }), /denied/)
  await call({ action: 'abort', id })
  assert.equal(await readFile(join(roots.b, 'sentinel'), 'utf8'), 'keep')
  assert.deepEqual(await readdir(roots.b), ['sentinel'])
})

test('old Child text support cannot authorize the new binary copy operations', () => {
  const workdir = { version: 2 as const, nodeId: 'old-child', workdirId: 'registered', displayName: 'Old Child', online: true, support: { operations: ['filesystem.read', 'filesystem.write'] } }
  for (const operation of [COPY_READ, COPY_WRITE]) {
    assert.throws(() => assertExecutionSupported({ nodeId: 'old-child', workdirId: 'registered', operation, args: {}, createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() }, [workdir], { operations: [] }), /No live support/)
  }
})
