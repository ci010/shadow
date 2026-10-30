import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecutionContext } from './context.ts'
import type { Executor } from '../execution/executor.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { resolveExplicitToolTarget } from '../execution/tool-target.ts'
import { executionTargetContext } from './execution-target.ts'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { SearchTool } from './search.ts'
import { ViewEditTool } from './view-edit.ts'
import type { RecordedFileChange } from '../sessions/file-change-contract.ts'

const base = { sessionId: 'test:target', physicalSessionId: 'target-0', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn', signal: new AbortController().signal, tools: undefined as never } satisfies ExecutionContext
const selected = { nodeId: 'child', capabilityId: 'approved' }

test('explicit read/write operate a different capability root without touching Main, and retain edit provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-target-'))
  try {
    const child = join(root, 'child'); const main = join(root, 'main')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(child); await mkdir(main)
    await writeFile(join(child, 'note.txt'), 'child-before')
    await writeFile(join(main, 'note.txt'), 'main-unchanged')
    const filesystem = new CapabilityFilesystem([{ capabilityId: 'approved', rootPath: child }])
    let calls = 0
    const executor: Executor = {
      getStatus: async () => null,
      cancel: async () => { throw new Error('not used') },
      async *execute(request, signal) {
        calls++
        assert.equal(request.nodeId, 'child'); assert.equal(request.capabilityId, 'approved')
        const chunk = await filesystem.execute(request, signal)
        const timestamp = new Date().toISOString()
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk }
        yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed', receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp } }
      },
    }
    let change: RecordedFileChange | undefined
    const context: ExecutionContext = { ...base, cwd: main, toolCallId: 'write-call',
      resolveToolTarget: (node, capability) => resolveExplicitToolTarget(main, base, ref => ref.nodeId === 'child' && ref.capabilityId === 'approved' ? { node: 'online', capability: { kind: 'workdir', online: true } } : { node: 'missing' }, executor, node, capability),
      recordFileChange: async value => { change = value }, readFileChange: async () => change,
    }
    const read = new ReadTool(main)
    assert.equal(await read.execute({ path: 'note.txt' }, context), 'main-unchanged')
    assert.equal(await read.execute({ ...selected, path: 'note.txt' }, context), 'child-before')
    await new WriteTool(main).execute({ ...selected, path: 'note.txt', content: 'child-after' }, context)
    assert.equal(await readFile(join(main, 'note.txt'), 'utf8'), 'main-unchanged')
    assert.equal(await readFile(join(child, 'note.txt'), 'utf8'), 'child-after')
    assert.deepEqual(change?.target, selected)
    assert.match(await new ViewEditTool().execute({ edit_id: change!.id }, context), /Recorded on node "child"/)
    assert.equal(context.cwd, main); assert.equal(context.remoteWorkdir, undefined)
    const before = calls
    await assert.rejects(read.execute({ ...selected, path: 'photo.png' }, context), /Remote image reads/)
    await assert.rejects(read.execute({ nodeId: 'missing', capabilityId: 'approved', path: 'note.txt' }, context), /unavailable or not authorized/)
    assert.equal(calls, before)
    assert.match(await new SearchTool(main, undefined, undefined, false).execute({ ...selected, handler: 'grep', query: 'x' }, context), /remote filesystem glob\/grep search is not supported/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('target selection fails closed for partial inputs, virtual/URL/web routes and absent host resolver', () => {
  for (const args of [{ nodeId: 'child' }, { capabilityId: 'approved' }, selected]) {
    assert.throws(() => executionTargetContext(args, base))
  }
  for (const path of ['v:memory/a', 'https://example.com', '/main/v:memory/a', 'foo/../v:tools']) {
    assert.throws(() => executionTargetContext({ ...selected, path }, { ...base, resolveToolTarget() { throw new Error('must not resolve') } }), /ordinary filesystem/)
  }
  assert.equal(executionTargetContext({ shell: 'node' }, base), base)
  assert.throws(() => executionTargetContext({ ...selected, handler: 'web' }, base), /ordinary filesystem/)
})

test('Project lookup is mandatory even for legacy local managed workdirs; offline and incompatible fail closed', () => {
  for (const lookup of [undefined, () => ({ node: 'missing' as const }), () => ({ node: 'offline' as const }), () => ({ node: 'revoked' as const }), () => ({ node: 'online' as const, capability: { kind: 'workdir', online: false } }), () => ({ node: 'online' as const, capability: { kind: 'other', online: true } })]) {
    assert.throws(() => resolveExplicitToolTarget('.', base, lookup, undefined, 'local', 'managed-session-v1:test%3Atarget'), /unavailable or not authorized/)
  }
  assert.throws(() => resolveExplicitToolTarget('.', base, () => ({ node: 'online', capability: { kind: 'workdir', online: true } }), undefined, 'child', 'approved'), /Remote executor unavailable/)
})
