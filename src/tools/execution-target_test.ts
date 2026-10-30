import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionContext } from './context.ts'
import type { Executor } from '../execution/executor.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { resolveExplicitToolTarget, resolveWorkdirToolTarget } from '../execution/tool-target.ts'
import { executionTargetContext, executionTargetParameters } from './execution-target.ts'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { SearchTool } from './search.ts'
import { ViewEditTool } from './view-edit.ts'
import { selectFolder } from '../folders/identifier.ts'
import type { RemoteFolderRecord } from '../folders/contracts.ts'
import type { RecordedFileChange } from '../sessions/file-change-contract.ts'

const base = { sessionId: 'test:target', physicalSessionId: 'target-0', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn', signal: new AbortController().signal, tools: undefined as never } satisfies ExecutionContext
const folder = { id: '11111111-1111-4111-8111-111111111111', name: 'Child', kind: 'remote', path: '/display/only', createdAt: '',
  workdir: { version: 2, nodeId: 'child', workdirId: 'approved' } } as RemoteFolderRecord

test('Folder-targeted read/write operate the bound resource without touching Main or changing the session', async () => {
  await mkdir('.test-data', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.test-data', 'execution-target-'))
  try {
    const child = join(root, 'child'); const main = join(root, 'main')
    await mkdir(child); await mkdir(main)
    await writeFile(join(child, 'note.txt'), 'child-before')
    await writeFile(join(main, 'note.txt'), 'main-unchanged')
    const filesystem = new CapabilityFilesystem([{ workdirId: 'approved', rootPath: child }])
    let calls = 0
    const executor: Executor = {
      getStatus: async () => null, cancel: async () => { throw new Error('not used') },
      async *execute(request, signal) {
        calls++
        assert.equal(request.nodeId, 'child'); assert.equal(request.workdirId, 'approved')
        const chunk = await filesystem.execute(request, signal)
        const timestamp = new Date().toISOString()
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk }
        yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed', receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp } }
      },
    }
    let change: RecordedFileChange | undefined
    const context: ExecutionContext = { ...base, cwd: main, toolCallId: 'write-call',
      resolveToolTarget: async (identifier, operation) => resolveExplicitToolTarget(main, base,
        ref => ref.nodeId === 'child' && ref.workdirId === 'approved' ? { node: 'online', workdir: { online: true } } : { node: 'missing' },
        executor, selectFolder([folder], identifier), operation),
      recordFileChange: async value => { change = value }, readFileChange: async () => change,
    }
    const read = new ReadTool(main)
    assert.equal(await read.execute({ path: 'note.txt' }, context), 'main-unchanged')
    assert.equal(await read.execute({ folder: 'child', path: 'note.txt' }, context), 'child-before')
    await new WriteTool(main).execute({ folder: folder.id, path: 'note.txt', content: 'child-after' }, context)
    assert.equal(await readFile(join(main, 'note.txt'), 'utf8'), 'main-unchanged')
    assert.equal(await readFile(join(child, 'note.txt'), 'utf8'), 'child-after')
    assert.deepEqual(change?.target, { nodeId: 'child', workdirId: 'approved', folderId: folder.id })
    assert.match(await new ViewEditTool().execute({ edit_id: change!.id }, context), /Recorded on node "child", workdir "approved"/)
    assert.equal(context.cwd, main); assert.equal(context.remoteWorkdir, undefined)
    const before = calls
    await assert.rejects(read.execute({ folder: 'child', path: 'photo.png' }, context), /Remote image reads/)
    await assert.rejects(read.execute({ folder: 'foreign', path: 'note.txt' }, context), /Unknown or ambiguous/)
    assert.equal(calls, before)
    assert.match(await new SearchTool(main, undefined, undefined, false).execute({ folder: 'child', handler: 'grep', query: 'x' }, context), /remote filesystem glob\/grep search is not supported/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Folder selection rejects raw addresses, virtual/URL/web routes, invalid selectors and absent host resolver', async () => {
  assert.deepEqual(Object.keys(executionTargetParameters), ['folder'])
  for (const args of [{ nodeId: 'child' }, { capabilityId: 'approved' }, { workdirId: 'approved' }, { nodeId: 'child', workdirId: 'approved' }, { grant: 'not-a-token' }, { nodeId: 'child', capabilityId: 'approved' }, { folder: '' }, { folder: 'child' }]) {
    await assert.rejects(executionTargetContext(args, base, 'filesystem.read'))
  }
  for (const path of ['v:memory/a', 'https://example.com', '/main/v:memory/a', 'foo/../v:tools']) {
    await assert.rejects(executionTargetContext({ folder: 'child', path }, { ...base, async resolveToolTarget() { throw new Error('must not resolve') } }, 'filesystem.read'), /ordinary filesystem/)
  }
  assert.equal(await executionTargetContext({ shell: 'node' }, base, 'workdir.process.execute-once'), base)
  await assert.rejects(executionTargetContext({ folder: 'child', handler: 'web' }, base, 'filesystem.read'), /ordinary filesystem/)
})

test('Project lookup is mandatory even for legacy local managed resources; incompatible peers fail without fallback', () => {
  for (const lookup of [undefined, () => ({ node: 'missing' as const }), () => ({ node: 'offline' as const }), () => ({ node: 'revoked' as const }), () => ({ node: 'online' as const, workdir: { online: false } }), () => ({ node: 'online' as const, workdir: { online: false } })]) {
    assert.throws(() => resolveWorkdirToolTarget('.', base, lookup, undefined,
      { version: 2, nodeId: 'local', workdirId: 'managed-session-v1:test%3Atarget' }, 'filesystem.read'), /unavailable or operation not authorized/)
  }
  assert.throws(() => resolveExplicitToolTarget('.', base, () => ({ node: 'online', incompatible: true }), undefined, folder, 'filesystem.read'), /upgrade/)
  assert.throws(() => resolveExplicitToolTarget('.', base, () => ({ node: 'online', workdir: { online: true } }), undefined, folder, 'filesystem.read'), /Remote executor unavailable/)
})

test('saved V1 tool targeting is reconciliation-only and cannot become a new raw-address API', async () => {
  let calls = 0
  const context: ExecutionContext = { ...base, recoveringToolCall: true, async resolveStoredToolTarget(nodeId, workdirId) {
    calls++
    return { cwd: '/fixture', fileChangeTarget: { nodeId, workdirId } }
  } }
  const args = { nodeId: 'child', capabilityId: 'approved', script: 'old command' }
  const resolved = await executionTargetContext(args, context, 'workdir.process.execute-once')
  assert.deepEqual(resolved.fileChangeTarget, { nodeId: 'child', workdirId: 'approved' })
  await assert.rejects(executionTargetContext(args, { ...context, recoveringToolCall: false }, 'workdir.process.execute-once'), /Use folder/)
  await assert.rejects(executionTargetContext(args, context, 'filesystem.write'), /Use folder/)
  await assert.rejects(executionTargetContext({ ...args, folder: 'new' }, context, 'workdir.process.execute-once'), /Use folder/)
  assert.equal(calls, 1)
})
