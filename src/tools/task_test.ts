import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskTool } from './task.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import { executionModeAllowsTool } from '../sessions/execution-mode.ts'

test('structured review uses authenticated identity and rejects manual orchestration', async () => {
  let received: unknown[] = []
  const tool = new TaskTool({ reviewTask: async (...args: unknown[]) => { received = args; return { status: 'in_review' } } } as unknown as SessionManager)
  const context = { sessionId: 'actual-reviewer', signal: new AbortController().signal } as ExecutionContext
  await tool.execute({ action: 'review', sessionId: 'worker', revision: 3, outcome: 'changes_requested', content: 'Fix tests', actorSessionId: 'forged' }, context)
  assert.deepEqual(received, ['actual-reviewer', 'worker', 3, 'changes_requested', 'Fix tests'])
  await assert.rejects(tool.execute({ action: 'close', sessionId: 'worker' }, context), /manual/)
  await assert.rejects(tool.execute({ action: 'review', sessionId: 'worker', revision: '3', outcome: 'pass' }, context), /revision/)
  assert.equal(executionModeAllowsTool('call', 'task'), false)
})

test('retry requires a version and uses authenticated creator identity', async () => {
  let received: unknown[] = []
  const tool = new TaskTool({ taskAction: async (...args: unknown[]) => { received = args; return { status: 'working' } } } as unknown as SessionManager)
  const context = { sessionId: 'creator', signal: new AbortController().signal } as ExecutionContext
  await assert.rejects(tool.execute({ action: 'retry', sessionId: 'worker' }, context), /expectedVersion/)
  await tool.execute({ action: 'retry', sessionId: 'worker', expectedVersion: 4, actorSessionId: 'forged' }, context)
  assert.deepEqual(received, ['creator', 'worker', 'retry', 4])
})
