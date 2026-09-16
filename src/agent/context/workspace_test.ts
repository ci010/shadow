import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import type { AgentTypeDefinition } from '../types/types.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { localProjectWorkdirRef, resolveSessionLocations } from '../../sessions/locality.ts'
import type { SessionPromptContext } from './builder.ts'
import { workspaceProvider } from './workspace.ts'

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

test('project workspace prompt distinguishes actual cwd from private uploads', async () => {
  const workspace = resolve('main')
  const path = resolve('project-folder')
  const prompt = await workspaceProvider(workspace, new VirtualFs(), () => ({
    node: 'online',
    capability: { kind: 'workdir', online: true, path },
  })).getPromptSection(context({ workdir: localProjectWorkdirRef('project') }))
  assert(prompt?.includes(`**Workspace root (this session)**: \`${path}\``))
  assert(prompt?.includes(resolve(workspace, 'discord_top')))
  assert(prompt?.includes('**Session uploads**'))
  assert(prompt?.includes('not the project folder'))
})

test('workspace prompt reports unavailable capability without a local path', async () => {
  const workspace = resolve('workspace')
  const ctx = context({
    workdir: {
      version: 1,
      nodeId: 'child-node',
      capabilityId: 'project-capability',
      displayPathSnapshot: 'C:\\Projects\\example',
    },
  })
  const prompt = await workspaceProvider(workspace, new VirtualFs())
    .getPromptSection(ctx)

  assert((prompt ?? '').includes('**Workspace root (this session)**: unavailable'))
  assert((prompt ?? '').includes('**Node**: `child-node`'))
  assert((prompt ?? '').includes('**Capability**: `project-capability`'))
  assert((prompt ?? '').includes('**Unavailable reason**: `node-missing`'))
  assertEquals(prompt?.includes(resolve(workspace, 'discord_top')), false)
  assertEquals(prompt?.includes('C:\\Projects\\example'), false)
})
