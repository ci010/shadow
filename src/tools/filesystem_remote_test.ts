import { deepEqual as assertEquals, match, rejects, doesNotMatch } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type {
  CancelReceiptV1,
  JobEventV1,
  ExecutionRequestV2,
  JobStatusV1,
} from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { WriteTool } from './filesystem.ts'

class FilesystemExecutor implements Executor {
  readonly requests: ExecutionRequestV2[] = []
  constructor(readonly readFailure?: string, readonly writeFailure?: string, readonly before = 'before value after') {}

  async *execute(request: ExecutionRequestV2): AsyncIterable<JobEventV1> {
    this.requests.push(request)
    const timestamp = new Date().toISOString()
    let sequence = 0
    const failure = request.operation === 'filesystem.read' ? this.readFailure : this.writeFailure
    if (failure) {
      yield {
        version: 1, jobId: request.jobId, sequence, timestamp, type: 'failed',
        receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'failed', finishedAt: timestamp,
          reason: { code: failure, message: failure, retryable: false } },
      }
      return
    }
    if (request.operation === 'filesystem.read') {
      yield {
        version: 1,
        jobId: request.jobId,
        sequence: sequence++,
        timestamp,
        type: 'stdout',
        chunk: this.before,
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
      workdirId: 'workdir-1',
      executor,
    },
  }
}

test('WriteTool reads the remote append seam and appends through its capability', async () => {
  const executor = new FilesystemExecutor()
  const result = await new WriteTool('.').execute(
    { path: 'notes.txt', content: 'next', flag: 'a' },
    context(executor),
  )

  match(result, /^OK append \+1 -1/)
  doesNotMatch(result, /before value afternext/)
  assertEquals(executor.requests.length, 2)
  assertEquals(executor.requests[1].operation, 'filesystem.write')
  assertEquals(executor.requests[1].args, {
    path: 'notes.txt',
    content: 'next',
    mode: 'append',
  })
})

test('explicit BOM encoding remains a capability-backed remote write, independent of Main OS paths', async () => {
  const executor = new FilesystemExecutor('file-not-found')
  await new WriteTool('.').execute({ path: 'helper.ps1', content: 'Write-Output "hello"', encoding: 'utf8-bom' }, context(executor))
  assertEquals(executor.requests[1].args, { path: 'helper.ps1', content: '\uFEFFWrite-Output "hello"', mode: 'replace' })
})
test('WriteTool edits remote content with capability read then write', async () => {
  const executor = new FilesystemExecutor()
  const result = await new WriteTool('.').execute(
    { path: 'notes.txt', match: 'value', content: 'changed' },
    context(executor),
  )

  match(result, /^OK edit \+1 -1/)
  match(result, /Replacements: 1; match: exact/)
  doesNotMatch(result, /before changed after/)
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

test('remote overwrites observe before text and report only after successful completion', async () => {
  const executor = new FilesystemExecutor()
  const result = await new WriteTool('.').execute({ path: 'new.txt', content: 'hello\n' }, context(executor))
  assertEquals(executor.requests.map(request => request.operation), ['filesystem.read', 'filesystem.write'])
  match(result, /^OK write \+1 -1/)
  doesNotMatch(result, /hello/)
  const failed = new FilesystemExecutor(undefined, 'path-denied')
  await rejects(new WriteTool('.').execute({ path: 'bad.txt', content: 'hello' }, context(failed)), /path-denied/)
})

test('remote append with unreadable large content reports relative lines, never fabricated whole-file bounds', async () => {
  const executor = new FilesystemExecutor('filesystem-result-too-large')
  const result = await new WriteTool('.').execute({ path: 'large.txt', content: 'next\n', flag: 'a' }, context(executor))
  match(result, /Diff unavailable:.*filesystem-result-too-large/)
  doesNotMatch(result, /Appended range:/)
  assertEquals(executor.requests[1].args, { path: 'large.txt', content: 'next\n', mode: 'append' })
})

test('remote append creates missing files but does not ignore authorization failures', async () => {
  const missing = new FilesystemExecutor('file-not-found')
  match(await new WriteTool('.').execute({ path: 'new.txt', content: 'new', flag: 'a' }, context(missing)), /^OK append \+1 -0/)
  const denied = new FilesystemExecutor('capability-denied')
  await rejects(new WriteTool('.').execute({ path: 'new.txt', content: 'new', flag: 'a' }, context(denied)), /capability-denied/)
  assertEquals(denied.requests.length, 1)
})

test('remote full overwrites preserve write-only semantics with explicit unknown observations', async () => {
  for (const failure of ['capability-denied', 'path-denied', 'filesystem-result-too-large', 'file-type-denied', 'filesystem-io-failed']) {
    const executor = new FilesystemExecutor(failure)
    const result = await new WriteTool('.').execute({ path: 'write-only.txt', content: 'next' }, context(executor))
    match(result, /^OK write/)
    match(result, new RegExp(`Diff unavailable:.*${failure}`))
    assertEquals(executor.requests[1].args, { path: 'write-only.txt', content: 'next', mode: 'replace' })
  }
})

test('remote missing files are empty before writes and appends', async () => {
  for (const flag of ['', 'a']) {
    const executor = new FilesystemExecutor('file-not-found')
    const result = await new WriteTool('.').execute({ path: 'new.txt', content: 'one\ntwo\n', flag }, context(executor))
    match(result, /^OK (?:write|append) \+2 -0/)
  }
})

test('remote counts use full observed text for overwrite, global edit and append', async () => {
  const cases = [
    { before: 'old\nkeep\nold\n', args: { content: 'new\nkeep\nnew\n' }, expected: '+2 -2' },
    { before: 'old\nkeep\nold\n', args: { match: 'old', content: 'new', flag: 'g' }, expected: '+2 -2' },
    { before: 'a\r\nb\r\n', args: { content: 'a\nb\n' }, expected: '+0 -0' },
    { before: 'a\n', args: { content: 'b\n', flag: 'a' }, expected: '+1 -0' },
    { before: 'seam', args: { content: '+next\nlast\n', flag: 'a' }, expected: '+2 -1' },
    { before: 'old\n', args: { match: 'old\n', content: '' }, expected: '+0 -1' },
  ]
  for (const { before, args, expected } of cases) {
    const executor = new FilesystemExecutor(undefined, undefined, before)
    const result = await new WriteTool('.').execute({ path: 'file.txt', ...args }, context(executor))
    assertEquals(result.split('\n')[0], `OK ${args.match !== undefined ? 'edit' : args.flag === 'a' ? 'append' : 'write'} ${expected}`)
  }
})

test('remote pre-read cancellation propagates without attempting an overwrite', async () => {
  for (const failure of ['cancelled', 'aborted']) {
    const executor = new FilesystemExecutor(failure)
    await rejects(new WriteTool('.').execute({ path: 'file.txt', content: 'new' }, context(executor)), new RegExp(failure))
    assertEquals(executor.requests.length, 1)
  }
  const abort = new AbortController()
  const executor = new FilesystemExecutor()
  const wrapped: Executor = {
    ...executor,
    getStatus: executor.getStatus.bind(executor),
    cancel: executor.cancel.bind(executor),
    async *execute(request) {
      for await (const event of executor.execute(request)) yield event
      abort.abort()
    },
  }
  await rejects(new WriteTool('.').execute({ path: 'file.txt', content: 'new' }, {
    ...context(wrapped), signal: abort.signal,
  }), { name: 'AbortError' })
  assertEquals(executor.requests.length, 1)
})

test('remote exact edits preserve mixed endings and BOM without normalizing unrelated text', async () => {
  const executor = new FilesystemExecutor(undefined, undefined, '\uFEFFheader\r\nold\r\nblock\r\ntail\nlast')
  const result = await new WriteTool('.').execute(
    { path: 'notes.txt', match: 'old\nblock', content: 'new\nlines' }, context(executor),
  )
  match(result, /match: exact/)
  doesNotMatch(result, /normalized/)
  assertEquals(executor.requests[1].args, {
    path: 'notes.txt', content: '\uFEFFheader\r\nnew\r\nlines\r\ntail\nlast', mode: 'replace',
  })
})

test('remote ambiguous, empty and fuzzy edits never submit a write', async () => {
  for (const needle of ['old', '', '\told']) {
    const executor = new FilesystemExecutor(undefined, undefined, 'old\r\nold\r\n')
    const result = await new WriteTool('.').execute(
      { path: 'notes.txt', match: needle, content: 'new' }, context(executor),
    )
    match(result, /^Error:/)
    assertEquals(executor.requests.length, 1)
  }
})

test('remote global edits replace every exact region with its local line ending', async () => {
  const executor = new FilesystemExecutor(undefined, undefined, 'old\r\nold\n')
  await new WriteTool('.').execute(
    { path: 'notes.txt', match: 'old', content: 'a\nb', flag: 'g' }, context(executor),
  )
  assertEquals(executor.requests[1].args, { path: 'notes.txt', content: 'a\r\nb\r\na\nb\n', mode: 'replace' })
})
