import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { DERIVED_WORKSPACE_OPERATION } from '../execution/derived-workspace-contract.ts'
import { managedProjectScope } from '../execution/managed-workdir.ts'
import { DIRECTORY_OPERATIONS, ProjectExecutor } from './executor.ts'

test('derived inspect/verify use the Project directory profile without durable side-effect reservations, even on disconnect', async () => {
  const records: string[] = []
  const requests: ExecutionRequestV2[] = []
  const executor: Executor = { async *execute(request) {
    requests.push(request)
    yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: request.createdAt, type: 'failed', receipt: {
      version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'failed', finishedAt: request.createdAt,
      reason: { code: 'remote-node-unavailable', message: 'Lost', retryable: true },
    } }
  }, getStatus: async () => null, cancel: async () => { throw new Error('Unused') } }
  assert.ok(DIRECTORY_OPERATIONS.includes(DERIVED_WORKSPACE_OPERATION))
  const scoped = new ProjectExecutor('project-a', executor, request => {
    assert.equal(request.operation, DERIVED_WORKSPACE_OPERATION)
    assert.equal(request.nodeId, 'child'); assert.equal(request.workdirId, 'source')
  }, (id, pending) => records.push(`${id}:${pending}`))
  const run = async (args: unknown) => {
    const request: ExecutionRequestV2 = { version: 2, jobId: `job-${requests.length}`, idempotencyKey: 'key', sessionId: 'folder:source-folder', turnId: 'turn',
      nodeId: 'child', workdirId: 'source', operation: DERIVED_WORKSPACE_OPERATION, args, projectScope: managedProjectScope('foreign'),
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10000).toISOString() }
    for await (const _event of scoped.execute(request, new AbortController().signal)) {}
  }
  await run({ action: 'inspect' }); await run({ action: 'verify', key: 'saved-key' })
  assert.equal(scoped.hasPendingJobs, false); assert.deepEqual(records, [])
  assert.ok(requests.every(request => request.projectScope === managedProjectScope('project-a')))
  for (const args of [{ action: 'inspect', key: 'not-allowed' }, { action: 'verify', key: 'saved', branch: 'not-allowed' }, { action: 'create', branch: 'main' }]) {
    await assert.rejects(run(args), TypeError)
  }
  assert.equal(requests.length, 2)
  await run({ action: 'create', key: 'saved-key', branch: 'main' })
  assert.equal(scoped.hasPendingJobs, true)
  assert.deepEqual(records, ['job-2:true'])
})
