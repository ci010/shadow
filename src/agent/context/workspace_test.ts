import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { sessionWorkspacePath } from '../../utils/paths.ts'
import { resolve } from 'node:path'
import type { AgentTypeDefinition } from '../types/types.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { localFolderWorkdirRef, resolveSessionLocations } from '../../sessions/locality.ts'
import type { SessionPromptContext } from './builder.ts'
import { workspaceProvider } from './workspace.ts'
import { ContextBuilder } from './builder.ts'
import { guidelineProvider } from './guideline.ts'

const agent: AgentTypeDefinition = {
  name: 'test',
  description: '',
  prompt: '',
  defaultMode: 'task',
  soul: false,
  source: 'builtin',
}

function context(
  overrides: Partial<SessionPromptContext> = {},
): SessionPromptContext {
  return {
    behavior: {},
    channel: 'test',
    sessionId: 'discord:top',
    chatId: 'discord:top',
    agent,
    ...overrides,
  }
}

test('workspace prompt uses the same managed path as runtime locality', async () => {
  const workspace = resolve('workspace')
  const ctx = context({ workspaceRoot: 'discord:owner' })
  const runtime = resolveSessionLocations(workspace, ctx)
  const prompt = await workspaceProvider(workspace, new VirtualFs())
    .getPromptSection(ctx)

  if (!runtime.workdir.available || runtime.workdir.locality !== 'local') {
    throw new Error('expected local compatibility workdir')
  }
  assert((prompt ?? '').includes(
    `**Working directory**: \`${runtime.workdir.path}\``,
  ))
  assertEquals(runtime.workdir.path, sessionWorkspacePath(workspace, 'discord:owner'))
})

test('folder workspace prompt distinguishes actual cwd from private uploads', async () => {
  const workspace = resolve('main')
  const path = resolve('folder-folder')
  const prompt = await workspaceProvider(workspace, new VirtualFs(), () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true, path },
  })).getPromptSection(context({ workdir: localFolderWorkdirRef('folder') }))
  assert(prompt?.includes(`**Working directory**: \`${path}\``))
  assert(prompt?.includes(sessionWorkspacePath(workspace, 'discord:top')))
  assert(prompt?.includes('**Session uploads**'))
  assert(prompt?.includes('not the registered folder'))
})

test('file delivery guidance separates durable outputs from session drafts for every locality and role', async () => {
  for (const name of ['general', 'orchestrator']) {
    for (const kind of ['managed', 'folder', 'remote', 'unavailable'] as const) {
      const prompt = (await workspaceProvider(resolve('main'), new VirtualFs(), () => ({
        node: kind === 'unavailable' ? 'offline' : 'online',
        capability: { kind: 'workdir', online: true, path: resolve('selected-folder') },
      })).getPromptSection(context({
        agent: { ...agent, name },
        folderId: kind === 'folder' ? 'folder' : undefined,
        workdir: kind === 'managed' ? undefined : kind === 'folder'
          ? localFolderWorkdirRef('folder')
          : { version: 1, nodeId: 'child', capabilityId: 'remote-folder' },
      })))!
      assert.match(prompt, /Session-managed directories are draft spaces/)
      assert.match(prompt, /honor the user's explicit destination first/)
      assert.match(prompt, /when a Folder is selected, put finished deliverables in that Folder/)
      assert.match(prompt, /Documents, images in Pictures, videos in Videos, audio in Music/)
      assert.match(prompt, /downloaded files in Downloads/)
      assert.match(prompt, /Use a Shadow subfolder/)
      assert.match(prompt, /Use Desktop only when the user requests it/)
      assert.match(prompt, /localization and redirected or cloud-backed folders/)
      assert.match(prompt, /do not silently use session storage as final delivery/)
      assert.match(prompt, /Never remove user files or overwrite an existing destination without authorization/)
      assert.match(prompt, /verify that the final file was successfully saved/)
      assert.match(prompt, /must not be removed as part of session cleanup/)
      assert.match(prompt, /this guidance grants no additional access/)
      assert.match(prompt, /do not.*use Main user-folder paths for a remote device/i)
      if (name === 'orchestrator') assert.match(prompt, /carry these destination rules into the task/)
    }
  }
})

test('workspace prompt reports unavailable capability without treating session storage as execution cwd', async () => {
  const workspace = resolve('workspace')
  const ctx = context({
    workdir: {
      version: 1,
      nodeId: 'child-node',
      capabilityId: 'folder-capability',
      displayPathSnapshot: 'C:\\Folders\\example',
    },
  })
  const prompt = await workspaceProvider(workspace, new VirtualFs())
    .getPromptSection(ctx)

  assert((prompt ?? '').includes('**Working directory**: unavailable'))
  assert((prompt ?? '').includes('**Node**: `child-node`'))
  assert((prompt ?? '').includes('**Capability**: `folder-capability`'))
  assert((prompt ?? '').includes('**Unavailable reason**: `node-missing`'))
  assertEquals(prompt?.includes(sessionWorkspacePath(workspace, 'discord:top')), true)
  assert.match(prompt!, /## Session storage \(Main\)/)
  assert.match(prompt!, /private session storage; separate from the default execution directory/)
  assertEquals(prompt?.includes('C:\\Folders\\example'), false)
})

test('workspace owns upload guidance across local, remote and unavailable workdirs', async () => {
  const home = resolve('.test-data', 'prompt-home')
  const folder = resolve('.test-data', 'prompt-folder')
  for (const kind of ['managed', 'folder', 'remote', 'unavailable'] as const) {
    const ctx = context({
      workdir: kind === 'managed' ? undefined : kind === 'folder'
        ? localFolderWorkdirRef('fixture')
        : {
          version: 1, nodeId: 'child', capabilityId: 'fixture',
          displayPathSnapshot: 'C:\\DisplayOnly\\folder',
        },
    })
    const workspace = workspaceProvider(home, new VirtualFs(), () => ({
      node: kind === 'unavailable' ? 'offline' : 'online',
      capability: { kind: 'workdir', online: true, path: folder },
    }))
    const guideline = (await guidelineProvider().getPromptSection(ctx))!
    assert.doesNotMatch(guideline, /### Uploads|automatically saved|private session uploads/)
    const builder = new ContextBuilder(home)
    builder.register(guidelineProvider())
    builder.register(workspace)
    const prompt = await builder.buildSystemPrompt(ctx)
    assert.equal(prompt.match(/automatically saved in private session uploads/g)?.length, 1)
    assert.match(prompt, /absolute attachment paths supplied in messages; they are not remote workdir paths/)
    assert.match(prompt, /not the registered folder/)
    assert.doesNotMatch(prompt, /C:\\DisplayOnly\\folder/)
    if (kind === 'managed' || kind === 'folder') {
      const locations = resolveSessionLocations(home, ctx, undefined, () => ({
        node: 'online', capability: { kind: 'workdir', online: true, path: folder },
      }))
      assert(prompt.includes(resolve(locations.sessionDataDir, 'uploads')))
      assert.match(prompt, /shared `\.tmp\/` name resolves from the Project data directory, not the working directory/)
    } else {
      assert.match(prompt, /## Session storage \(Main\)/)
      assert.match(prompt, /\*\*Session uploads\*\*:/)
      assert.match(prompt, /private session storage; separate from the default execution directory/)
      assert(!prompt.includes(folder))
      assert.match(prompt, kind === 'remote'
        ? /File and process operations must use the remote executor/
        : /workdir capability is unavailable. Do not fall back to the Project data directory/)
    }
  }
})

test('knowledge requests direct every role to the Skill without inlining its manual or granting access', async () => {
  const fs = new VirtualFs()
  fs.mount('v:memory', 'Project memory', () => '')
  const provider = workspaceProvider(resolve('.test-data', 'wiki-alias'), fs)
  for (const name of ['orchestrator', 'general', 'sub']) {
    for (const allowedTools of [['read', 'search'], ['read', 'search', 'write']]) {
      const builder = new ContextBuilder(resolve('.test-data', 'wiki-alias'))
      builder.register(provider)
      const prompt = await builder.buildSystemPrompt(context({
        agent: { ...agent, name, allowedTools },
      }))
      assert.match(prompt, /Project memory, Wiki, knowledge or remembering facts, read `v:skills\/project-knowledge` before inspecting, editing or delegating knowledge work/)
      assert.match(prompt, /without granting permissions/)
      assert.equal(prompt.match(/v:skills\/project-knowledge/g)?.length, 1)
      assert.doesNotMatch(prompt, /canonical tool path|v:wiki|Session memory under|Files survive restarts|Write Wiki Markdown|Record mistakes|write-validation/)
      if (name === 'orchestrator') assert.match(prompt, /read Project Wiki and memory/)
    }
  }
})

test('coordinator workspace retains read context without worker resources or write instructions', async () => {
  const fs = new VirtualFs()
  for (const prefix of ['v:project', 'v:sessions', 'v:memory', 'v:tools', 'v:bg', 'v:skills', 'v:config', 'v:events']) {
    fs.mount(prefix, prefix === 'v:memory' ? 'read, search, and write memory' : `${prefix} resources`, () => '')
  }
  const provider = workspaceProvider(resolve('.test-data', 'coordinator-prompt'), fs)
  const prompt = (await provider.getPromptSection(context({
    agent: { ...agent, name: 'orchestrator' },
  })))!
  assert.match(prompt, /Working directory|Session uploads|absolute attachment paths/)
  assert.match(prompt, /Virtual resources:/)
  assert.doesNotMatch(prompt, /read\/search relevant Project memory|use `read`\/`search`/)
  for (const path of ['v:project', 'v:sessions', 'v:memory']) assert(prompt.includes(path))
  assert.doesNotMatch(prompt, /v:tools|v:bg|v:skills\/(?!project-knowledge)|v:config|v:events|write\(|read, search, and write|Write what you need|scratch\/ephemeral/)
  const ordinary = (await provider.getPromptSection(context()))!
  assert.match(ordinary, /v:tools|v:config/)
  assert.match(ordinary, /write\("notes.md"\)/)
})


test('environment names private session storage separately from default execution cwd', async () => {
  const home = resolve('.test-data', 'environment-home')
  const folder = resolve('.test-data', 'environment-folder')
  for (const kind of ['managed', 'inherited', 'folder'] as const) {
    const ctx = context({
      workspaceRoot: kind === 'inherited' ? 'web:owner' : undefined,
      workdir: kind === 'folder' ? localFolderWorkdirRef('fixture') : undefined,
    })
    const lookup = () => ({
      node: 'online' as const, capability: { kind: 'workdir' as const, online: true, path: folder },
    })
    const locations = resolveSessionLocations(home, ctx, undefined, lookup)
    const prompt = (await workspaceProvider(home, new VirtualFs(), lookup).getPromptSection(ctx))!
    assert(prompt.includes('**Session workspace**: `' + locations.sessionDataDir + '`'))
    assert.match(prompt, /default execution directory \(cwd\)/)
    assert.match(prompt, /unless a tool explicitly selects another cwd/)
    assert.match(prompt, /Home is internal application data, not an execution directory or deliverable destination/)
    assert.match(prompt, /Neither is a registered Project folder/)
    assert.match(prompt, kind === 'folder'
      ? /private session storage; separate from the default execution directory/
      : /also the default execution directory/)
  }
})

test('current session metadata mount is discoverable in the injected workspace prompt', async () => {
  const fs = new VirtualFs()
  fs.mount('v:session', 'self.json: read/write current session title, description and completed as JSON; identity is runtime-bound; task metadata is parent-owned', () => '{}')
  const provider = workspaceProvider(resolve('.test-data', 'self-metadata-prompt'), fs)
  const prompt = (await provider.getPromptSection(context()))!
  assert.match(prompt, /Virtual resources:/)
  assert.match(prompt, /v:session\/.*self\.json: read\/write current session/)
  assert.match(prompt, /identity is runtime-bound; task metadata is parent-owned/)
  assert.doesNotMatch(prompt, /update_self/)
})
