import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { RemoteExecutor, type RemoteNodeJobDispatcher } from '../execution/remote-executor.ts'
import { CopyJobLifetime } from '../execution/copy-job-lifetime.ts'
import { COPY_CHUNK, COPY_READ, COPY_WRITE } from '../execution/filesystem-copy.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { CopyTool } from '../tools/copy.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ChildNodeConnectionSession } from './child-node-connection-session.ts'
import { NodeConnectionSession } from './node-connection-session.ts'
import { createInMemoryNodeDuplexPair } from './in-memory-node-duplex.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const hello = { protocolMajor: 1 as const, protocolMinor: 2, implementationVersion: 'copy-fixture', features: ['workdir-execution-v2'] }

test('many chunks and repeated cross-Child transfers release Main/Child executor and dispatcher payload history', async t => {
  const { root, folders } = await folderFixture(t)
  const endpoints = new Map<string, { root: string; local: LocalExecutor; remote: RemoteExecutor; main: NodeConnectionSession; executor: ProjectExecutor; callbacks: Map<string, Parameters<RemoteNodeJobDispatcher['dispatchJob']>[1]>; jobs: number }>()
  for (const nodeId of ['a', 'b']) {
    const directory = join(folders, nodeId)
    await mkdir(directory)
    const managed = new ManagedChildWorkdirs(join(root, `managed-${nodeId}`), nodeId, [{ workdirId: 'registered', rootPath: directory }])
    await managed.init()
    const registry = new InMemoryPairingNodeRegistry()
    const auth = { deviceId: `device-${nodeId}`, nodeId, credentialId: `credential-${nodeId}` }
    const now = new Date()
    registry.createOffer('offer', now, new Date(now.getTime() + 60_000))
    registry.presentOffer({ offerId: 'offer', pendingId: 'pending', deviceId: auth.deviceId, nodeId, deviceIdentityFingerprint: 'fingerprint', displayName: nodeId }, now)
    registry.approve({ pendingId: 'pending', expectedDeviceIdentityFingerprint: 'fingerprint', credentialId: auth.credentialId }, now)
    const pair = createInMemoryNodeDuplexPair()
    const callbacks = new Map<string, Parameters<RemoteNodeJobDispatcher['dispatchJob']>[1]>()
    const advertised = Promise.withResolvers<void>()
    const main = new NodeConnectionSession(registry, pair.server, hello, {
      maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000,
      onRegistryMutation: () => { if (registry.listWorkdirs(nodeId).length) advertised.resolve() },
      onJobEvent: event => {
        const callback = callbacks.get(event.jobId)
        // Same terminal/disconnect ownership as the production WebSocket dispatcher.
        if ('receipt' in event) callbacks.delete(event.jobId)
        callback?.onEvent(event)
      },
    })
    const local = new LocalExecutor({ spawn: () => { throw new Error('No shell transfer') } }, nodeId, managed.operationHandlers, (r, s) => managed.assertCanExecute(r, s))
    const child = new ChildNodeConnectionSession(pair.client, hello, auth, local, { maxOutboundQueue: 8, heartbeatTimeoutMs: 30_000 })
    const mainRun = main.run(), childRun = child.run()
    t.after(async () => {
      await child.close({ code: 'test-complete', reason: 'complete', clean: true })
      await Promise.all([mainRun, childRun])
    })
    await child.authenticated
    for (const workdir of managed.workdirs) child.advertiseWorkdir(workdir)
    await advertised.promise
    const remote = new RemoteExecutor({
      dispatchJob(request, callback) {
        callbacks.set(request.jobId, callback)
        try { main.dispatchJob(request) } catch (error) { callbacks.delete(request.jobId); throw error }
      },
      dispatchCancellation: (_node, id) => main.dispatchCancellation(id),
    })
    void main.closed.then(info => {
      for (const [id, callback] of callbacks) { callbacks.delete(id); callback.onDisconnect(info.reason) }
    })
    const endpoint = { root: directory, local, remote, main, callbacks, jobs: 0,
      executor: new ProjectExecutor('copy-project', remote, request => {
        assert.equal(request.nodeId, nodeId); assert.equal(request.workdirId, 'registered')
        assert.equal(request.operation, nodeId === 'a' ? COPY_READ : COPY_WRITE)
      }) }
    const original = remote.dispatcher.dispatchJob
    remote.dispatcher.dispatchJob = (request, callback) => { endpoint.jobs++; original(request, callback) }
    endpoints.set(nodeId, endpoint)
  }
  const context = { sessionId: 'copy-session', physicalSessionId: 'physical', projectId: 'copy-project', signal: AbortSignal.timeout(30_000), tools: {},
    async resolveToolTarget(selector: string) {
      const target = endpoints.get(selector)
      if (!target) throw new Error('No fallback')
      return { remoteWorkdir: { nodeId: selector, workdirId: 'registered', executor: target.executor }, fileChangeTarget: { nodeId: selector, workdirId: 'registered' } }
    },
  } as unknown as ExecutionContext
  const bytes = randomBytes(COPY_CHUNK * 20 + 17)
  await writeFile(join(endpoints.get('a')!.root, 'binary'), bytes)
  for (let transfer = 0; transfer < 8; transfer++) {
    const result = await new CopyTool().execute({ source_workspace: 'a', source_path: 'binary', destination_workspace: 'b', destination_path: `copied-${transfer}` }, context)
    assert.match(result, /Copy completed/)
    assert.deepEqual(await readFile(join(endpoints.get('b')!.root, `copied-${transfer}`)), bytes)
    for (const target of endpoints.values()) {
      for (const holder of [target.local, target.remote, target.main]) {
        assert.equal(holder.copyJobRetention.payloadJobs, 0)
        assert.equal(holder.copyJobRetention.activeJobs, 0)
        assert(holder.copyJobRetention.recentJobIds <= 128)
      }
      assert.equal(target.callbacks.size, 0)
      assert.equal(target.executor.hasPendingJobs, false)
    }
  }
  for (const target of endpoints.values()) {
    assert(target.jobs > 128)
    assert.equal(target.remote.copyJobRetention.recentJobIds, 128)
    assert.equal(target.local.copyJobRetention.recentJobIds, 128)
    assert.equal(target.main.copyJobRetention.recentJobIds, 128)
  }
})

test('copy lifecycle limits concurrent payloads and recent replay guards without retaining arguments', () => {
  const lifetime = new CopyJobLifetime()
  for (let i = 0; i < 64; i++) lifetime.admit(`active-${i}`, {})
  assert.throws(() => lifetime.admit('overflow', {}), /Too many/)
  for (let i = 0; i < 64; i++) lifetime.finish(`active-${i}`)
  assert.throws(() => lifetime.admit('active-63', {}), /cannot be replayed/)
  assert.throws(() => lifetime.admit('huge', { data: 'x'.repeat(1024 * 1024) }), /bounded size/)
  for (let i = 0; i < 512; i++) { lifetime.admit(`job-${i}`, {}); lifetime.finish(`job-${i}`) }
  assert.deepEqual(lifetime.counts, { activeJobs: 0, recentJobIds: 128 })
})

function copyRequest(): ExecutionRequestV2 {
  const id = randomUUID(), now = new Date()
  return { version: 2, jobId: id, idempotencyKey: id, sessionId: 'session', turnId: 'turn', nodeId: 'child', workdirId: 'registered', projectScope: '0'.repeat(32), operation: COPY_READ, args: { action: 'chunk', path: 'file', offset: 0 }, createdAt: now.toISOString(), deadlineAt: new Date(now.getTime() + 60_000).toISOString() }
}

test('copy RPC cancellation, disconnect, dispatch refusal and excessive output release retained payloads', async () => {
  for (const mode of ['cancel', 'disconnect', 'reject', 'output-limit']) {
    let cancellations = 0
    const executor = new RemoteExecutor({
      dispatchJob(request, callbacks) {
        if (mode === 'cancel') throw new Error('Pre-cancelled jobs must not dispatch')
        if (mode === 'reject') throw new Error('dispatch refused')
        if (mode === 'disconnect') { callbacks.onDisconnect('connection lost'); return }
        callbacks.onEvent({ version: 1, jobId: request.jobId, sequence: 0, timestamp: request.createdAt, type: 'accepted' })
        for (let i = 1; i < 32; i++) callbacks.onEvent({ version: 1, jobId: request.jobId, sequence: i, timestamp: request.createdAt, type: 'stdout', chunk: 'x'.repeat(COPY_CHUNK) })
      },
      dispatchCancellation() { cancellations++ },
    })
    const request = copyRequest(), controller = new AbortController()
    if (mode === 'cancel') controller.abort()
    const events = await Array.fromAsync(executor.execute(request, controller.signal))
    assert('receipt' in events.at(-1)!)
    assert.notEqual((events.at(-1)! as { receipt: { state: string } }).receipt.state, 'completed')
    assert.equal(await executor.getStatus(request.jobId), null)
    assert.deepEqual(executor.copyJobRetention, { activeJobs: 0, recentJobIds: 1, payloadJobs: 0 })
    assert.throws(() => executor.execute(request, new AbortController().signal), /cannot be replayed/)
    if (mode === 'output-limit') {
      assert.equal(cancellations, 1)
      assert(events.filter(event => event.type === 'stdout').reduce((n, event) => n + (event.type === 'stdout' ? event.chunk.length : 0), 0) <= 1024 * 1024)
      assert.match((events.at(-1)! as { receipt: { reason: { message: string } } }).receipt.reason.message, /bounded/)
    }
  }
  const local = new LocalExecutor({ spawn: () => { throw new Error('Unused') } }, 'child', [{ handles: op => op === COPY_READ, execute: async () => { throw new Error('handler failure') } }], () => {})
  for (const cancel of [true, false]) {
    const request = copyRequest(), controller = new AbortController()
    if (cancel) controller.abort()
    const events = await Array.fromAsync(local.execute(request, controller.signal))
    assert('receipt' in events.at(-1)!)
    assert.equal(await local.getStatus(request.jobId), null)
    assert.equal(local.copyJobRetention.payloadJobs, 0)
    assert.equal(local.copyJobRetention.activeJobs, 0)
    assert.throws(() => local.execute(request, new AbortController().signal), /cannot be replayed/)
  }
})
