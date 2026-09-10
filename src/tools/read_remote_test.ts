import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { ReadTool } from './read.ts'
import { Tools } from './registry.ts'

class RecordingExecutor implements Executor {
  request?: JobRequestV1

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
    this.request = request
    const timestamp = new Date().toISOString()
    yield {
      version: 1,
      jobId: request.jobId,
      sequence: 0,
      timestamp,
      type: 'stdout',
      chunk: 'first\nsecond\nthird',
    }
    yield {
      version: 1,
      jobId: request.jobId,
      sequence: 1,
      timestamp,
      type: 'completed',
      receipt: {
        version: 1,
        jobId: request.jobId,
        nodeId: request.nodeId,
        state: 'completed',
        finishedAt: timestamp,
      },
    }
  }

  getStatus(): Promise<JobStatusV1 | null> {
    return Promise.resolve(null)
  }

  cancel(): Promise<CancelReceiptV1> {
    throw new Error('not used')
  }
}

function context(executor: Executor): ExecutionContext {
  return {
    channel: 'test',
    messageId: 'turn-1',
    senderId: 'user',
    chatId: 'chat',
    sessionId: 'test:chat',
    physicalSessionId: 'test-chat-0',
    tools: undefined as never,
    signal: new AbortController().signal,
    remoteWorkdir: {
      nodeId: 'child-1',
      capabilityId: 'workdir-1',
      executor,
    },
  }
}

test('ReadTool dispatches remote workdir reads as capability jobs', async () => {
  const executor = new RecordingExecutor()
  const result = await new ReadTool('.').execute(
    { path: 'notes.txt', offset: 2, limit: 1, flag: 'n' },
    context(executor),
  )

  assertEquals(
    result,
    '2  second\n\n[truncated: showing lines 2–2 of 3 — use offset=3 to read more]',
  )
  assertEquals(executor.request?.nodeId, 'child-1')
  assertEquals(executor.request?.capabilityId, 'workdir-1')
  assertEquals(executor.request?.operation, 'filesystem.read')
  assertEquals(executor.request?.args, { path: 'notes.txt' })
})

test('Tools rejects local-only tools in a remote workdir context', async () => {
  const tools = new Tools('.')
  tools.register({
    name: 'local_only',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: () => Promise.resolve('should not run'),
  })

  const result = await tools.execute(
    'local_only',
    {},
    context(new RecordingExecutor()),
  )
  assert(result.includes('does not support remote workdirs'))
})
