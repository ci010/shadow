import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { JobRequestV1 } from './contracts.ts'
import { InMemoryLocalApprovalService } from './local-approval.ts'

function request(overrides: Partial<JobRequestV1> = {}): JobRequestV1 {
  const now = new Date()
  return {
    version: 1,
    jobId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    sessionId: 'session-1',
    turnId: 'turn-1',
    nodeId: 'child-1',
    capabilityId: 'workdir-1',
    operation: 'filesystem.write',
    args: { path: 'notes.txt', content: 'private contents' },
    createdAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + 10_000).toISOString(),
    approval: 'none',
    ...overrides,
  }
}

test('local approval enforces policy scope and creates content-safe summaries', async () => {
  const service = new InMemoryLocalApprovalService([{
    capabilityId: 'workdir-1',
    displayName: 'Project files',
    policy: 'session',
  }])
  const lifecycle = new AbortController()
  await service.start(lifecycle.signal)

  const first = request({ jobId: 'approval-1' })
  let pendingSignals = 0
  const firstDecision = service.authorize(
    first,
    new AbortController().signal,
    () => pendingSignals++,
  )
  assertEquals(pendingSignals, 1)
  assertEquals(service.listPending(), [{
    version: 1,
    approvalId: 'approval-1',
    jobId: 'approval-1',
    sessionId: 'session-1',
    capabilityId: 'workdir-1',
    operation: 'filesystem.write',
    requestedAt: service.listPending()[0].requestedAt,
    deadlineAt: first.deadlineAt,
    allowedScopes: ['once', 'session'],
    summary: {
      version: 1,
      operation: 'filesystem.write',
      capabilityDisplayName: 'Project files',
      action: 'Write a local file',
      target: 'notes.txt',
      detail: '16 UTF-8 bytes',
    },
  }])
  assertEquals(
    JSON.stringify(service.listPending()).includes('private contents'),
    false,
  )
  assertEquals(service.approve('approval-1', 'capability'), false)
  assertEquals(service.approve('approval-1', 'session'), true)
  assertEquals(await firstDecision, true)

  assertEquals(
    await service.authorize(
      request({ jobId: 'approval-2' }),
      new AbortController().signal,
      () => pendingSignals++,
    ),
    true,
  )
  assertEquals(pendingSignals, 1)

  const forcedDecision = service.authorize(
    request({
      jobId: 'approval-forced',
      approval: 'local-required',
    }),
    new AbortController().signal,
    () => pendingSignals++,
  )
  assertEquals(pendingSignals, 2)
  assertEquals(service.approve('approval-forced', 'once'), true)
  assertEquals(await forcedDecision, true)

  const otherOperation = service.authorize(
    request({ jobId: 'approval-3', operation: 'filesystem.read' }),
    new AbortController().signal,
    () => pendingSignals++,
  )
  assertEquals(pendingSignals, 3)
  assertEquals(service.deny('approval-3'), true)
  assertEquals(await otherOperation, false)
  assertEquals(
    service.revoke({
      capabilityId: 'workdir-1',
      operation: 'filesystem.write',
      sessionId: 'session-1',
    }),
    1,
  )
  await service.shutdown()
})

test('local approval always prompts and cancellation removes pending work', async () => {
  const service = new InMemoryLocalApprovalService([{
    capabilityId: 'workdir-1',
    displayName: 'Project files',
    policy: 'always',
  }])
  const signal = new AbortController()
  const decision = service.authorize(
    request({ jobId: 'cancelled' }),
    signal.signal,
    () => {},
  )
  assertEquals(service.listPending().length, 1)
  signal.abort()
  assertEquals(await decision, false)
  assertEquals(service.listPending(), [])
})
