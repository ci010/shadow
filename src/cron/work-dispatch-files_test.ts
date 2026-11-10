import assert from 'node:assert/strict'
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { ProjectDispatchFiles } from './work-dispatch-files.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { RecordedFileChange } from '../sessions/file-change-contract.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'

const instructionName = 'dispatch-instructions.md'
const memoryName = 'dispatch-memory.md'

async function fixture(t: TestContext) {
  const scratch = resolve('.test-artifacts')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'work-dispatch-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'project-a')
  const cwd = join(root, 'registered-workspace')
  await mkdir(cwd)
  const service = new ProjectDispatchFiles(home, 'a')
  const handlers = service.handlers()
  const vfs = new VirtualFs()
  vfs.mount('v:project', 'Project resources', handlers.read, handlers.list, handlers.write)
  const writer = new WriteTool(home, false, vfs)
  const reader = new ReadTool(home, vfs)
  const base = new Tools(home)
  base.register(writer)
  const tools = new SessionTools(base, home)
  const changes: RecordedFileChange[] = []
  const context: ExecutionContext = {
    projectId: 'a', channel: 'test', chatId: 'chat', senderId: 'user', messageId: 'turn',
    sessionId: 'web:ordinary', physicalSessionId: 'ordinary-0', cwd, tools,
    signal: new AbortController().signal, toolCallId: 'write-dispatch',
    fileChangeTarget: { nodeId: 'main', workdirId: 'selected-workspace', folderId: 'folder-a' },
    recordFileChange: async change => { changes.push(change) },
  }
  const stored = (name: string) => join(home, 'state', 'work-dispatch', name)
  return { root, home, cwd, service, handlers, vfs, writer, reader, tools, context, changes, stored }
}

test('missing dispatch files read empty and remain discoverable without creating templates or directories', async t => {
  const { home, service, handlers, vfs, context } = await fixture(t)
  assert.equal(await service.instructions(), '')
  assert.equal(await service.memory(), '')
  assert.equal(await handlers.read(instructionName, context), '')
  assert.equal(await handlers.read(memoryName, context), '')
  assert.match(await handlers.read('', context), /optional dispatcher ideas\/scratchpad; not a fact database/)
  assert.deepEqual(await handlers.list(context), [
    { name: instructionName, content: '' }, { name: memoryName, content: '' },
  ])
  assert.deepEqual((await vfs.list('v:project', context, { content: false }))?.map(entry => entry.path), [
    `v:project/${instructionName}`, `v:project/${memoryName}`,
  ])
  await assert.rejects(lstat(home), { code: 'ENOENT' })
})

test('ordinary sessions customize Project instructions and dispatcher reads see every update independent of cwd', async t => {
  const { home, cwd, root, service, writer, reader, context, vfs, stored, changes } = await fixture(t)
  const path = `v:project/${instructionName}`
  assert.match(await writer.execute({ path, content: 'Prefer small independent jobs.\n' }, context), /^OK write \+1 -0 edit=/)
  assert.equal(await service.instructions(), 'Prefer small independent jobs.\n')
  assert.equal(await service.memory(), '')
  assert.equal(await reader.execute({ path }, { ...context, cwd: root }), 'Prefer small independent jobs.\n')
  const secondSession = { ...context, sessionId: 'web:other', physicalSessionId: 'other-0', cwd: undefined }
  assert.match(await writer.execute({ path, match: 'small independent', content: 'reviewable' }, secondSession), /^OK edit .*edit=/)
  assert.equal(await service.instructions(), 'Prefer reviewable jobs.\n')
  await writeFile(stored(instructionName), 'external synthetic customization')
  assert.equal(await service.instructions(), 'external synthetic customization', 'host reads are not cached')
  const dispatcher = { ...context, sessionId: 'cron:work-dispatch:run', physicalSessionId: 'dispatch-0', cwd: root }
  assert.match(await writer.execute({ path: `v:project/${memoryName}`, content: 'Idea: inspect blocked dependencies next run.\n' }, dispatcher), /^OK write/)
  assert.equal(await service.memory(), 'Idea: inspect blocked dependencies next run.\n')
  assert.equal(await new ProjectDispatchFiles(home, 'a').memory(), await service.memory(), 'persists across service recreation')
  assert.deepEqual(await vfs.list(`v:project/${memoryName}`, context), [{
    path: `v:project/${memoryName}`, name: memoryName, content: await service.memory(),
  }])
  assert.ok(changes.every(change => change.path.startsWith(join(home, 'state', 'work-dispatch'))))
  assert.ok(changes.every(change => change.target === undefined), 'receipts must not misattribute Project state to selected workspace')
  assert.equal(changes[1].sessionId, secondSession.sessionId)
  assert.ok(changes[1].patch.includes('-Prefer small independent jobs.'))
  await assert.rejects(lstat(join(cwd, 'state')), { code: 'ENOENT' })
  if (process.platform !== 'win32') assert.equal((await lstat(stored(memoryName))).mode & 0o777, 0o600)
  assert.deepEqual((await readdir(join(home, 'state', 'work-dispatch'))).sort(), [instructionName, memoryName])
})

test('glob and grep discover exactly the two Project documents, including exact-file search', async t => {
  const { home, handlers, vfs, context } = await fixture(t)
  const search = new SearchTool(home, undefined, vfs)
  assert.equal(await search.execute({ handler: 'glob', path: 'v:project', query: 'dispatch-*.md' }, context),
    `v:project/${instructionName}\nv:project/${memoryName}`)
  await handlers.write(instructionName, { content: 'Prefer independent work.\n' }, context)
  await handlers.write(memoryName, { content: 'Idea: revisit dependency graph.\n' }, context)
  assert.equal(await search.execute({ handler: 'grep', path: `v:project/${memoryName}`, query: 'dependency' }, context),
    `v:project/${memoryName}:  Line 1: Idea: revisit dependency graph.`)
  assert.match(await search.execute({ handler: 'grep', path: 'v:project', query: 'independent' }, context), /dispatch-instructions\.md/)
  assert.equal(await search.execute({ handler: 'grep', path: 'v:project', query: 'not-present' }, context), 'No matches found')
  await assert.rejects(search.execute({ handler: 'glob', path: 'v:project', query: '*' }, { ...context, projectId: 'b' }), /different Project/)
})

test('exact edits reuse normal writer semantics for BOM, CRLF, global replacement, errors and no-op receipts', async t => {
  const { service, writer, context, changes } = await fixture(t)
  const path = `v:project/${instructionName}`
  const original = '\uFEFFfirst\r\nold\r\nlast\r\n'
  await writer.execute({ path, content: original }, context)
  assert.match(await writer.execute({ path, match: 'first\nold\n', content: '$& literal\nnew\n' }, context), /^OK edit/)
  assert.equal(await service.instructions(), '\uFEFF$& literal\r\nnew\r\nlast\r\n')
  await writer.execute({ path, content: 'same\nsame\n' }, context)
  const recorded = changes.length
  for (const match of ['', 'missing', 'same']) {
    assert.match(await writer.execute({ path, match, content: 'replacement' }, context), /^Error: match/)
    assert.equal(await service.instructions(), 'same\nsame\n')
  }
  assert.equal(changes.length, recorded, 'failed edits do not create receipts or modify files')
  assert.match(await writer.execute({ path, match: 'same', content: '$& literal', flag: 'g' }, context), /Replacements: 2; match: exact/)
  assert.equal(await service.instructions(), '$& literal\n$& literal\n')
  assert.match(await writer.execute({ path, match: '$& literal', content: '$& literal', flag: 'g' }, context), /Content unchanged/)
  assert.match(await writer.execute({ path, content: 'unsupported', flag: 'a' }, context), /append is unsupported/)
  assert.equal(await service.instructions(), '$& literal\n$& literal\n')
  assert.match(await writer.execute({ path: `v:project/${memoryName}`, match: 'missing', content: 'value' }, context), /^Error: file not found/)
  assert.equal(await service.memory(), '')
})

test('every handler enforces Project binding, memory leases and cancellation before reading or writing', async t => {
  const { service, handlers, context, stored } = await fixture(t)
  await handlers.write(instructionName, { content: 'Project A only' }, context)
  for (const projectId of ['b', undefined]) {
    const other = { ...context, projectId }
    await assert.rejects(async () => handlers.read(instructionName, other), /different Project/)
    await assert.rejects(async () => handlers.read('', other), /different Project/)
    await assert.rejects(async () => handlers.list(other, { content: false }), /different Project/)
    await assert.rejects(async () => handlers.list(other, { subpath: memoryName }), /different Project/)
    await assert.rejects(async () => handlers.write(memoryName, { content: 'bad' }, other), /different Project/)
  }
  for (const options of [{ signal: AbortSignal.abort() }, { memoryAccess: {} as NonNullable<ExecutionContext['memoryAccess']> }]) {
    const denied = { ...context, ...options }
    const expected = 'memoryAccess' in options ? /memory leases/ : { name: 'AbortError' }
    await assert.rejects(async () => handlers.read(instructionName, denied), expected)
    await assert.rejects(async () => handlers.list(denied, { content: false }), expected)
    await assert.rejects(async () => handlers.write(memoryName, { content: 'bad' }, denied), expected)
  }
  assert.equal(await service.instructions(), 'Project A only')
  await assert.rejects(lstat(stored(memoryName)), { code: 'ENOENT' })
})

test('fixed subpaths reject arbitrary paths, traversal, query strings and aliases for all handlers', async t => {
  const { handlers, context, home } = await fixture(t)
  for (const subpath of [
    '../dispatch-memory.md', 'dispatch-instructions.md/..', 'nested/dispatch-memory.md',
    '/dispatch-memory.md', 'dispatch-memory.md/', 'dispatch-memory.md?x=1',
    'dispatch-memory.md:stream', 'dispatch-memory.md\u0000', '..\\dispatch-memory.md',
    '%2e%2e/dispatch-memory.md', 'DISPATCH-MEMORY.md', home, 'anything.md',
  ]) {
    await assert.rejects(async () => handlers.read(subpath, context), /Invalid dispatch path/)
    await assert.rejects(async () => handlers.list(context, { subpath }), /Invalid dispatch path/)
    await assert.rejects(async () => handlers.write(subpath, { content: 'bad' }, context), /Invalid dispatch path/)
  }
  await assert.rejects(async () => handlers.write('', { content: 'bad' }, context), /Invalid dispatch path/)
  await assert.rejects(lstat(home), { code: 'ENOENT' })
})

test('call-mode stays forbidden while remote-bound ordinary sessions write Project state locally', async t => {
  const { handlers, writer, context, home, service, changes } = await fixture(t)
  const callTools = new SessionTools(new Tools(home), home)
  t.mock.getter(callTools, 'executionMode', () => 'call')
  const remoteWorkdir: NonNullable<ExecutionContext['remoteWorkdir']> = {
    nodeId: 'other-node', workdirId: 'other-workdir', executor: {
      async *execute() { throw new Error('Remote execution must not happen') },
      async getStatus() { throw new Error('Remote query must not happen') },
      async cancel() { throw new Error('Remote cancellation must not happen') },
    },
  }
  const denied = { ...context, tools: callTools }
  await assert.rejects(async () => handlers.write(memoryName, { content: 'bad' }, denied), /call mode/)
  await assert.rejects(writer.execute({ path: `v:project/${memoryName}`, content: 'bad' }, denied), /call mode/)
  await assert.rejects(lstat(home), { code: 'ENOENT' })
  const remote = { ...context, remoteWorkdir }
  assert.match(await handlers.write(memoryName, { content: 'local Project scratchpad' }, remote), /^OK write/)
  assert.equal(await service.memory(), 'local Project scratchpad')
  assert.equal(changes.at(-1)?.target, undefined, 'Project state must not be attributed to the remote workspace')
  assert.match(await writer.execute({ path: `v:project/${instructionName}`, content: 'remote-session customization' }, remote), /^OK write/)
  assert.equal(await service.instructions(), 'remote-session customization')
  assert.equal(changes.at(-1)?.target, undefined)
})

test('reads and writes refuse symlink and hard-link aliases to other Project data', async t => {
  const { root, home, service, handlers, context, stored } = await fixture(t)
  const other = join(root, 'project-b')
  await mkdir(other)
  const protectedFile = join(other, instructionName)
  await writeFile(protectedFile, 'untouched synthetic Project B data')
  await mkdir(join(home, 'state', 'work-dispatch'), { recursive: true })
  for (const alias of ['symlink', 'hardlink']) {
    if (alias === 'symlink') await symlink(protectedFile, stored(instructionName))
    else await link(protectedFile, stored(instructionName))
    await assert.rejects(service.instructions(), /symlinks|hard links/)
    await assert.rejects(async () => handlers.read(instructionName, context), /symlinks|hard links/)
    await assert.rejects(async () => handlers.list(context), /symlinks|hard links/)
    await assert.rejects(async () => handlers.write(instructionName, { content: 'bad' }, context), /symlinks|hard links/)
    assert.equal(await readFile(protectedFile, 'utf8'), 'untouched synthetic Project B data')
    await rm(stored(instructionName))
  }
  await rm(join(home, 'state', 'work-dispatch'), { recursive: true })
  await symlink(other, join(home, 'state', 'work-dispatch'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(service.instructions(), /symlinks|junctions/)
  await assert.rejects(async () => handlers.write(instructionName, { content: 'bad' }, context), /symlinks|junctions/)
  assert.equal(await readFile(protectedFile, 'utf8'), 'untouched synthetic Project B data')
})

test('concurrent exact edits serialize across service instances and a failed edit does not poison subsequent writes', async t => {
  const { home, handlers, context, service } = await fixture(t)
  await handlers.write(memoryName, { content: 'first second' }, context)
  const other = new ProjectDispatchFiles(home, 'a').handlers()
  const receipts = await Promise.all([
    handlers.write(memoryName, { match: 'first', content: 'FIRST' }, context),
    other.write(memoryName, { match: 'second', content: 'SECOND' }, context),
  ])
  assert.ok(receipts.every(result => result.startsWith('OK edit')))
  assert.equal(await service.memory(), 'FIRST SECOND')
  const denied = { ...context, signal: AbortSignal.abort() }
  await assert.rejects(async () => handlers.write(memoryName, { content: 'bad' }, denied), { name: 'AbortError' })
  await handlers.write(memoryName, { content: 'recovered' }, context)
  assert.equal(await service.memory(), 'recovered')
})

test('binary exact edits do not corrupt state, but explicit full overwrite can repair it', async t => {
  const { handlers, context, stored, service } = await fixture(t)
  await handlers.write(memoryName, { content: 'text' }, context)
  const binary = Buffer.from([0xff, 0x00, 0x61])
  await writeFile(stored(memoryName), binary)
  await assert.rejects(async () => handlers.write(memoryName, { match: 'a', content: 'b' }, context), /requires? UTF-8/)
  assert.deepEqual(await readFile(stored(memoryName)), binary)
  assert.match(await handlers.write(memoryName, { content: 'repaired' }, context), /Diff unavailable/)
  assert.equal(await service.memory(), 'repaired')
})

test('receipt persistence errors report the committed write and forbid blind retry', async t => {
  const { handlers, service, context, home } = await fixture(t)
  const failing = { ...context, recordFileChange: async () => { throw new Error('synthetic receipt failure') } }
  await assert.rejects(async () => handlers.write(memoryName, { content: 'committed once' }, failing), /file was written.*Do not retry/s)
  assert.equal(await service.memory(), 'committed once')
  assert.deepEqual(await readdir(join(home, 'state', 'work-dispatch')), [memoryName], 'atomic staging files are cleaned')
})
