import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createMemoryHandler } from './mounts.ts'
import { VirtualFs } from './virtual-fs.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ReadTool } from '../tools/read.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { MemoryLinkCheckHook } from '../tools/hooks/memory-link-checker.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { RecordedFileChange } from '../sessions/file-change-contract.ts'

async function fixture(t: TestContext) {
  const scratch = resolve('.test-artifacts')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'memory-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'project-a')
  const cwd = join(root, 'registered-folder')
  await mkdir(home)
  await mkdir(cwd)
  const vfs = new VirtualFs()
  const memory = createMemoryHandler(home, 'a')
  vfs.mount('v:memory', 'Project memory', memory.read, memory.list, memory.write)
  const tool = new WriteTool(home, false, vfs)
  const base = new Tools(home)
  base.register(tool)
  const tools = new SessionTools(base, home)
  const changes: RecordedFileChange[] = []
  const context: ExecutionContext = {
    projectId: 'a', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn',
    sessionId: 'web:chat-memory', physicalSessionId: 'memory-0', cwd,
    signal: new AbortController().signal, tools, toolCallId: 'write-memory',
    recordFileChange: async change => { changes.push(change) },
  }
  return { root, home, cwd, memory, vfs, tool, base, tools, context, changes }
}

test('ordinary and reflection sessions write Project wiki memory through the same virtual path', async t => {
  const { home, cwd, vfs, tool, context, changes } = await fixture(t)
  const path = 'v:memory/topics/example.md'
  const content = '# Example\n\nA remembered fact.\n'
  assert.match(await tool.execute({ path, content }, context), /^OK write/)
  assert.equal(await readFile(join(home, 'memory', 'topics', 'example.md'), 'utf8'), content)
  await assert.rejects(readFile(join(cwd, 'memory', 'topics', 'example.md')), { code: 'ENOENT' })
  assert.equal(await new ReadTool(home, vfs).execute({ path }, context), content)
  assert.equal((await vfs.list('v:memory/topics', context))?.[0]?.path, path)
  const reflection = { ...context, sessionId: 'cron:reflection', physicalSessionId: 'reflection-0' }
  assert.match(await tool.execute({ path, match: 'remembered', content: 'corrected' }, reflection), /^OK edit/)
  assert.equal(await readFile(join(home, 'memory', 'topics', 'example.md'), 'utf8'), content.replace('remembered', 'corrected'))
  assert.equal(changes.length, 2, 'Virtual writes retain existing observed write history')
  assert.equal(changes[1].sessionId, reflection.sessionId)
  assert.equal(changes[1].path, join(home, 'memory', 'topics', 'example.md'))
  assert.ok(changes[1].patch.length)
})

test('memory exact edits reject missing or ambiguous matches and preserve literal replacement text', async t => {
  const { home, tool, context } = await fixture(t)
  const path = 'v:memory/tools/example.md'
  await tool.execute({ path, content: 'old\nold\n' }, context)
  for (const match of ['', 'missing', 'old']) {
    await assert.rejects(tool.execute({ path, match, content: 'new' }, context), /match|ambiguous/i)
    assert.equal(await readFile(join(home, 'memory', 'tools', 'example.md'), 'utf8'), 'old\nold\n')
  }
  await tool.execute({ path, match: 'old', content: '$& literal', flag: 'g' }, context)
  assert.equal(await readFile(join(home, 'memory', 'tools', 'example.md'), 'utf8'), '$& literal\n$& literal\n')
  assert.match(await tool.execute({ path, content: 'append', flag: 'a' }, context), /append is unsupported/)
})

test('virtual memory writes protect source records, internal state and paths outside the wiki', async t => {
  const { home, tool, context } = await fixture(t)
  await mkdir(join(home, 'memory', 'sessions'), { recursive: true })
  await writeFile(join(home, 'memory', 'sessions', 'source.md'), 'source')
  for (const path of [
    'v:memory', 'v:memory/../outside.md', 'v:memory/topics/../../outside.md',
    'v:memory/topics\\..\\outside.md', 'v:memory//absolute.md', 'v:memory/C:/outside.md',
    'v:memory/sessions/source.md', 'v:memory/SESSIONS/source.md', 'v:memory/events/today.md',
    'v:memory/.reflect-watermark.json', 'v:memory/identities/index.json', 'v:memory/.hidden.md',
    'v:memory/topics/.hidden/note.md', 'v:memory/topics/note.md:stream', 'v:memory/topics/NUL.md',
    'v:memory/sessions /source.md', 'v:memory/topics/note.md ',
  ]) {
    await assert.rejects(tool.execute({ path, content: 'overwrite' }, context), /memory|wiki|path/i, path)
  }
  assert.equal(await readFile(join(home, 'memory', 'sessions', 'source.md'), 'utf8'), 'source')
  await assert.rejects(readFile(join(home, 'outside.md')), { code: 'ENOENT' })
})

test('memory stays Project-bound and keeps cancellation, tool filtering and execution-mode restrictions', async t => {
  const { home, tool, base, context } = await fixture(t)
  const args = { path: 'v:memory/topics/example.md', content: 'fact' }
  await assert.rejects(tool.execute(args, { ...context, projectId: 'b' }), /different Project/)
  await assert.rejects(tool.execute(args, { ...context, projectId: undefined }), /different Project/)
  await assert.rejects(tool.execute(args, { ...context, signal: AbortSignal.abort() }), { name: 'AbortError' })
  const callTools = new SessionTools(base, home)
  t.mock.getter(callTools, 'executionMode', () => 'call')
  await assert.rejects(tool.execute(args, { ...context, tools: callTools }), /call mode/)
  await assert.rejects(tool.execute(args, { ...context, remoteWorkdir: {
    nodeId: 'other-node', capabilityId: 'workdir', executor: {
      async *execute() { throw new Error('No remote execution expected') },
      async getStatus() { throw new Error('No remote query expected') },
      async cancel() { throw new Error('No remote cancellation expected') },
    },
  } }), /local workdir/)
  const denied = new SessionTools(base, home, ['read'])
  assert.match(requireToolText(await denied.execute('write', args, { ...context, tools: denied })), /not found|not available|not allowed/i)
  await assert.rejects(readFile(join(home, 'memory', 'topics', 'example.md')), { code: 'ENOENT' })
})

test('memory writes reject junctions and hard links into protected or other Project data', async t => {
  const { root, home, tool, context } = await fixture(t)
  const other = join(root, 'project-b')
  await mkdir(other)
  await writeFile(join(other, 'original.md'), 'untouched')
  await mkdir(join(home, 'memory'))
  await symlink(other, join(home, 'memory', 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(tool.execute({ path: 'v:memory/alias/original.md', content: 'bad' }, context), /symlinks|junctions/)
  await link(join(other, 'original.md'), join(home, 'memory', 'linked.md'))
  await assert.rejects(tool.execute({ path: 'v:memory/linked.md', content: 'bad' }, context), /hard links/)
  assert.equal(await readFile(join(other, 'original.md'), 'utf8'), 'untouched')
  const linkedHome = join(root, 'linked-home')
  await mkdir(linkedHome)
  await symlink(other, join(linkedHome, 'memory'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(async () => createMemoryHandler(linkedHome, 'a').write('original.md', { content: 'bad' }, context), /symlinks|junctions/)
  assert.equal(await readFile(join(other, 'original.md'), 'utf8'), 'untouched')
})

test('memory-link diagnostics still run for successful virtual writes', async t => {
  const { home, base, tools, context } = await fixture(t)
  base.addHook(new MemoryLinkCheckHook(home))
  const result = requireToolText(await tools.execute('write', {
    path: 'v:memory/topics/example.md', content: '# Example\n[Missing](missing.md)\n',
  }, context))
  assert.match(result, /^OK write/)
  assert.match(result, /dead link/i)
})
