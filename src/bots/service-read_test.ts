import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FolderRecord } from '../folders/contracts.ts'
import { KnowledgeService } from '../knowledge/service.ts'
import { SkillsManager } from '../skills/loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { folderRoutes } from './read-scope.ts'
import { serviceReadTools } from './service-read.ts'

const context = { projectId: 'test-project', signal: new AbortController().signal } as ExecutionContext

test('folder route collisions use stable provenance and hide unresolved and ambiguous aliases', async () => {
  const folder = (id: string, name: string, path: string): FolderRecord => ({ id, name, path, createdAt: '' })
  const records = new Map([
    ['1', folder('1', 'West', '/repo-west/Public Docs')],
    ['2', folder('2', 'East', '/repo-east/Public Docs')],
    ['3', folder('3', 'Shared', '/repo-West/West - Public Docs')],
    ['4', folder('4', 'Ambiguous', '/repo-both/Hidden')],
    ['5', folder('5', 'Ambiguous', '/repo-both/hidden')],
    ['6', folder('6', 'Secret', '/foreign/Secret')],
  ])
  const ids = ['5', '2', '1', '3', '4']
  const routes = () => folderRoutes(ids, id => records.get(id))
  const expected = [['East - Public Docs', '2'], ['West - Public Docs', '3'], ['repo-west - Public Docs', '1']]
  assert.deepEqual([...routes()], expected)
  assert.deepEqual([...folderRoutes(ids.toReversed(), id => records.get(id))], expected)
  const calls: Array<[string, string]> = []
  const [read, search] = serviceReadTools({
    folders: routes, projectId: context.projectId!,
    folderRead: async (id, input) => {
      calls.push([id, input.path])
      return { path: input.path, lines: [], offset: 1, totalLines: 0 }
    },
    folderSearch: async () => { throw new Error('Unexpected backend call') },
  })
  assert.deepEqual(JSON.parse(String(await read!.execute({ path: '.' }, context))).entries, expected.map(([name]) => name))
  await read!.execute({ path: 'repo-west - Public Docs/sub file.md' }, context)
  for (const path of ['Public Docs', 'Hidden/a.md', 'hidden', 'Secret', 'repo-west - Public Docs/%2e%2e', './', '/tmp', '1/a.md', 'East - Public Docs//a.md', 'east - public docs/a.md']) {
    await assert.rejects(read!.execute({ path }, context), /scope/, path)
    await assert.rejects(search!.execute({ path, handler: 'grep', query: 'test' }, context), /scope/, path)
  }
  assert.deepEqual(calls, [['1', 'sub file.md']])
})

test('shared canonical Knowledge and Wiki filter before projection, reject encodings and stay Project-bound', async () => {
  await withTempWorkspace(async workspace => {
    for (const category of ['topics', 'decisions', 'sessions', 'events', 'working-sets', 'conventions', 'unrecognized']) {
      await mkdir(join(workspace, 'memory', category), { recursive: true })
      await writeFile(join(workspace, 'memory', category, 'example.md'), category === 'topics'
        ? '# PUBLIC_TITLE\n[valid edge](../decisions/example.md)\n[drop session edge](../sessions/example.md)\n[drop log edge](../events/example.md)\n[drop skill edge](v:skills/setup)'
        : category === 'decisions' ? '# ANOTHER_PUBLIC_TITLE' : `# PRIVATE_${category}`)
    }
    await writeFile(join(workspace, 'memory', 'topics', '.hidden.md'), 'PRIVATE_HIDDEN')
    if (process.platform !== 'win32') await symlink('../sessions/example.md', join(workspace, 'memory', 'topics', 'linked.md'))
    const knowledge = new KnowledgeService(workspace, new SkillsManager(workspace))
    const [read, search] = serviceReadTools({ projectId: context.projectId!, views: { wiki: true, knowledge: true }, knowledge,
      folders: () => new Map(), folderRead: () => assert.fail('Unexpected folder read'), folderSearch: () => assert.fail('Unexpected folder search') })
    const readPath = (path: string) => read!.execute({ path }, context)
    const find = (path: string, query: string, handler = 'grep') => search!.execute({ handler, path, query }, context)
    assert.deepEqual(JSON.parse(String(await readPath('.'))), { path: '.', entries: [] })
    assert.match(String(await readPath('v:knowledge/relations/memory%2Ftopics%2Fexample.md')), /valid edge/)
    assert.doesNotMatch(String(await readPath('v:knowledge/relations/memory%2Ftopics%2Fexample.md')), /drop |outside-catalog/)
    assert.match(String(await find('v:knowledge/catalog', 'PUBLIC_TITLE')), /v:knowledge\/entry\/memory%2Ftopics/)
    assert.deepEqual(JSON.parse(String(await find('v:knowledge/', 'drop '))).matches, [])
    assert.deepEqual(JSON.parse(String(await find('v:memory/', '**/*.md', 'glob'))).matches,
      [{ path: 'v:memory/decisions/example.md' }, { path: 'v:memory/topics/example.md' }])
    for (const path of ['v:memory/sessions/', 'v:memory/%73essions/example.md', 'v:memory/topics/../sessions/example.md',
      'v:memory/topics%2f..%2fsessions/example.md', 'v:memory/events', 'v:memory/conventions', 'v:memory/working-sets',
      'v:knowledge/logs', 'v:knowledge/%6cogs', 'v:knowledge/entry/memory%252Fsessions%252Fexample.md',
      'v:knowledge/entry/memory%2Fsessions%2Fexample.md', 'v:knowledge/entry/memory%2ftopics%2fexample.md',
      'v:knowledge/catalog/memory%2Ftopics%2Fexample.md', 'v:knowledge/entry/memory/topics/example.md', 'v:memory/unrecognized']) {
      await assert.rejects(readPath(path), path)
      await assert.rejects(find(path, 'example'), path)
    }
    await assert.rejects(read!.execute({ path: 'v:memory/' }, { ...context, projectId: 'foreign-project' }), /scope/)
    await assert.rejects(search!.execute({ handler: 'web', path: 'v:knowledge', query: 'example' }, context))
    await assert.rejects(find('v:memory/', '../sessions/**', 'glob'), /relative glob/)
  })
})
