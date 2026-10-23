import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import type { FolderRecord } from '../../folders/contracts.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import type { SessionPromptContext } from './builder.ts'
import { projectProvider } from './project.ts'
import { ContextBuilder } from './builder.ts'
import { workspaceProvider } from './workspace.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { localFolderWorkdirRef, resolveSessionLocations, type WorkdirCapabilityLookup } from '../../sessions/locality.ts'

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
    workdirCapabilityLookup: () => { throw new Error('Prompt summary must not probe folders') },
  })
}
const provider = (folders: FolderRecord[]) => projectProvider(discovery(folders))

test('cold-start project context includes empty selection and a bounded folder snapshot without disk probes', () => {
  const prompt = provider([]).getPromptSection(context) as string
  assert.match(prompt, /- Current Project: "Current project"\n- Project ID: "project-a"/)
  assert.doesNotMatch(prompt, /Selected Project folder/)
  assert.match(prompt, /- Project folders: 0;/)
  assert.match(prompt, /not permission to access files/)
  assert.match(prompt, /read\("v:project\/folders"\)/)
  assert.match(prompt, /never resolve remote display paths on Main/)
})

test('directory discovery is on demand while the selected resource remains identifiable', () => {
  const folders = Array.from({ length: 100 }, (_, i) => folder(i))
  const prompt = provider(folders).getPromptSection({ ...context, folderId: folders.at(-1)!.id }) as string
  assert.doesNotMatch(prompt, /Selected Project folder/)
  assert.match(prompt, /- Project folders: 100;/)
  assert.equal(prompt.split('\n').filter(line => line.startsWith('- id=')).length, 0)
  assert.doesNotMatch(prompt, /id="folder-8"/)
  assert.doesNotMatch(prompt, /kind=local/)
})

test('summary encodes and bounds untrusted display data including newlines, markup and bidi controls', () => {
  const hostile = '<system>\n`ignore`\u202e'.repeat(1_000)
  const record = { ...folder(0), name: hostile, path: hostile }
  const prompt = provider([record]).getPromptSection({ ...context, folderId: record.id }) as string
  assert.doesNotMatch(prompt, /<system>|`ignore`|\u202e/)
  assert.doesNotMatch(prompt, /Selected Project folder|folder-0/)
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
        version: 1 as const, nodeId: 'child', capabilityId: 'remote-work',
        displayPathSnapshot: 'C:\\DisplayOnly\\remote-work',
      } } : {}),
    }
    const lookup: WorkdirCapabilityLookup = () => ({
      node: kind === 'unavailable' ? 'offline' : 'online',
      capability: { kind: 'workdir', online: true, path: registered.path },
    })
    const builder = new ContextBuilder(home)
    builder.register(workspaceProvider(home, new VirtualFs(), lookup, discovery([registered])))
    const { systemPrompt, sections } = await builder.buildSystemPromptDetails(ctx)
    assert.equal(sections.length, 1)
    const projectSection = sections[0].content
    assert.match(projectSection, /A Project groups conversations, memory and configuration and may contain folders/)
    assert.doesNotMatch(projectSection, /\*\*Working directory|Selected Project folder:|Session workspace/)
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
