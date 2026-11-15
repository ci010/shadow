import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionContext } from '../../tools/context.ts'
import type { ExecutionRequestV2 } from '../contracts.ts'
import { layerFSPayloadHash, validateRemoteLayerFSCall, LAYERFS_REMOTE_OPERATION, type RemoteLayerFSCall } from './remote-contract.ts'
import { hasLayerFSHostAuthority, withLayerFSHostAuthority } from './host-authority.ts'
import { RemoteLayerFSService } from './remote-service.ts'
import { RemoteLayerFSClient } from './remote-client.ts'

const target = { nodeId: 'windows', pairingId: 'pairing-one', projectScope: 'a'.repeat(32) }
function call(action: RemoteLayerFSCall['action'] = 'runtime_start', input = { runtimeId: 'one' }): RemoteLayerFSCall {
  return { version: 1, action, input, authority: { version: 1, ...target, actorId: 'owner', ownerSessionId: 'web:owner', requestId: randomUUID(),
    action, payloadHash: layerFSPayloadHash(action, input), expiresAt: new Date(Date.now() + 60000).toISOString() } }
}
function request(args = call()): ExecutionRequestV2 {
  const now = Date.now()
  return { version: 2, nodeId: target.nodeId, projectScope: target.projectScope, jobId: randomUUID(), idempotencyKey: randomUUID(), sessionId: 'scoped-session', turnId: 'turn', operation: LAYERFS_REMOTE_OPERATION, args, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 60000).toISOString() }
}
test('LayerFS host assertion binds target/pairing/Project/action/payload and expiry', () => {
  const good = call()
  assert.equal(validateRemoteLayerFSCall(good, target).action, 'runtime_start')
  for (const patch of [{ nodeId: 'other' }, { pairingId: 'other' }, { projectScope: 'b'.repeat(32) }]) assert.throws(() => validateRemoteLayerFSCall(good, { ...target, ...patch }))
  assert.throws(() => validateRemoteLayerFSCall({ ...good, action: 'runtime_plan' }, target))
  assert.throws(() => validateRemoteLayerFSCall({ ...good, input: { runtimeId: 'two' } }, target))
  assert.throws(() => validateRemoteLayerFSCall(good, target, Date.now() + 120000))
  assert.throws(() => validateRemoteLayerFSCall(call('bootstrap'), target), /exact host-verified/)
})
test('LayerFS sidecar refuses wrong action, copied/mutated/reused context', async () => {
  let retained!: ExecutionContext
  await withLayerFSHostAuthority(call(), target, AbortSignal.timeout(10000), async context => {
    retained = context
    assert.equal(hasLayerFSHostAuthority(context, 'runtime_start'), true)
    assert.equal(hasLayerFSHostAuthority(context, 'runtime_plan'), false)
    assert.equal(hasLayerFSHostAuthority({ ...context }), false)
    context.projectId = 'foreign'
    assert.equal(hasLayerFSHostAuthority(context), false)
    context.projectId = target.projectScope
    assert.equal(hasLayerFSHostAuthority(context), true)
  })
  assert.equal(hasLayerFSHostAuthority(retained), false)
})
test('target service durably retains unknown mutation and isolates receipts/Project', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-test-'))
  try {
    let runs = 0
    const service = new RemoteLayerFSService({ ...target, directory, authorize: async () => {}, dispatch: async () => { runs++; throw new Error('lost worker') } })
    const req = request()
    await assert.rejects(service.execute(req, AbortSignal.timeout(10000)), /unknown/)
    await assert.rejects(service.execute(req, AbortSignal.timeout(10000)), /already admitted/)
    assert.equal(runs, 1)
    await assert.rejects(service.execute({ ...req, projectScope: 'b'.repeat(32) }, AbortSignal.timeout(10000)), /mismatch/)
    const query = call('reconcile', { requestId: (req.args as RemoteLayerFSCall).authority.requestId } as unknown as { runtimeId: string })
    const result = JSON.parse(await service.execute(request(query), AbortSignal.timeout(10000)))
    assert.equal(result.phase, 'unknown')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('target service refuses authority before dispatch and reuses only completed exact receipt', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-test-'))
  try {
    let runs = 0
    const service = new RemoteLayerFSService({ ...target, directory, authorize: async (_r, c) => { if (c.authority.actorId !== 'owner') throw new Error('actor denied') }, dispatch: async (_c, context) => { assert.equal(hasLayerFSHostAuthority(context, 'runtime_start'), true); runs++; return { ready: true } } })
    const req = request()
    assert.deepEqual(JSON.parse(await service.execute(req, AbortSignal.timeout(10000))), { ready: true })
    await service.execute(req, AbortSignal.timeout(10000))
    assert.equal(runs, 1)
    const bad = call(); bad.authority.actorId = 'attacker'
    await assert.rejects(service.execute(request(bad), AbortSignal.timeout(10000)), /actor denied/)
    assert.equal(runs, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('client offline admission never dispatches; lost response is unknown with no retry', async () => {
  const context = { sessionId: 'web:owner', signal: AbortSignal.timeout(10000) } as ExecutionContext
  let runs = 0
  const client = new RemoteLayerFSClient(target, { assertCanExecute: async () => { throw new Error('offline') }, execute: async function* () { runs++ }, getStatus: async () => null, cancel: async () => { throw new Error('unused') } }, async () => ({ actorId: 'owner' }))
  await assert.rejects(client.call('runtime_start', {}, context), /offline/)
  assert.equal(runs, 0)
  const lost = new RemoteLayerFSClient(target, { execute: async function* () { runs++; throw new Error('connection lost') }, getStatus: async () => null, cancel: async () => { throw new Error('unused') } }, async () => ({ actorId: 'owner' }))
  await assert.rejects(lost.call('runtime_start', {}, context), /outcome unknown/)
  assert.equal(runs, 1)
})
