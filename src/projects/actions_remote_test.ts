import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectActions } from './actions.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import type { ProcessManager } from '../execution/processes/manager.ts'
import type { Executor } from '../execution/executor.ts'
import type { ExecutionRequestV2, JobEventV1, ExecutionReceiptV1 } from '../execution/contracts.ts'

async function fixture(executor: Executor) {
  const root = await mkdtemp(join(process.cwd(), '.test-artifacts', 'remote-actions-'))
  const home = join(root, 'home'); await mkdir(home)
  const folder = { id: randomUUID(), kind: 'remote', path: 'C:\\not-on-main', workdir: { version: 2, nodeId: 'child', workdirId: 'root' } }
  let leases = 0
  const folders = { get: (id: string) => id === folder.id ? folder : undefined,
    acquireAccess: () => { leases++; let released = false; return () => { assert.equal(released, false); released = true; leases-- } },
    requireAvailable: () => assert.fail('must not inspect remote path on Main') } as unknown as FolderRegistry
  const actions = new ProjectActions(home, folders, { spawn: () => assert.fail('must not spawn on Main') } as unknown as ProcessManager, false, executor)
  await actions.init()
  return { actions, folder, folders, home, leases: () => leases, close: async () => { await actions.shutdown(); await rm(root, { recursive: true, force: true }) } }
}
const receipt = (r: ExecutionRequestV2, state: ExecutionReceiptV1['state'] = 'completed'): ExecutionReceiptV1 => ({ version: 1, jobId: r.jobId, nodeId: r.nodeId, state, exitCode: 0, finishedAt: new Date().toISOString() })
const event = (r: ExecutionRequestV2, body: object): JobEventV1 => ({ version: 1, jobId: r.jobId, sequence: 0, timestamp: new Date().toISOString(), ...body }) as JobEventV1

test('remote actions persist while offline, route discovery and bounded output to Child, and run in coordinator mode', async t => {
  const requests: ExecutionRequestV2[] = []
  let denied = false
  const f = await fixture({
    assertCanExecute: () => { if (denied) throw new Error('offline; no fallback') },
    async *execute(r) {
      requests.push(r)
      if (r.operation === 'filesystem.read') {
        const path = (r.args as { path: string }).path
        yield event(r, { type: 'stdout', chunk: path === '.' ? 'package.json\npnpm-lock.yaml' : JSON.stringify({ scripts: { test: 'echo test', 'bad&name': 'unsafe' } }) })
      } else {
        yield event(r, { type: 'stdout', chunk: 'x'.repeat(150000) })
        yield event(r, { type: 'stderr', chunk: 'error' })
      }
      yield event(r, { type: 'completed', receipt: receipt(r) })
    }, getStatus: async () => null, cancel: async () => assert.fail('not active'),
  })
  try {
    const action = await f.actions.create({ name: 'remote', command: 'echo child', folderId: f.folder.id })
    await f.actions.patch(action.id, { folderId: f.folder.id, pinned: true })
    const reloaded = new ProjectActions(f.home, f.folders); await reloaded.init(); assert.equal(reloaded.list()[0].pinned, true)
    const scripts = await f.actions.scripts(f.folder.id)
    assert.equal(scripts.packageManager, 'pnpm'); assert.equal(scripts.scripts[0].command, 'pnpm run test'); assert.deepEqual(scripts.unsupportedScripts, ['bad&name'])
    const run = await f.actions.run(action.id)
    await t.waitFor(() => assert(f.actions.getRun(run.id).finishedAt))
    assert.equal(f.actions.getRun(run.id).stdout.length, 128000)
    assert.equal(f.actions.getRun(run.id).stderr, 'error')
    for (const r of requests) { assert.equal(r.nodeId, 'child'); assert.equal(r.workdirId, 'root'); assert.equal(r.sessionId, `folder:${f.folder.id}`); assert(!JSON.stringify(r).includes('C:\\\\not-on-main')) }
    assert.deepEqual(requests.at(-1)?.args, { script: 'echo child', lifetime: 'until-exit' })
    assert.equal(f.leases(), 0)
    denied = true
    await assert.rejects(f.actions.run(action.id), /offline/)
    assert.equal(f.leases(), 0)
  } finally { await f.close() }
})

test('remote cancellation awaits terminal cleanup, including shutdown', async t => {
  let cancel!: () => void, current!: ExecutionRequestV2
  const f = await fixture({
    async *execute(r) {
      current = r
      yield event(r, { type: 'accepted' })
      await new Promise<void>(resolve => { cancel = resolve })
      yield event(r, { type: 'cancel-acknowledged', receipt: receipt(r, 'cancelled') })
    }, getStatus: async () => null,
    async cancel(id) { assert.equal(id, current.jobId); cancel(); return { version: 1, jobId: id, outcome: 'requested', timestamp: new Date().toISOString(), status: null } },
  })
  try {
    const action = await f.actions.create({ name: 'service', command: 'serve', folderId: f.folder.id })
    const run = await f.actions.run(action.id)
    await t.waitFor(() => assert(cancel))
    assert.equal((await f.actions.stop(run.id)).state, 'stopped'); assert.equal(f.leases(), 0)
    await f.actions.run(action.id)
    await f.actions.shutdown(); assert.equal(f.leases(), 0)
  } finally { await f.close() }
})

test('transport loss retains ownership and partial logs until a correlated cancellation receipt', async t => {
  let request!: ExecutionRequestV2, recover = false
  const f = await fixture({
    async *execute(r) { request = r; yield event(r, { type: 'stdout', chunk: 'partial' }); throw new Error('disconnected') },
    getStatus: async () => null,
    async cancel(id) { return { version: 1, jobId: id, outcome: recover ? 'already-terminal' : 'not-found', timestamp: new Date().toISOString(), status: recover ? { version: 1, jobId: id, state: 'cancelled', lastSequence: 1, updatedAt: new Date().toISOString(), receipt: receipt(request, 'cancelled') } : null } },
  })
  try {
    const a = await f.actions.create({ name: 'service', command: 'serve', folderId: f.folder.id })
    const r = await f.actions.run(a.id)
    await t.waitFor(() => assert.match(f.actions.getRun(r.id).stderr, /outcome unknown/))
    assert.equal(f.actions.getRun(r.id).stdout, 'partial'); assert.equal(f.actions.getRun(r.id).finishedAt, undefined); assert.equal(f.leases(), 1)
    await assert.rejects(f.actions.stop(r.id), { code: 'remote_stop_unconfirmed' })
    assert.equal(f.actions.getRun(r.id).state, 'running')
    recover = true
    assert.equal((await f.actions.stop(r.id)).state, 'stopped'); assert.equal(f.leases(), 0)
  } finally { await f.close() }
})

test('remote discovery propagates missing grants and disconnects without local reads', async () => {
  const f = await fixture({
    async *execute() { throw new Error('filesystem.read grant unavailable') },
    getStatus: async () => null, cancel: async () => assert.fail('no command was launched'),
  })
  try {
    await assert.rejects(f.actions.scripts(f.folder.id), /grant unavailable/)
    assert.equal(f.leases(), 0)
    assert.deepEqual(f.actions.runs(), [])
  } finally { await f.close() }
})
