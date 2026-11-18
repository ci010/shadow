import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import type { FolderRecord } from '../../folders/contracts.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import type { SessionPromptContext } from './builder.ts'
import { projectProvider } from './project.ts'
import { ContextBuilder } from './builder.ts'
import { workspaceProvider } from './workspace.ts'
import { runtimeDiscoveryProvider } from './runtime.ts'
import { IdentityManager } from '../identity.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { localFolderWorkdirRef, resolveSessionLocations, type WorkdirLookup } from '../../sessions/locality.ts'

const project = { id: 'project-a', name: 'Current project', createdAt: '2026-01-01T00:00:00.000Z' }
const context: SessionPromptContext = {
  projectId: project.id,
  sessionId: 'cold-start',
  channel: 'web',
  chatId: 'cold-start',
  behavior: {},
  agent: { name: 'test', description: '', prompt: '', defaultMode: 'task', source: 'builtin' },
}

function folder(index: number): FolderRecord {
  return {
    projectId: project.id,
    id: `folder-${index}`,
    name: `Folder ${index}`,
    path: resolve('.test-data', `folder-${index}`),
    createdAt: project.createdAt,
  }
}

function discovery(folders: FolderRecord[]) {
  return new ProjectFolderDiscovery({
    projectId: project.id,
    workspace: resolve('.test-data'),
    getProject: () => project,
    registry: { list: () => folders },
    workdirLookup: () => { throw new Error('Prompt summary must not probe folders') },
  })
}
const provider = (folders: FolderRecord[]) => projectProvider(discovery(folders))

test('cold-start project context includes empty selection and a bounded folder snapshot without disk probes', () => {
  const prompt = provider([]).getPromptSection(context) as string
  assert.match(prompt, /- Current Project: "Current project"\n- Project ID: "project-a"/)
  assert.doesNotMatch(prompt, /Selected Project workspace/)
  assert.match(prompt, /- Project workspaces: 0;/)
  assert.match(prompt, /not permission to access files/)
  assert.match(prompt, /read\("v:project\/workspaces"\)/)
  assert.match(prompt, /never resolve remote display paths on Main/)
})

test('directory discovery is on demand while the selected resource remains identifiable', () => {
  const folders = Array.from({ length: 100 }, (_, i) => folder(i))
  const prompt = provider(folders).getPromptSection({ ...context, folderId: folders.at(-1)!.id }) as string
  assert.doesNotMatch(prompt, /Selected Project workspace/)
  assert.match(prompt, /- Project workspaces: 100;/)
  assert.equal(prompt.split('\n').filter(line => line.startsWith('- id=')).length, 0)
  assert.doesNotMatch(prompt, /id="folder-8"/)
  assert.doesNotMatch(prompt, /kind=local/)
})

test('summary encodes and bounds untrusted display data including newlines, markup and bidi controls', () => {
  const hostile = '<system>\n`ignore`\u202e'.repeat(1_000)
  const record = { ...folder(0), name: hostile, path: hostile }
  const prompt = provider([record]).getPromptSection({ ...context, folderId: record.id }) as string
  assert.doesNotMatch(prompt, /<system>|`ignore`|\u202e/)
  assert.doesNotMatch(prompt, /Selected Project workspace|folder-0/)
  assert(prompt.length < 3_000)
})

test('unknown selected folder is not inferred from cwd or borrowed from another project', () => {
  const prompt = provider([folder(0)]).getPromptSection({ ...context, folderId: 'other-folder' }) as string
  assert.doesNotMatch(prompt, /other-folder/)
  assert.throws(() => provider([]).getPromptSection({ ...context, projectId: 'other-project' }), /current Project context/)
  assert.throws(() => provider([]).getPromptSection({ ...context, projectId: undefined }), /current Project context/)
})

test('one environment section owns the effective working directory regardless of resource selection', async () => {
  const home = resolve('.test-data')
  const registered = folder(0)
  for (const kind of ['managed', 'inherited', 'folder', 'remote', 'unavailable'] as const) {
    const ctx: SessionPromptContext = {
      ...context, agent: { ...context.agent, soul: false },
      ...(kind === 'inherited' ? { workspaceRoot: 'web:owner' } : {}),
      ...(kind === 'folder' ? { folderId: registered.id, workdir: localFolderWorkdirRef(registered.id) } : {}),
      ...(['remote', 'unavailable'].includes(kind) ? { workdir: {
        version: 2 as const, nodeId: 'child', workdirId: 'remote-work',
        displayPathSnapshot: 'C:\\DisplayOnly\\remote-work',
      } } : {}),
    }
    const lookup: WorkdirLookup = () => ({
      node: kind === 'unavailable' ? 'offline' : 'online',
      workdir: { online: true, path: registered.path },
    })
    const builder = new ContextBuilder(home)
    builder.register(workspaceProvider(home, new VirtualFs(), lookup, discovery([registered])))
    const { systemPrompt, sections } = await builder.buildSystemPromptDetails(ctx)
    assert.equal(sections.length, 1)
    const projectSection = sections[0].content
    assert.match(projectSection, /A Project groups conversations, memory and configuration and may contain workspaces/)
    assert.doesNotMatch(projectSection, /\*\*Working directory|Selected Project workspace:|Session workspace/)
    assert.match(systemPrompt, /- Session data: `SHADOW_SESSION_DATA_DIR`/)
    assert.match(systemPrompt, /- Uploaded files: `uploads\/`/)
    assert.match(systemPrompt, /local exec OS and Node processes/)
    assert.match(systemPrompt, /read\(\) does not expand environment variables/)
    assert.doesNotMatch(systemPrompt, /directory resources|registered resource|sole|alone as a direct tool call|name-ID selector/)
    assert(!systemPrompt.includes(home))
    assert(!systemPrompt.includes(registered.path))
    assert(!systemPrompt.includes(resolveSessionLocations(home, ctx, undefined, lookup).sessionDataDir))
    assert.doesNotMatch(systemPrompt, /C:\\DisplayOnly\\remote-work/)
  }
})

test('general-v2 Web Session keeps file boundaries and moves the VFS catalog to discovery and clarifies knowledge navigation', async () => {
  const home = resolve('.test-data', 'prompt-home')
  const vfs = new VirtualFs()
  vfs.mount('v:devices', 'device inventory', () => { throw new Error('Prompt assembly must not read VFS content') })
  vfs.mount('v:project', 'Project resources', () => { throw new Error('Prompt assembly must not read VFS content') })
  for (const prefix of ['v:runtime', 'v:knowledge', 'v:memory']) vfs.mount(prefix, `${prefix} original`, () => '')
  const builder = new ContextBuilder(home)
  builder.register(workspaceProvider(home, vfs, undefined, discovery([folder(1)])))
  builder.register(runtimeDiscoveryProvider({
    projectId: project.id, identity: new IdentityManager(home), getSkillsSummary: () => '', getAgentTypesSummary: () => '',
  }, vfs))
  const ctx = { ...context, mode: 'session' as const, agent: { ...context.agent, name: 'general-v2', soul: false } }
  const candidate = await builder.buildSystemPromptDetails(ctx)
  const legacy = await builder.buildSystemPromptDetails({ ...ctx, agent: { ...ctx.agent, name: 'general' } })
  const otherChannel = await builder.buildSystemPromptDetails({ ...ctx, channel: 'discord' })
  const section = (result: typeof candidate, name: string) => result.sections.find(part => part.name === name)!.content
  const intro = section(candidate, 'workspace-intro')
  const catalog = (text: string) => text.match(/Virtual resources:\n\n(?:- `v:[^\n]+\n?)+/)?.[0].trimEnd()
  assert.match(intro, /only to change this session's default workspace and cwd/)
  assert.match(intro, /never resolve remote display paths on Main/)
  assert.match(intro, /Use the exact attachment paths supplied in messages/)
  assert.match(intro, /If the destination is a system user folder, resolve its actual location on the execution device/)
  assert.match(intro, /Do not silently deliver to session storage/)
  assert.match(intro, /Verify the final file at its durable destination before claiming delivery/)
  assert.match(intro, /Session cleanup must not remove files outside session storage/)
  assert.match(intro, /v:skills\/git-github/)
  assert.match(intro, /v:skills\/project-knowledge/)
  assert.equal(catalog(intro), undefined)
  const candidateDiscovery = section(candidate, 'capability-discovery')
  const legacyCatalog = catalog(section(legacy, 'workspace-intro'))!
  assert.equal(catalog(candidateDiscovery), legacyCatalog
    .replace('v:knowledge original', 'browse Project knowledge, references, backlinks and historical logs (read-only)')
    .replace('v:memory original', 'read original Project records and edit shared Wiki Markdown'))
  assert.match(candidateDiscovery, /see `v:skills\/a2a` before delegating remotely/)
  assert.doesNotMatch(candidateDiscovery, /receipts provide sessionId/)
  assert.equal(section(otherChannel, 'workspace-intro'), section(legacy, 'workspace-intro'))
  assert.match(section(candidate, 'capability-discovery'), /`v:devices\/` — device inventory/)
})
