import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Executor } from '../execution/executor.ts'
import type { ExecutionRequestV2, JobStatusV1 } from '../execution/contracts.ts'
import { managedProjectScope, projectExecutionKey } from '../execution/managed-workdir.ts'
import { ProjectExecutor } from './executor.ts'

function request(overrides: Partial<ExecutionRequestV2> = {}): ExecutionRequestV2 {
  return { version: 2, jobId: 'same-job', sessionId: 'web:same', turnId: 'same-turn', idempotencyKey: 'same-key',
    nodeId: 'child', workdirId: 'folder', operation: 'filesystem.read', args: {},
    createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10000).toISOString(), ...overrides }
}
const authorize = (_projectId: string) => (value: ExecutionRequestV2): void => {
  if (value.workdirId === undefined || value.workdirId !== 'folder' || value.operation !== 'filesystem.read') {
    throw new Error('project access denied')
  }
}

test('same logical session and job IDs have disjoint remote execution and cancel authority', async () => {
  const requests: ExecutionRequestV2[] = []
  const cancelled: string[] = []
  const statuses = new Map<string, JobStatusV1>()
  const executor: Executor = {
    async *execute(value) {
      requests.push(value)
      const status: JobStatusV1 = { version: 1, jobId: value.jobId, state: 'running', lastSequence: 0, updatedAt: value.createdAt }
      statuses.set(value.jobId, status)
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: 'accepted' }
    },
    getStatus: async id => statuses.get(id) ?? null,
    cancel: async id => {
      cancelled.push(id)
      return { version: 1, jobId: id, outcome: 'requested', timestamp: new Date().toISOString(), status: statuses.get(id) ?? null }
    },
  }
  const a = new ProjectExecutor('project-a', executor, authorize('project-a'))
  const b = new ProjectExecutor('project-b', executor, authorize('project-b'))
  const value = request({ projectScope: 'f'.repeat(32) })
  for await (const event of a.execute(value, new AbortController().signal)) assert.equal(event.jobId, value.jobId)
  assert.equal(a.hasPendingJobs, true)
  assert.equal(await b.getStatus(value.jobId), null)
  assert.equal((await b.cancel(value.jobId)).outcome, 'not-found')
  assert.deepEqual(cancelled, [])
  for await (const event of b.execute(value, new AbortController().signal)) assert.equal(event.jobId, value.jobId)
  assert.notEqual(requests[0].jobId, requests[1].jobId)
  assert.match(requests[0].jobId, /^project-[a-f0-9]{64}$/)
  assert.notEqual(requests[0].sessionId, requests[1].sessionId)
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey)
  assert.equal(requests[0].idempotencyKey, projectExecutionKey('project-a', 'idempotency', value.idempotencyKey))
  assert.equal(requests[0].projectScope, managedProjectScope('project-a'))
  assert.equal(requests[1].projectScope, managedProjectScope('project-b'))
  assert.equal((await a.cancel(value.jobId)).status?.jobId, value.jobId)
  assert.deepEqual(cancelled, [requests[0].jobId])
  statuses.set(requests[0].jobId, { ...statuses.get(requests[0].jobId)!, state: 'completed',
    receipt: { version: 1, jobId: requests[0].jobId, nodeId: 'child', state: 'completed', finishedAt: value.createdAt } })
  await a.getStatus(value.jobId)
  assert.equal(a.hasPendingJobs, false)
  assert.equal(b.hasPendingJobs, true)
})

test('host access rejection propagates before transport and pending reservations', async () => {
  let admitted = false
  const executor: Executor = {
    async *execute() { admitted = true; throw new Error('Must not reach transport') },
    getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  for (const reason of ['missing directory', 'foreign Project', 'folder_access_revoked', 'unsupported operation']) {
    const scoped = new ProjectExecutor('project', executor, () => { throw new Error(reason) })
    await assert.rejects(async () => { for await (const _event of scoped.execute(request(), new AbortController().signal)) {} }, { message: reason })
    assert.equal(scoped.hasPendingJobs, false)
  }
  assert.equal(admitted, false)
})

test('access is evaluated on every new execution; advertisements cannot authorize a new operation', async () => {
  let calls = 0
  let active = true
  const executor: Executor = {
    async *execute(value) {
      calls++
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: 'completed',
        receipt: { version: 1, jobId: value.jobId, nodeId: 'child', state: 'completed', finishedAt: value.createdAt } }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, value => { if (!active) throw new Error('project access denied'); authorize('project')(value) })
  for await (const _event of scoped.execute(request(), new AbortController().signal)) {}
  await assert.rejects(async () => { for await (const _event of scoped.execute(request({ jobId: 'write', operation: 'filesystem.write' }), new AbortController().signal)) {} }, /project access denied/)
  active = false
  await assert.rejects(async () => { for await (const _event of scoped.execute(request({ jobId: 'later' }), new AbortController().signal)) {} }, /project access denied/)
  assert.equal(calls, 1)
})

test('transport failure receipts cannot establish that remote processes stopped', async () => {
  const pending = new Set<string>()
  const executor: Executor = {
    async *execute(value) {
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: 'failed',
        receipt: { version: 1, jobId: value.jobId, nodeId: 'child', state: 'failed', finishedAt: value.createdAt,
          reason: { code: 'remote-node-unavailable', message: 'Disconnected', retryable: true } } }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, authorize('project'), (id, active) => {
    if (active) pending.add(id)
    else pending.delete(id)
  })
  for await (const _event of scoped.execute(request({ jobId: 'job' }), new AbortController().signal)) {}
  assert.equal(scoped.hasPendingJobs, true)
  assert.deepEqual([...pending], ['job'])
})

test('a rejected reconciliation query does not settle the original unknown process; journal evidence does', async () => {
  const pending = new Set<string>()
  const reconciled: string[] = []
  let proof = false
  const original = request({ jobId: 'original', operation: 'workdir.process.execute-once' })
  const executor: Executor = {
    async *execute(value) {
      const isQuery = value.operation === 'workdir.process.reconcile'
      const state = isQuery ? proof ? 'completed' : 'rejected' : 'failed'
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: state,
        receipt: { version: 1, jobId: value.jobId, nodeId: 'child', state, finishedAt: value.createdAt,
          ...(isQuery && proof ? { reconciledJobId: projectExecutionKey('project', 'job', 'original'), exitCode: 0 } :
            { reason: { code: isQuery ? 'workdir-unavailable' : 'remote-node-unavailable', message: 'Fixture refusal', retryable: false } }) } }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const check = (value: ExecutionRequestV2): void => {
    assert.ok(['workdir.process.execute-once', 'workdir.process.reconcile'].includes(value.operation))
  }
  const scoped = new ProjectExecutor('project', executor, check, (id, active) => {
    if (active) pending.add(id); else pending.delete(id)
  }, id => reconciled.push(id))
  for await (const _event of scoped.execute(original, new AbortController().signal)) {}
  assert.deepEqual([...pending], ['original'])
  for await (const _event of scoped.execute({ ...original, jobId: 'query-rejected', operation: 'workdir.process.reconcile' }, new AbortController().signal)) {}
  assert.equal(scoped.hasPendingJobs, true)
  assert.deepEqual([...pending], ['original'])
  assert.equal(reconciled.length, 0)
  proof = true
  for await (const _event of scoped.execute({ ...original, jobId: 'query-known', operation: 'workdir.process.reconcile' }, new AbortController().signal)) {}
  assert.equal(scoped.hasPendingJobs, false)
  assert.deepEqual([...pending], [])
  assert.deepEqual(reconciled, [projectExecutionKey('project', 'job', 'original')])
  const restarted = new ProjectExecutor('project', executor, check, (id, active) => {
    assert.equal(active, false, 'A reconciliation query must not create another process reservation')
  }, id => reconciled.push(id))
  for await (const _event of restarted.execute({ ...original, jobId: 'query-after-restart', operation: 'workdir.process.reconcile' }, new AbortController().signal)) {}
  assert.equal(reconciled.length, 2, 'Journal evidence reaches persisted reservation cleanup even without old in-memory keys')
})

test('async authorization holds a Folder lease through dispatch, and rejection releases it without sending', async () => {
  let leases = 0
  let sent = 0
  const gate = Promise.withResolvers<void>()
  const value = request()
  const executor: Executor = {
    async *execute(job) {
      assert.equal(leases, 1)
      sent++
      yield { version: 1, jobId: job.jobId, sequence: 0, timestamp: job.createdAt, type: 'completed',
        receipt: { version: 1, jobId: job.jobId, nodeId: 'child', state: 'completed', finishedAt: job.createdAt } }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const acquire = () => { leases++; return () => { leases-- } }
  const scoped = new ProjectExecutor('project', executor, async () => gate.promise, undefined, undefined, acquire)
  const execution = (async () => { for await (const _event of scoped.execute(value, new AbortController().signal)) {} })()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(leases, 1)
  assert.equal(sent, 0)
  gate.resolve(authorize('project')(value))
  await execution
  assert.equal(sent, 1)
  assert.equal(leases, 0)
  const rejected = new ProjectExecutor('project', executor, async () => { throw new Error('project access denied') }, undefined, undefined, acquire)
  await assert.rejects(async () => { for await (const _event of rejected.execute(value, new AbortController().signal)) {} }, /project access denied/)
  assert.equal(leases, 0)
  assert.equal(sent, 1)
})

test('a definite first unsupported-operation rejection clears only its own new reservation', async () => {
  const executor: Executor = { async *execute(value) {
    yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: 'rejected',
      receipt: { version: 1, jobId: value.jobId, nodeId: 'child', state: 'rejected', finishedAt: value.createdAt,
        reason: { code: 'unsupported-operation', message: 'Not sent', retryable: false } } }
  }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') } }
  const scoped = new ProjectExecutor('project', executor, authorize('project'))
  for await (const _event of scoped.execute(request(), new AbortController().signal)) {}
  assert.equal(scoped.hasPendingJobs, false)
})


test('read-only identity queries never leave durable process reservations on disconnect or retry', async () => {
  let disconnected = true
  const records: string[] = []
  const executor: Executor = {
    async *execute(value) {
      const state = disconnected ? 'failed' : 'completed'
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: state,
        receipt: { version: 1, jobId: value.jobId, nodeId: 'child', state, finishedAt: value.createdAt,
          ...(disconnected ? { reason: { code: 'remote-node-unavailable', message: 'Query disconnected', retryable: true } } : {}) } }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, value => { assert.equal(value.operation, 'workdir.identity') },
    (id, pending) => records.push(`${id}:${pending}`))
  for (const id of ['lost-query', 'healthy-retry']) {
    for await (const _event of scoped.execute(request({ jobId: id, operation: 'workdir.identity' }), new AbortController().signal)) {}
    assert.equal(scoped.hasPendingJobs, false)
    disconnected = false
  }
  assert.deepEqual(records, [])
})


test('host checks and dispatch share an immutable caller snapshot across async admission', async () => {
  const checked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const input = request()
  let admitted: ExecutionRequestV2 | undefined
  const executor: Executor = {
    async *execute(value) {
      admitted = value
      yield { version: 1, jobId: value.jobId, sequence: 0, timestamp: value.createdAt, type: 'accepted' }
    }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, async value => {
    authorize('project')(value)
    checked.resolve()
    await release.promise
    assert.equal(value.workdirId !== undefined && value.workdirId, 'folder')
    assert.deepEqual(value.args, { path: 'safe.txt' })
  })
  input.args = { path: 'safe.txt' }
  const execution = Array.fromAsync(scoped.execute(input, new AbortController().signal))
  await checked.promise
  input.nodeId = 'other'; input.workdirId = 'foreign'
  input.operation = 'filesystem.write'
  ;(input.args as { path: string }).path = 'changed.txt'
  release.resolve()
  await execution
  assert.equal(admitted?.nodeId, 'child')
  assert.equal(admitted?.operation, 'filesystem.read')
  assert.deepEqual(admitted?.args, { path: 'safe.txt' })
})

test('abort during host access check prevents dispatch and releases the Folder lease', async () => {
  const checked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const abort = new AbortController()
  let leases = 0
  let records = 0
  const executor: Executor = {
    async *execute() { assert.fail('Aborted admission must not dispatch') },
    getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, async () => {
    checked.resolve()
    await release.promise
  }, () => { records++ }, undefined, () => { leases++; return () => { leases-- } })
  const execution = Array.fromAsync(scoped.execute(request(), abort.signal))
  await checked.promise
  assert.equal(leases, 1)
  abort.abort()
  release.resolve()
  await assert.rejects(execution, { name: 'AbortError' })
  assert.equal(leases, 0)
  assert.equal(records, 0)
  assert.equal(scoped.hasPendingJobs, false)
})
