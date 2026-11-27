import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { pngFixture } from '../testing/image.ts'
import { MAX_IMAGE_BYTES } from '../utils/image-input.ts'
import { join } from 'node:path'
import type { ExecutionContext } from './context.ts'
import type { Executor } from '../execution/executor.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { resolveExplicitToolTarget, resolveWorkdirToolTarget } from '../execution/tool-target.ts'
import { executionTargetContext, executionTargetParameters } from './execution-target.ts'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { SearchTool } from './search.ts'
import { readSessionEditPatch } from '../vfs/session-edit-patch.ts'
import { Tools, SessionTools } from './registry.ts'
import { UseProjectTool } from './use-project.ts'
import { ExecTool } from './shell.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { requireToolText } from './tool.ts'
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
    let offline = false
    const executor: Executor = {
      getStatus: async () => null, cancel: async () => { throw new Error('not used') },
      async *execute(request, signal) {
        calls++
        if (offline) throw new Error('Child unavailable fixture')
        assert.equal(request.nodeId, 'child'); assert.equal(request.workdirId, 'approved')
        const isCommand = request.operation === 'workdir.process.execute-once'
        if (isCommand) assert.equal((request.args as { script?: string }).script, 'echo checked')
        const chunk = isCommand ? 'checked\n' : await filesystem.execute(request, signal)
        const timestamp = new Date().toISOString()
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk }
        yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed', receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', ...(isCommand ? { exitCode: 0 } : {}), finishedAt: timestamp } }
      },
    }
    const registry = new Tools(main)
    registry.register(new UseProjectTool({ projectId: 'test', folders: {
      list: () => [folder], requireAvailable: async () => folder,
      requireExecutionAvailable: async () => folder, acquireAccess: () => () => {},
    } }))
    const sessionTools = new SessionTools(registry, main, ['read', 'write', 'search', 'exec'])
    // Host target resolution must work even when context switching is not exposed.
    assert.equal(sessionTools.get('workspace_use'), undefined)
    let change: RecordedFileChange | undefined
    const context: ExecutionContext = { ...base, tools: sessionTools, cwd: main, toolCallId: 'write-call',
      resolveToolTarget: async (identifier, operation) => resolveExplicitToolTarget(main, base,
        ref => ref.nodeId === 'child' && ref.workdirId === 'approved' ? { node: 'online', workdir: { online: true } } : { node: 'missing' },
        executor, await sessionTools.executionTargetFolder(identifier, base.signal), operation),
      recordFileChange: async value => { change = value }, readFileChange: async () => change,
    }
    const read = new ReadTool(main)
    assert.equal(await read.execute({ path: 'note.txt' }, context), 'main-unchanged')
    assert.equal(await read.execute({ folder: 'child', path: 'note.txt' }, context), 'child-before')
    await new WriteTool(main).execute({ folder: folder.id, path: 'note.txt', content: 'child-after' }, context)
    assert.equal(await readFile(join(main, 'note.txt'), 'utf8'), 'main-unchanged')
    assert.equal(await readFile(join(child, 'note.txt'), 'utf8'), 'child-after')
    assert.deepEqual(change?.target, { nodeId: 'child', workdirId: 'approved', folderId: folder.id })
    assert.match(await readSessionEditPatch(`self/edits/${change!.id}`, context), /Recorded on node "child", workdir "approved"/)
    assert.equal(context.cwd, main); assert.equal(context.remoteWorkdir, undefined)
    const childImage = pngFixture(400, 400)
    assert(childImage.length > 256 * 1024)
    await writeFile(join(child, 'photo.png'), childImage)
    await writeFile(join(main, 'photo.png'), pngFixture())
    const result = await read.execute({ folder: 'child', path: 'photo.png' }, context)
    assert(typeof result !== 'string')
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Image from "photo.png" (image/png, 400 x 400).' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${childImage.toString('base64')}`, detail: 'auto' } },
    ])
    const readChild = (path: string) => read.execute({ folder: 'child', path }, context)
    await writeFile(join(child, 'invalid.png'), 'not an image')
    await assert.rejects(readChild('invalid.png'), /Invalid image header/)
    await writeFile(join(child, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1))
    await assert.rejects(readChild('large.png'), /exceeds 5 MiB/)
    await assert.rejects(readChild('../main/photo.png'), /outside the granted capability/)
    if (process.platform !== 'win32') {
      await symlink(join(main, 'photo.png'), join(child, 'outside.png'))
      await assert.rejects(readChild('outside.png'), /outside the granted capability/)
    }
    await writeFile(join(main, 'local-only.png'), pngFixture())
    await assert.rejects(readChild('local-only.png'), /not found/)
    const before = calls
    await assert.rejects(read.execute({ folder: 'child', path: 'photo.png', limit: 1 }, context), /Images do not support line paging/)
    await assert.rejects(read.execute({ folder: 'child', path: 'photo.png' }, { ...context, javascriptInvocation: true }), /accepts text only/)
    await assert.rejects(read.execute({ folder: 'foreign', path: 'note.txt' }, context), /Unknown or ambiguous/)
    assert.equal(calls, before)
    assert.equal(await new SearchTool(main, undefined, undefined, false).execute({ folder: 'child', handler: 'grep', query: 'x' }, context), 'No matches found')
    assert.equal(calls, before + 1)

    registry.register(read)
    registry.register(new WriteTool(main))
    registry.register(new SearchTool(main, undefined, undefined, false))
    const js = new ExecTool(main, 15_000, new CommandHandlerManager(), new ProcessManager(), 'sh', {} as BackgroundTaskManager)
    registry.register(js)
    const script = `
      import importedRead from '@shadow/read'
      export default async ([value, shell]) => {
        if (read !== importedRead) throw Error('Read adapters differ')
        const before = await read({ path: 'note.txt' })
        const found = await search({ handler: 'grep', path: '.', query: before })
        if (!found) throw Error('Search result missing')
        await write({ path: 'note.txt', content: value })
        const tested = await exec({ script: 'echo checked', shell, timeout_ms: 5000 })
        return { before, tested }
      }
    `
    for (const [workspace, value, before] of [[undefined, 'local-js', 'main-unchanged'], ['child', 'child-js', 'child-after']] as const) {
      const output = await js.execute({ shell: 'javascript', workspace, script, args: [value, process.platform === 'win32' ? 'cmd' : 'sh'] }, context)
      const result = JSON.parse(requireToolText(output)).result
      assert.equal(result?.before, before, requireToolText(output))
      assert.match(result.tested, /checked/)
    }
    assert.equal(await readFile(join(main, 'note.txt'), 'utf8'), 'local-js')
    assert.equal(await readFile(join(child, 'note.txt'), 'utf8'), 'child-js')
    const count = calls
    for (const args of [{ workspace: 'local', path: 'note.txt' }, { path: '../note.txt' }, { path: 'v:sessions/self.json' }]) {
      const output = await js.execute({ shell: 'javascript', workspace: 'child', script: `import read from '@shadow/read'; await read(${JSON.stringify(args)})` }, context)
      assert.match(requireToolText(output), /bound target/)
    }
    await assert.rejects(js.execute({ shell: 'javascript', workspace: 'foreign', script }, context), /Unknown or ambiguous/)
    assert.equal(calls, count)
    offline = true
    const output = await js.execute({ shell: 'javascript', workspace: 'child', script, args: ['must-not-write', 'sh'] }, context)
    assert.match(requireToolText(output), /Child unavailable fixture/)
    assert.equal(JSON.parse(requireToolText(output)).ok, false)
    assert.equal(calls, count + 1)
    assert.equal(await readFile(join(main, 'note.txt'), 'utf8'), 'local-js')
    assert.equal(await readFile(join(child, 'note.txt'), 'utf8'), 'child-js')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Folder selection rejects raw addresses, virtual/URL/web routes, invalid selectors and absent host resolver', async () => {
  assert.deepEqual(Object.keys(executionTargetParameters), ['workspace'])
  for (const args of [{ nodeId: 'child' }, { capabilityId: 'approved' }, { workdirId: 'approved' }, { nodeId: 'child', workdirId: 'approved' }, { grant: 'not-a-token' }, { nodeId: 'child', capabilityId: 'approved' }, { folder: '' }, { folder: 'child' }]) {
    await assert.rejects(executionTargetContext(args, base, 'filesystem.read'))
  }
  for (const path of ['v:memory/a', 'https://example.com', '/main/v:memory/a', 'foo/../v:tools']) {
    await assert.rejects(executionTargetContext({ folder: 'child', path }, { ...base, async resolveToolTarget() { throw new Error('must not resolve') } }, 'filesystem.read'), /ordinary filesystem/)
  }
  assert.equal(await executionTargetContext({ shell: 'javascript' }, base, 'workdir.process.execute-once'), base)
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
  await assert.rejects(executionTargetContext(args, { ...context, recoveringToolCall: false }, 'workdir.process.execute-once'), /Use workspace/)
  await assert.rejects(executionTargetContext(args, context, 'filesystem.write'), /Use workspace/)
  await assert.rejects(executionTargetContext({ ...args, folder: 'new' }, context, 'workdir.process.execute-once'), /Use workspace/)
  assert.equal(calls, 1)
})


test('session Folder resolution preserves host errors, aborts and survives dynamic-tool reset', async () => {
  const registry = new Tools('.')
  let available = true
  const verified: AbortSignal[] = []
  registry.register(new UseProjectTool({ projectId: 'test', folders: {
    list: () => [folder], requireAvailable: async () => folder,
    requireExecutionAvailable: async (id, signal = new AbortController().signal) => {
      assert.equal(id, folder.id)
      verified.push(signal)
      if (!available) throw new Error('Selected folder is offline')
      return folder
    }, acquireAccess: () => () => {},
  } }))
  const session = new SessionTools(registry, '.', ['read'])
  const signal = new AbortController().signal
  assert.equal(await session.executionTargetFolder('child', signal), folder)
  assert.equal(verified[0], signal)
  await session.resetDynamicAndWait()
  assert.equal(await session.executionTargetFolder(folder.id, signal), folder)
  await assert.rejects(session.executionTargetFolder('unknown', signal), /Unknown or ambiguous/)
  available = false
  await assert.rejects(session.executionTargetFolder('child', signal), /Selected folder is offline/)
  const before = verified.length
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(session.executionTargetFolder('child', abort.signal), { name: 'AbortError' })
  assert.equal(verified.length, before)
  const absent = new SessionTools(new Tools('.'), '.')
  await assert.rejects(absent.executionTargetFolder('child', signal), /targeting is unavailable/)
})

test('workspace is advertised; hidden folder alias is equivalent and mixed selectors fail before resolution', async () => {
  const seen: string[] = []
  const context = { signal: new AbortController().signal, async resolveToolTarget(selector: string) {
    seen.push(selector)
    return { cwd: '/registered' }
  } } as unknown as ExecutionContext
  assert.equal((await executionTargetContext({ workspace: 'child' }, context, 'filesystem.read')).cwd, '/registered')
  assert.equal((await executionTargetContext({ folder: 'child' }, context, 'filesystem.read')).cwd, '/registered')
  await assert.rejects(executionTargetContext({ workspace: 'child', folder: 'child' }, context, 'filesystem.read'), /not both/)
  assert.deepEqual(seen, ['child', 'child'])
})

test('device home selectors cannot resolve to a local, different remote, or scripted target', async () => {
  const args = { workspace: 'device:child', path: '~' }
  const context = (target: unknown) => ({ signal: new AbortController().signal,
    resolveToolTarget: async () => target }) as unknown as ExecutionContext
  for (const target of [{ cwd: '/main' }, { remoteWorkdir: { nodeId: 'other', workdirId: 'device-home-v1' } },
    { remoteWorkdir: { nodeId: 'child', workdirId: 'other' } }]) {
    await assert.rejects(executionTargetContext(args, context(target), 'filesystem.read'), /No Main fallback/)
  }
  const remote = { remoteWorkdir: { nodeId: 'child', workdirId: 'device-home-v1' } }
  assert.equal((await executionTargetContext(args, context(remote), 'filesystem.read')).remoteWorkdir, remote.remoteWorkdir)
  await assert.rejects(executionTargetContext(args, { ...context(remote), scriptInvocation: true }, 'filesystem.read'), /direct owner/)
  await assert.rejects(executionTargetContext(args, context(remote), 'filesystem.write'), /direct owner/)
})

test('dynamic validation accepts only builtin hidden alias and rejects mixed selectors', async () => {
  const tools = new SessionTools(new Tools('.'), '.')
  tools.registerDynamic(new ReadTool('.'))
  const context = { ...base, tools }
  const alias = await tools.executeDynamic('read', { folder: 'child', path: 'note.txt' }, context)
  assert.match(String(alias), /targeting is unavailable/)
  assert.doesNotMatch(String(alias), /invalid arguments/)
  assert.match(String(await tools.executeDynamic('read', { folder: 'child', workspace: 'child', path: 'note.txt' }, context)), /not both/)
  tools.registerDynamic({ name: 'business', description: 'fixture', parameters: { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false }, execute: async args => String(args.folder) })
  assert.equal(await tools.executeDynamic('business', { folder: 'inbox' }, context), 'inbox')
  assert.match(String(await tools.executeDynamic('business', { workspace: 'inbox' }, context)), /invalid arguments/)
})

test('workspace_use advertises required workspace and rejects mixed or extra keys before acquiring access', async () => {
  let acquired = 0
  const tool = new UseProjectTool({ projectId: 'test', folders: {
    list: () => [folder], requireAvailable: async () => folder,
    requireExecutionAvailable: async () => folder, acquireAccess: () => { acquired++; return () => {} },
  } })
  assert.deepEqual(tool.parameters.required, ['workspace'])
  assert.deepEqual(Object.keys(tool.parameters.properties), ['workspace'])
  const context = { ...base, projectId: 'test', toolCallName: 'workspace_use', switchProjectFolder: async () => 'switched' }
  await assert.rejects(tool.execute({ workspace: 'child', folder: 'child' }, context), /not both/)
  await assert.rejects(tool.execute({ workspace: 'child', extra: true }, context), /Expected only workspace/)
  assert.equal(acquired, 0)
  // The hidden alias still reaches the exact registered remote target and fails
  // closed at the existing scoped-instruction boundary, without switching.
  await assert.rejects(tool.execute({ folder: 'child' }, context), /Remote workspace instruction reads are unavailable/)
  assert.equal(acquired, 1)
})
