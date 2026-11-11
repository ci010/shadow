import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import type { ExecutionContext } from './context.ts'
import { SearchTool } from './search.ts'

function request(args: unknown): ExecutionRequestV2 {
  return { version: 2, jobId: 'job', idempotencyKey: 'job', sessionId: 's', turnId: 't', nodeId: 'child', workdirId: 'wd', operation: 'filesystem.read', args, createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString() }
}
const signal = new AbortController().signal

test('remote search dispatches without Main ripgrep detection or fallback', async () => {
  const requests: ExecutionRequestV2[] = []
  const context = { sessionId: 's', messageId: 't', signal, remoteWorkdir: {
    nodeId: 'child', workdirId: 'wd', executor: { async *execute(req: ExecutionRequestV2) {
      requests.push(req)
      yield { type: 'stdout', chunk: 'remote hits' }
      yield { type: 'completed', receipt: { state: 'completed' } }
    } },
  } } as unknown as ExecutionContext
  const tool = new SearchTool('/nonexistent-main', undefined, undefined, false)
  assert.equal(await tool.execute({ handler: 'grep', query: '-hello', include: '*.ts', offset: 2, limit: 3 }, context), 'remote hits')
  assert.equal(requests[0].operation, 'filesystem.read')
  assert.deepEqual(requests[0].args, { path: '.', search: { handler: 'grep', query: '-hello', include: '*.ts', offset: 2, limit: 3 } })
  context.remoteWorkdir!.executor.execute = async function* () { throw new Error('device offline') }
  await assert.rejects(tool.execute({ handler: 'glob', query: '**' }, context), /device offline/)
})

test('device filesystem search supports grep/glob paging and confines paths', async () => {
  const root = await mkdtemp(join(process.cwd(), '.search-device-'))
  const outside = await mkdtemp(join(process.cwd(), '.search-outside-'))
  try {
    await writeFile(join(root, 'a.ts'), 'needle\nneedle again\n')
    await writeFile(join(root, 'b.txt'), 'needle\n')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'secret.ts'), 'needle\n')
    await writeFile(join(outside, 'secret.ts'), 'needle\n')
    await symlink(outside, join(root, 'escape'))
    const fs = new CapabilityFilesystem([{ workdirId: 'wd', rootPath: root }])
    const search = (value: unknown, path = '.') => fs.execute(request({ path, search: value }), signal)
    const glob = await search({ handler: 'glob', query: '**/*.ts' })
    assert.match(glob, /\na.ts$/)
    assert.doesNotMatch(glob, new RegExp(root))
    const bounded = new CapabilityFilesystem([{ workdirId: 'wd', rootPath: root }], { maxReadBytes: 4 })
    await assert.rejects(bounded.execute(request({ path: '.', search: { handler: 'glob', query: '**' } }), signal), /size limit/)
    assert.doesNotMatch(glob, /secret/)
    const grep = await search({ handler: 'grep', query: 'needle', include: '*.ts', limit: 1, offset: 1 })
    assert.match(grep, /Line 2: needle again/)
    assert.doesNotMatch(grep, /b.txt|secret/)
    assert.equal(await search({ handler: 'grep', query: 'absent' }), 'No matches found')
    await assert.rejects(search({ handler: 'glob', query: '**' }, '../'), /outside/)
    await assert.rejects(search({ handler: 'glob', query: '**' }, 'escape'), /outside/)
    await assert.rejects(search({ handler: 'grep', query: '[' }), /ripgrep search failed/)
    await assert.rejects(search({ handler: 'glob', query: '**', offset: -1 }), /arguments are invalid/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(fs.execute(request({ path: '.', search: { handler: 'glob', query: '**' } }), controller.signal))
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
