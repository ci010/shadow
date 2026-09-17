import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
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
    `**Workspace root (this session)**: \`${runtime.workdir.path}\``,
  ))
  assertEquals(runtime.workdir.path, resolve(workspace, 'discord_owner'))
})

test('folder workspace prompt distinguishes actual cwd from private uploads', async () => {
  const workspace = resolve('main')
  const path = resolve('folder-folder')
  const prompt = await workspaceProvider(workspace, new VirtualFs(), () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true, path },
  })).getPromptSection(context({ workdir: localFolderWorkdirRef('folder') }))
  assert(prompt?.includes(`**Workspace root (this session)**: \`${path}\``))
  assert(prompt?.includes(resolve(workspace, 'discord_top')))
  assert(prompt?.includes('**Session uploads**'))
  assert(prompt?.includes('not the registered folder'))
})

test('workspace prompt reports unavailable capability without a local path', async () => {
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

  assert((prompt ?? '').includes('**Workspace root (this session)**: unavailable'))
  assert((prompt ?? '').includes('**Node**: `child-node`'))
  assert((prompt ?? '').includes('**Capability**: `folder-capability`'))
  assert((prompt ?? '').includes('**Unavailable reason**: `node-missing`'))
  assertEquals(prompt?.includes(resolve(workspace, 'discord_top')), false)
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
      assert.match(prompt, /shared `\.tmp\/` name resolves from Home, not the workspace root/)
    } else {
      assert.doesNotMatch(prompt, /\*\*Session uploads\*\*:/)
      assert(!prompt.includes(folder))
      assert.match(prompt, kind === 'remote'
        ? /file and process operations must use the remote executor/
        : /workspace capability is unavailable. Local file operations cannot use it/)
    }
  }
})

test('compact memory guidance preserves write-role gating and persistence conventions', async () => {
  const provider = workspaceProvider(resolve('.test-data', 'prompt-memory'), new VirtualFs())
  for (const allowedTools of [['read', 'search'], ['read', 'search', 'write']]) {
    const prompt = (await provider.getPromptSection(context({
      agent: { ...agent, allowedTools },
    })))!
    assert.match(prompt, /Read\/search `v:memory\/` for relevant context, not as a substitute for current evidence/)
    if (allowedTools.includes('write')) {
      assert.match(prompt, /Files survive restarts; mental notes do not/)
      assert.match(prompt, /including explicit "remember this" requests/)
      assert.match(prompt, /Record mistakes.*save lessons in memory or update\/create relevant skills/)
      assert.match(prompt, /markdown links, not bare code spans/)
      assert.match(prompt, /Fix write-validation issues reported in tool results/)
    } else {
      assert.doesNotMatch(prompt, /Write what you need to remember|Record mistakes|Fix write-validation/)
    }
  }
})
