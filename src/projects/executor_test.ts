import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Executor } from '../execution/executor.ts'
import type { JobRequestV1, JobStatusV1 } from '../execution/contracts.ts'
import { ProjectExecutor } from './executor.ts'

test('same logical session and job IDs have disjoint remote execution and cancel authority', async () => {
  const requests: JobRequestV1[] = []
  const cancelled: string[] = []
  const statuses = new Map<string, JobStatusV1>()
  const executor: Executor = {
    async *execute(request) {
      requests.push(request)
      const status: JobStatusV1 = { version: 1, jobId: request.jobId, state: 'running', lastSequence: 0, updatedAt: request.createdAt }
      statuses.set(request.jobId, status)
      yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: request.createdAt, type: 'accepted' }
    },
    getStatus: async id => statuses.get(id) ?? null,
    cancel: async id => {
      cancelled.push(id)
      return { version: 1, jobId: id, outcome: 'requested', timestamp: new Date().toISOString(), status: statuses.get(id) ?? null }
    },
  }
  const a = new ProjectExecutor('project-a', executor)
  const b = new ProjectExecutor('project-b', executor)
  const request: JobRequestV1 = {
    version: 1, jobId: 'same-job', sessionId: 'web:same', turnId: 'same-turn', idempotencyKey: 'same-key',
    nodeId: 'child', capabilityId: 'folder', operation: 'fixture', args: {},
    createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10000).toISOString(),
  }
  for await (const event of a.execute(request, new AbortController().signal)) assert.equal(event.jobId, request.jobId)
  assert.equal(a.hasPendingJobs, true)
  assert.equal(await b.getStatus(request.jobId), null)
  assert.equal((await b.cancel(request.jobId)).outcome, 'not-found')
  assert.deepEqual(cancelled, [])
  for await (const event of b.execute(request, new AbortController().signal)) assert.equal(event.jobId, request.jobId)
  assert.notEqual(requests[0].jobId, requests[1].jobId)
  assert.match(requests[0].jobId, /^project-[a-f0-9]{64}$/)
  assert.notEqual(requests[0].sessionId, requests[1].sessionId)
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey)
  assert.equal((await a.cancel(request.jobId)).status?.jobId, request.jobId)
  assert.deepEqual(cancelled, [requests[0].jobId])
  statuses.set(requests[0].jobId, {
    ...statuses.get(requests[0].jobId)!, state: 'completed',
    receipt: { version: 1, jobId: requests[0].jobId, nodeId: 'child', state: 'completed', finishedAt: request.createdAt },
  })
  await a.getStatus(request.jobId)
  assert.equal(a.hasPendingJobs, false)
  assert.equal(b.hasPendingJobs, true)
})

test('revoked remote execution is rejected before transport admission', async () => {
  let admitted = false
  const executor: Executor = {
    async *execute() { admitted = true; throw new Error('Must not reach transport') },
    getStatus: async () => null,
    cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, () => { throw new Error('folder_access_revoked') })
  await assert.rejects(async () => {
    for await (const _event of scoped.execute({} as JobRequestV1, new AbortController().signal)) {}
  }, /folder_access_revoked/)
  assert.equal(admitted, false)
  assert.equal(scoped.hasPendingJobs, false)
})

test('transport failure receipts cannot establish that remote processes stopped', async () => {
  const pending = new Set<string>()
  const executor: Executor = {
    async *execute(request) {
      yield {
        version: 1, jobId: request.jobId, sequence: 0, timestamp: request.createdAt, type: 'failed',
        receipt: { version: 1, jobId: request.jobId, nodeId: 'child', state: 'failed', finishedAt: request.createdAt,
          reason: { code: 'remote-node-unavailable', message: 'Disconnected', retryable: true } },
      }
    },
    getStatus: async () => null, cancel: async () => { throw new Error('Unused') },
  }
  const scoped = new ProjectExecutor('project', executor, undefined, (id, active) => {
    if (active) pending.add(id)
    else pending.delete(id)
  })
  const request = { jobId: 'job', sessionId: 'session', turnId: 'turn', idempotencyKey: 'key',
    createdAt: new Date().toISOString() } as JobRequestV1
  for await (const _event of scoped.execute(request, new AbortController().signal)) {}
  assert.equal(scoped.hasPendingJobs, true)
  assert.deepEqual([...pending], ['job'])
})
