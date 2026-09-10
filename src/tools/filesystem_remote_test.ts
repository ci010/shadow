import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  JobRequestV1,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { WriteTool } from './filesystem.ts'

class FilesystemExecutor implements Executor {
  readonly requests: JobRequestV1[] = []

  async *execute(request: JobRequestV1): AsyncIterable<JobEventV1> {
    this.requests.push(request)
    const timestamp = new Date().toISOString()
    let sequence = 0
    if (request.operation === 'filesystem.read') {
      yield {
        version: 1,
        jobId: request.jobId,
        sequence: sequence++,
        timestamp,
        type: 'stdout',
        chunk: 'before value after',
      }
    }
    yield {
      version: 1,
      jobId: request.jobId,
      sequence,
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

test('WriteTool appends through one remote capability job', async () => {
  const executor = new FilesystemExecutor()
  const result = await new WriteTool('.').execute(
    { path: 'notes.txt', content: 'next', flag: 'a' },
    context(executor),
  )

  assertEquals(result, '📝 notes.txt (appended)')
  assertEquals(executor.requests.length, 1)
  assertEquals(executor.requests[0].operation, 'filesystem.write')
  assertEquals(executor.requests[0].args, {
    path: 'notes.txt',
    content: 'next',
    mode: 'append',
  })
})

test('WriteTool edits remote content with capability read then write', async () => {
  const executor = new FilesystemExecutor()
  const result = await new WriteTool('.').execute(
    { path: 'notes.txt', match: 'value', content: 'changed' },
    context(executor),
  )

  assertEquals(result, '✏️ notes.txt')
  assertEquals(executor.requests.map((request) => request.operation), [
    'filesystem.read',
    'filesystem.write',
  ])
  assertEquals(executor.requests[1].args, {
    path: 'notes.txt',
    content: 'before changed after',
    mode: 'replace',
  })
})
