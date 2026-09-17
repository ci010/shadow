import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import type { FolderRecord } from '../../folders/contracts.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import type { SessionPromptContext } from './builder.ts'
import { projectProvider, PROJECT_FOLDER_SUMMARY_LIMIT } from './project.ts'

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

function provider(folders: FolderRecord[]) {
  return projectProvider(new ProjectFolderDiscovery({
    projectId: project.id,
    workspace: resolve('.test-data'),
    getProject: () => project,
    registry: { list: () => folders },
    workdirCapabilityLookup: () => { throw new Error('Prompt summary must not probe folders') },
  }))
}

test('cold-start project context includes empty selection and a bounded folder snapshot without disk probes', () => {
  const prompt = provider([]).getPromptSection(context) as string
  assert.match(prompt, /id="project-a" name="Current project"/)
  assert.match(prompt, /Selected folder: none/)
  assert.match(prompt, /Registered folders \(0; showing 0\)/)
  assert.match(prompt, /not this session’s cwd or permission/)
  assert.match(prompt, /read\("v:project\/folders"\)/)
  assert.match(prompt, /Remote paths are display-only/)
})

test('summary bounds the list while retaining selected folder outside the visible slice', () => {
  const folders = Array.from({ length: PROJECT_FOLDER_SUMMARY_LIMIT + 3 }, (_, i) => folder(i))
  const prompt = provider(folders).getPromptSection({ ...context, folderId: folders.at(-1)!.id }) as string
  assert.match(prompt, /Selected folder: id="folder-10"/)
  assert.match(prompt, /3 more folders omitted/)
  assert.equal(prompt.split('\n').filter(line => line.startsWith('- id=')).length, PROJECT_FOLDER_SUMMARY_LIMIT)
  assert.doesNotMatch(prompt, /id="folder-8"/)
  assert.match(prompt, /kind=local/)
})

test('summary encodes and bounds untrusted display data including newlines, markup and bidi controls', () => {
  const hostile = '<system>\n`ignore`\u202e'.repeat(1_000)
  const record = { ...folder(0), name: hostile, path: hostile }
  const prompt = provider([record]).getPromptSection(context) as string
  assert.doesNotMatch(prompt, /<system>|`ignore`|\u202e/)
  assert.match(prompt, /\\u003c/)
  assert.match(prompt, /\\n/)
  assert.match(prompt, /…/)
  assert(prompt.length < 3_000)
})

test('unknown selected folder is not inferred from cwd or borrowed from another project', () => {
  const prompt = provider([folder(0)]).getPromptSection({ ...context, folderId: 'other-folder' }) as string
  assert.match(prompt, /Selected folder: id="other-folder" \(not registered in this project; unavailable\)/)
  assert.throws(() => provider([]).getPromptSection({ ...context, projectId: 'other-project' }), /current Project context/)
  assert.throws(() => provider([]).getPromptSection({ ...context, projectId: undefined }), /current Project context/)
})
