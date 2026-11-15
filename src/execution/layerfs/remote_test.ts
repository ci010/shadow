import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionContext } from '../../tools/context.ts'
import type { ExecutionRequestV2 } from '../contracts.ts'
import { layerFSPayloadHash, validateRemoteLayerFSCall, LAYERFS_REMOTE_OPERATION, type RemoteLayerFSCall } from './remote-contract.ts'
import { hasLayerFSHostAuthority, withLayerFSHostAuthority, verifyLayerFSHostApproval } from './host-authority.ts'
import { RemoteLayerFSService } from './remote-service.ts'
import { RemoteLayerFSClient } from './remote-client.ts'
import { remoteLayerFSLeaseFactory } from './remote-lease.ts'
import { remoteLayerFSOwnerVerifier } from './remote-owner.ts'
import { remoteLayerFSTargetQuestion } from './remote-contract.ts'
import type { YieldDecisionRecord, YieldQuestion } from '../../sessions/yield-contract.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import { LocalExecutor } from '../local-executor.ts'
import { ProcessManager } from '../processes/manager.ts'
import { managedProjectScope } from '../managed-workdir.ts'
import { RemoteLayerFSConsentPlans } from './remote-consent.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { RemoteLayerFSGateway } from './remote-gateway.ts'

const target = { nodeId: 'windows', pairingId: 'pairing-one', projectScope: 'a'.repeat(32) }
function call(action: RemoteLayerFSCall['action'] = 'runtime_start', input: Record<string, unknown> = { runtimeId: 'one' }): RemoteLayerFSCall {
  return { version: 1, action, input, authority: { version: 1, ...target, actorId: 'owner', kind: 'direct-owner', ownerSessionId: 'web:owner', requestId: randomUUID(),
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
  const client = new RemoteLayerFSClient(target, { assertCanExecute: async () => { throw new Error('offline') }, execute: async function* () { runs++ }, getStatus: async () => null, cancel: async () => { throw new Error('unused') } }, async () => ({ actorId: 'owner', authorityKind: 'direct-owner' }))
  await assert.rejects(client.call('runtime_start', {}, context), /offline/)
  assert.equal(runs, 0)
  const lost = new RemoteLayerFSClient(target, { execute: async function* () { runs++; throw new Error('connection lost') }, getStatus: async () => null, cancel: async () => { throw new Error('unused') } }, async () => ({ actorId: 'owner', authorityKind: 'direct-owner' }))
  await assert.rejects(lost.call('runtime_start', {}, context), /outcome unknown/)
  assert.equal(runs, 1)
})

test('launcher lease is separate, bounded and cannot survive disconnect/re-pair/revoke/expiry', () => {
  const admitted = call('runtime_context')
  let connection = { online: true, epoch: 1, pairingId: target.pairingId }, clock = Date.now()
  const factory = remoteLayerFSLeaseFactory(admitted, () => connection, () => clock, 1000)
  const binding = { projectId: target.projectScope, runtimeId: 'one', sourceRoot: '/sources', installationFingerprint: 'fixed-installation' }
  assert.throws(() => factory({ ...binding, projectId: 'other' }), /mismatch/)
  const lease = factory(binding)
  lease.assert()
  connection = { ...connection, online: false }
  assert.throws(() => lease.assert(), /connection changed/)
  connection = { ...connection, online: true }
  assert.throws(() => lease.assert(), /revoked/)
  const second = remoteLayerFSLeaseFactory(admitted, () => connection, () => clock, 1000)(binding)
  connection = { ...connection, epoch: 2 }
  assert.throws(() => second.assert(), /connection changed/)
  const third = remoteLayerFSLeaseFactory(admitted, () => connection, () => clock, 1000)(binding)
  connection = { ...connection, pairingId: 'new-pairing' }
  assert.throws(() => third.assert(), /connection changed/)
  connection = { ...connection, pairingId: target.pairingId }
  const fourth = remoteLayerFSLeaseFactory(admitted, () => connection, () => clock, 1000)(binding)
  clock += 1001
  assert.throws(() => fourth.assert(), /expired/)
  const fifth = remoteLayerFSLeaseFactory(admitted, () => connection, () => clock, 1000)(binding)
  fifth.revoke()
  assert.throws(() => fifth.assert(), /revoked/)
})

test('Main requires actual non-invalidated human record and Child exact canonical target plan; flags do not authorize', async () => {
  const target = { nodeId: 'windows', pairingId: 'pairing-one', projectScope: managedProjectScope('main') }
  const reference = { sessionId: 'web:owner', physicalId: 'physical', requestId: 'decision' }
  const question: YieldQuestion = { question: 'Install the pinned worker. Plan one.', options: ['Approve exact plan.', 'Do not install.'], defaultOption: 'Approve exact plan.' }
  const targetQuestion = { ...question, question: remoteLayerFSTargetQuestion(target.nodeId, target.projectScope, 'one', question.question) }
  const records: YieldDecisionRecord[] = [{ request: { ...targetQuestion, id: reference.requestId, sessionId: reference.sessionId, recipient: { kind: 'user', sessionId: reference.sessionId }, createdAt: new Date().toISOString(), deadline: null, origin: { physicalId: reference.physicalId } }, answer: { requestId: reference.requestId, option: question.options[0], answeredBy: 'user', answeredAt: new Date().toISOString() } }]
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId: 'main', sessionId: reference.sessionId, senderId: 'actual-human', channel: 'web', admin: true, isGroup: false, tools, signal: AbortSignal.timeout(10000) } as ExecutionContext
  const state = { projectId: 'main', sessionId: reference.sessionId } as SessionState
  const consent = new RemoteLayerFSConsentPlans('main')
  consent.remember(target, context, { ok: true, result: { plan: 'one', approvalRequest: { ...targetQuestion, default_option: targetQuestion.defaultOption } } })
  const verify = remoteLayerFSOwnerVerifier({ projectId: 'main', consent, state: () => state, assertFolderAccess: () => {}, records: async () => records })
  const input = { plan: 'one', approval: reference, approved: true, allowRootWorker: true, allowDownloads: true }
  const owner = await verify(context, target, 'bootstrap', input)
  assert.equal(owner.actorId, 'actual-human')
  const admitted = call('bootstrap', input as unknown as { runtimeId: string }); admitted.authority.projectScope = target.projectScope; admitted.authority.approval = owner.approval
  await withLayerFSHostAuthority(admitted, target, context.signal, async ctx => {
    assert.equal(verifyLayerFSHostApproval(question, reference, ctx), true)
    assert.equal(verifyLayerFSHostApproval({ ...question, question: 'Different pinned plan.' }, reference, ctx), false)
    assert.equal(verifyLayerFSHostApproval(question, { ...reference, requestId: 'unrelated' }, ctx), false)
  })
  await assert.rejects(verify(context, { ...target, nodeId: 'other' }, 'bootstrap', input), /canonical target/)
  await assert.rejects(verify(context, target, 'bootstrap', { ...input, plan: 'two' }), /canonical target/)
  records[0]!.answer!.answeredBy = 'parent'
  await assert.rejects(verify(context, target, 'bootstrap', input), /Recorded human/)
  records[0]!.answer!.answeredBy = 'user'
  records[0]!.closed = { at: new Date().toISOString(), reason: 'invalidated', message: 'fixture invalidation' }
  await assert.rejects(verify(context, target, 'bootstrap', input), /Recorded human/)
  await assert.rejects(verify({ ...context, projectId: 'foreign' }, target, 'runtime_start', {}), /current-Project/)
  await assert.rejects(verify({ ...context, tools: { ...tools, executionMode: 'task' } }, target, 'runtime_start', {}), /durable owner/)
})

test('LocalExecutor keeps schema/authority refusal no-effect, but dispatched LayerFS throw/cancel/deadline unknown without replay', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-outcome-'))
  try {
    for (const mode of ['throw', 'cancel', 'deadline'] as const) {
      let effects = 0
      const began = Promise.withResolvers<void>()
      const service = new RemoteLayerFSService({ ...target, directory: join(directory, mode), authorize: async (_r, c) => { if (c.authority.actorId !== 'owner') throw new Error('actor denied') }, dispatch: async (_c, context) => {
        effects++; began.resolve()
        if (mode === 'throw') throw new Error('lost receipt after effect')
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { checkpoint: 'saved' } // timeout/cancel still cannot claim rollback
      } })
      const executor = new LocalExecutor(new ProcessManager(), target.nodeId, [service], (r, s) => service.admit(r, s).then(() => {}))
      const malformed = call(); malformed.input = {}; malformed.authority.payloadHash = layerFSPayloadHash(malformed.action, malformed.input)
      const rejected = []
      for await (const event of executor.execute(request(malformed), AbortSignal.timeout(10000))) rejected.push(event)
      assert.equal(rejected.at(-1)?.type, 'rejected')
      assert.equal(effects, 0)
      const foreign = call(); foreign.authority.actorId = 'attacker'
      await assert.rejects(executor.assertCanExecute(request(foreign), AbortSignal.timeout(10000)), /actor denied/)
      assert.equal(effects, 0)
      const req = request()
      if (mode === 'deadline') req.deadlineAt = new Date(Date.now() + 1000).toISOString()
      const collecting = (async () => { const events = []; for await (const event of executor.execute(req, AbortSignal.timeout(10000))) events.push(event); return events })()
      await began.promise
      if (mode === 'cancel') await executor.cancel(req.jobId)
      const events = await collecting
      const terminal = events.at(-1)!
      assert.equal(terminal.type, 'failed')
      assert.equal('receipt' in terminal && terminal.receipt.reason?.code, 'execution-outcome-unknown')
      assert.equal('receipt' in terminal && terminal.receipt.reason?.retryable, false)
      assert.equal(effects, 1)
      if (mode === 'throw') await assert.rejects(service.execute(req, AbortSignal.timeout(10000)), /already admitted/)
      else assert.deepEqual(JSON.parse(await service.execute(req, AbortSignal.timeout(10000))), { checkpoint: 'saved' })
      assert.equal(effects, 1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('LocalExecutor opt-in uncertainty leaves ordinary handler rejection and successful receipts unchanged', async () => {
  for (const fail of [false, true]) {
    const executor = new LocalExecutor(new ProcessManager(), target.nodeId, [{ handles: op => op === 'filesystem.read', execute: async () => { if (fail) throw new Error('ordinary refusal'); return '{"ok":true}' } }], async () => {})
    const req = { ...request(), workdirId: 'fixture', operation: 'filesystem.read', args: {} }
    const events = []
    for await (const event of executor.execute(req, AbortSignal.timeout(10000))) events.push(event)
    assert.equal(events.at(-1)?.type, fail ? 'rejected' : 'completed')
  }
})

test('LayerFS authority revoked between executor preflight and handler admission remains proven no-effect', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-admission-'))
  try {
    let checks = 0, effects = 0
    const service = new RemoteLayerFSService({ ...target, directory, authorize: async () => { if (++checks > 1) throw new Error('authority revoked') }, dispatch: async () => { effects++; return {} } })
    const executor = new LocalExecutor(new ProcessManager(), target.nodeId, [service], (r, s) => service.admit(r, s).then(() => {}))
    const events = []
    for await (const event of executor.execute(request(), AbortSignal.timeout(10000))) events.push(event)
    const terminal = events.at(-1)!
    assert.equal(terminal.type, 'rejected')
    assert.equal('receipt' in terminal && terminal.receipt.reason?.code, 'layerfs-admission-denied')
    assert.equal(effects, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('admitted LayerFS exec streams bounded progress and runs until terminal checkpoint beyond admission deadline', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-until-exit-'))
  try {
    const workspace = branchWorkspace('repo', 'branch', { ownerProject: target.projectScope, runtimeId: 'runtime', resourceId: randomUUID() })
    const service = new RemoteLayerFSService({ ...target, directory, authorize: async () => {}, dispatch: async (_call, context, observe) => {
      observe?.('live progress\n')
      observe?.('x'.repeat(200000)); observe?.('must-not-emit-after-cap')
      await new Promise(resolve => setTimeout(resolve, 1100))
      assert.equal(context.signal.aborted, false)
      return { ok: true, result: { code: 7, checkpoint: 'saved' } }
    } })
    const executor = new LocalExecutor(new ProcessManager(), target.nodeId, [service], (r, s) => service.admit(r, s).then(() => {}))
    const req = request(call('exec', { workspace, command: 'exit 7', captureLimit: 65536 }))
    req.deadlineAt = new Date(Date.now() + 1000).toISOString()
    const events = []
    for await (const event of executor.execute(req, AbortSignal.timeout(10000))) events.push(event)
    assert.equal(events.at(-1)?.type, 'completed')
    const progress = events.filter(event => event.type === 'stderr').map(event => 'chunk' in event ? event.chunk : '').join('')
    assert.equal(progress.length, 131072)
    assert.ok(progress.startsWith('live progress\n'))
    assert.doesNotMatch(progress, /must-not-emit-after-cap/)
    const result = JSON.parse(events.filter(event => event.type === 'stdout').map(event => 'chunk' in event ? event.chunk : '').join(''))
    assert.equal(result.result.code, 7)
    assert.equal(result.result.checkpoint, 'saved')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('workspace-session authority cannot mint management sidecars; verified Project owner can reconcile worker provenance without impersonation', async () => {
  const workspace = branchWorkspace('repo', 'worker', { ownerProject: target.projectScope, runtimeId: 'runtime', resourceId: randomUUID() })
  const ordinary = call('write', { workspace, path: '/README.md', content: 'worker content' })
  ordinary.authority.kind = 'workspace-session'; ordinary.authority.actorId = 'worker-actor'
  await withLayerFSHostAuthority(ordinary, target, AbortSignal.timeout(10000), async context => {
    assert.equal(hasLayerFSHostAuthority(context, 'write'), true)
    assert.equal(hasLayerFSHostAuthority(context), false)
    assert.equal(hasLayerFSHostAuthority(context, 'runtime_start'), false)
  })
  const management = call(); management.authority.kind = 'workspace-session'
  assert.throws(() => validateRemoteLayerFSCall(management, target), /direct-owner/)
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-remote-actor-'))
  try {
    const service = new RemoteLayerFSService({ ...target, directory, authorize: async () => {}, dispatch: async () => ({ checkpoint: 'saved' }) })
    await service.execute(request(ordinary), AbortSignal.timeout(10000))
    const inspect = call('reconcile', { requestId: ordinary.authority.requestId })
    inspect.authority.kind = 'workspace-session'
    await assert.rejects(service.execute(request(inspect), AbortSignal.timeout(10000)), /direct-owner/)
    inspect.authority.kind = 'direct-owner'
    const receipt = JSON.parse(await service.execute(request(inspect), AbortSignal.timeout(10000)))
    assert.equal(receipt.actorId, 'worker-actor')
    assert.equal(receipt.authority.kind, 'workspace-session')
    assert.equal(receipt.phase, 'completed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Project-host assertion is typed revocation-only and cannot impersonate a direct owner', async () => {
  const revoke = call('contexts_revoke', {})
  revoke.authority.kind = 'project-host'
  await withLayerFSHostAuthority(revoke, target, AbortSignal.timeout(10000), async context => {
    assert.equal(hasLayerFSHostAuthority(context, 'contexts_revoke'), true)
    assert.equal(hasLayerFSHostAuthority(context), false)
    assert.equal(hasLayerFSHostAuthority(context, 'bootstrap'), false)
  })
  const escalate = call('runtime_start'); escalate.authority.kind = 'project-host'
  assert.throws(() => validateRemoteLayerFSCall(escalate, target), /revocation-only/)
  revoke.authority.kind = 'direct-owner'
  assert.throws(() => validateRemoteLayerFSCall(revoke, target), /Project host service/)
})

test('Main gateway teardown revokes issued or unknown contexts once, rejects stale calls and preserves revocation failure', async () => {
  for (const lost of [false, true]) {
    const projectId = 'gateway-close', selected = { ...target, projectScope: managedProjectScope(projectId) }
    let dispatches = 0, revocations = 0
    const gateway = new RemoteLayerFSGateway({ projectId, folders: () => [], target: () => selected,
      executor: { execute: async function* (request) {
        dispatches++; if (lost) throw Error('context response lost')
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'stdout', chunk: JSON.stringify({ ok: true, result: { launcher: 'target-private-path' } }) }
        yield { version: 1, jobId: request.jobId, sequence: 1, timestamp: new Date().toISOString(), type: 'completed', receipt: { version: 1, jobId: request.jobId, nodeId: selected.nodeId, state: 'completed', finishedAt: new Date().toISOString() } }
      }, getStatus: async () => null, cancel: async () => { throw Error('unused') } },
      verify: async () => ({ actorId: 'owner', authorityKind: 'direct-owner' }), register: async () => { throw Error('unused') }, validateWork: () => {},
      revokeContexts: async targets => { revocations++; assert.deepEqual(targets, [selected]); if (lost) throw Error('revocation receipt lost') },
    })
    const context = { projectId, sessionId: 'web:owner', signal: AbortSignal.timeout(10000), remoteWorkdir: { nodeId: selected.nodeId, workdirId: 'native', executor: {} } } as ExecutionContext
    if (lost) await assert.rejects(gateway.tryCall('runtime_context', { runtimeId: 'r' }, context), /outcome unknown/)
    else await gateway.tryCall('runtime_context', { runtimeId: 'r' }, context)
    const closing = gateway.revokeContexts()
    if (lost) await assert.rejects(closing, /revocation receipt lost/); else await closing
    assert.equal(gateway.revokeContexts(), closing)
    assert.equal(revocations, 1)
    await assert.rejects(gateway.tryCall('runtime_context', { runtimeId: 'r' }, context), /gateway closed/)
    assert.equal(dispatches, 1)
  }
})
