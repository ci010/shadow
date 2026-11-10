import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import type { Executor } from '../execution/executor.ts'
import type { JobEventV1, ExecutionRequestV2 } from '../execution/contracts.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { SkillsManager } from './loader.ts'
import type { FolderSkillScope } from './folder.ts'

test('remote folder documents, nested resources, scope switching and confined Child reads', async () => {
  await withTempWorkspace(async home => {
    const dir = join(home, '.agents/skills/guide')
    await mkdir(join(dir, 'reference'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: guide\ndescription: remote guide\ntools:\n  bad: invalid\n---\nRemote instructions')
    const plain = join(home, '.agents/skills/plain')
    await mkdir(plain)
    await writeFile(join(plain, 'SKILL.md'), '---\nname: plain\ndescription: pure instructions\n---\nPure remote body')
    await writeFile(join(dir, 'reference/setup.md'), 'Nested remote resource')
    await writeFile(join(home, 'outside.txt'), 'must not leak')
    await symlink(join(home, 'outside.txt'), join(dir, 'escape.md'))
    const filesystem = new CapabilityFilesystem([{ workdirId: 'w', rootPath: home }])
    const requests: ExecutionRequestV2[] = []
    const executor = {
      async *execute(request: ExecutionRequestV2, signal: AbortSignal): AsyncIterable<JobEventV1> {
        requests.push(request)
        const base = { version: 1 as const, jobId: request.jobId, timestamp: new Date().toISOString() }
        try {
          const chunk = await filesystem.execute(request, signal)
          yield { ...base, type: 'stdout', sequence: 0, chunk }
          yield { ...base, type: 'completed', sequence: 1, receipt: { version: 1, jobId: request.jobId, nodeId: 'child', state: 'completed', finishedAt: base.timestamp } }
        } catch (error) {
          yield { ...base, type: 'failed', sequence: 1, receipt: { version: 1, jobId: request.jobId, nodeId: 'child', state: 'failed', finishedAt: base.timestamp, reason: { code: (error as {code: string}).code, message: String(error), retryable: false } } }
        }
      },
    } as Executor
    let scope: FolderSkillScope | undefined = { folderId: 'f', path: '/not/a/Main/path', workdir: { nodeId: 'child', workdirId: 'w' } }
    let targetId = 'w'
    const context = { sessionId: 's', signal: new AbortController().signal, resolveToolTarget: async (folder: string, operation: string) => {
      assert.equal(folder, 'f'); assert.equal(operation, 'filesystem.read')
      return { remoteWorkdir: { executor, nodeId: 'child', workdirId: targetId }, fileChangeTarget: { nodeId: 'child', workdirId: targetId } }
    } } as ExecutionContext
    let registered = 0
    const handlers = createSkillsHandler(new SkillsManager(home), async () => { registered++; return [] }, () => scope)
    assert.match(await handlers.read('folder', context), /remote guide/)
    assert.match(await handlers.read('folder/guide', context), /Remote instructions[\s\S]*execution is unavailable/)
    assert.equal(registered, 0)
    assert.match(await handlers.read('folder/plain', context), /Pure remote body/)
    await writeFile(join(dir, 'SKILL.md'), `---\n${JSON.stringify({name:'guide', description:'remote guide', tools:{remote_tool:{source:'tool.ts',description:'remote',parameters:{type:'object',properties:{}},imports:[]}}})}\n---\nRemote tool body`)
    assert.match(await handlers.read('folder/guide', context), /Remote tool body[\s\S]*execution is unavailable/)
    assert.equal(registered, 0)
    assert.equal(await handlers.read('folder/guide/reference/setup.md', context), 'Nested remote resource')
    await assert.rejects(async () => handlers.read('folder/guide/escape.md', context), /outside the granted/)
    for (const resource of ['../outside.txt', 'reference/../../outside.txt', 'C:\\outside', '/etc/passwd']) {
      await assert.rejects(async () => handlers.read(`folder/guide/${resource}`, context), /Invalid remote/)
    }
    await unlink(join(dir, 'escape.md'))
    const listing = await handlers.list(context, { subpath: 'folder/guide' })
    assert(listing.some(entry => entry.name === 'folder/guide/reference/setup.md' && entry.content === 'Nested remote resource'))
    assert.equal(registered, 0)
    await writeFile(join(dir, 'large.md'), 'x'.repeat(256 * 1024 + 1))
    await assert.rejects(async () => handlers.read('folder/guide/large.md', context), /size limit|too large|exceeds/i)
    targetId = 'replacement'
    await assert.rejects(async () => handlers.read('folder', context), /does not match/)
    targetId = 'w'
    context.signal = AbortSignal.abort()
    await assert.rejects(async () => handlers.read('folder', context), /abort/i)
    context.signal = new AbortController().signal
    await assert.rejects(async () => handlers.read('folder/guide/reference', context), /regular file/)
    scope = undefined
    assert.match(await handlers.read('folder/guide', context), /No selected folder/)
    assert(requests.every(request => request.operation === 'filesystem.read' && !JSON.stringify(request.args).includes('/not/a/Main/path')))
    const request = requests[0]
    await assert.rejects(filesystem.execute({ ...request, args: { path: 'outside.txt', within: '.agents/skills/guide' } }, context.signal), /outside the granted/)
    await assert.rejects(filesystem.execute({ ...request, args: { path: 'outside.txt', within: 1 } }, context.signal))
    await assert.rejects(filesystem.execute({ ...request, args: { path: '.', kind: 'directory' } }, context.signal), /invalid|Invalid/)
    await assert.rejects(filesystem.execute({ ...request, args: { path: '.', kind: 'file' } }, context.signal), /regular file/)
  })
})
