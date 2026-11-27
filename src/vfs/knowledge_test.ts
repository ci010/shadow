import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { KnowledgeService } from '../knowledge/service.ts'
import { SkillsManager } from '../skills/loader.ts'
import { createKnowledgeHandler } from './knowledge.ts'
import { createMemoryHandler, createSessionsHandler } from './mounts.ts'
import { VirtualFs } from './virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { LogTool } from '../tools/log.ts'
import { SearchTool } from '../tools/search.ts'
import type { ExecutionContext } from '../tools/context.ts'

const context = { projectId: 'p', sessionId: 'web:one', signal: new AbortController().signal } as ExecutionContext

test('knowledge VFS uses canonical originals, explicit relations, visibility and strict pages', async t => {
  const root = resolve('.test-artifacts', `knowledge-vfs-${randomUUID()}`)
  await mkdir(root, { recursive: true }); t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, text: string) => { const file = resolve(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); return file }
  await put('memory/topics/a b.md', '# A\n[B](b.md) [Missing](absent.md)')
  await put('memory/topics/b.md', '# B')
  await put('memory/sessions/one.files.jsonl', '{"path":"secret"}\n')
  const legacy = '{"when":"2026-01-01","what":"legacy"}'
  const file = await put('memory/events/2026-01-01.jsonl', `${legacy}\n${legacy}\n`)
  const handler = createKnowledgeHandler(new KnowledgeService(root, new SkillsManager(root)), 'p', ctx => assert.equal(ctx.sessionId, 'web:one'))
  const vfs = new VirtualFs(); vfs.mount('v:knowledge', 'knowledge', handler.read, handler.list)
  const read = async (path: string) => JSON.parse((await vfs.resolve(`v:knowledge/${path}`, context))!)
  const page = await read('catalog?limit=1')
  assert.equal(page.items.length, 1); assert.ok(page.next); assert.equal(page.total, 3)
  const id = encodeURIComponent('memory/topics/a b.md')
  assert.equal((await read(`entry/${id}`)).canonical, 'v:memory/topics/a b.md')
  const relations = await read(`relations/${id}`)
  assert.equal(relations.total, 2)
  assert.ok(relations.items.some((item: { targetStatus: string }) => item.targetStatus === 'outside-catalog'))
  assert.equal((await read(`relations/${encodeURIComponent('memory/topics/b.md')}`)).items[0].direction, 'backlink')
  const records = (await read('logs/date/2026-01-01')).items
  assert.notEqual(records[0].reference, records[1].reference)
  assert.equal(records[0].origin, null); assert.equal(records[0].provenance, 'missing')
  await appendFile(file, '{"what":"new"}\n')
  assert.equal((await vfs.resolve(records[0].reference, context)), JSON.stringify(records[0], null, 2))
  const receipt = await new LogTool(root).execute({ who: 'worker', what: 'done' }, context)
  const reference = /Receipt: (\S+)/.exec(receipt)![1]
  assert.equal(JSON.parse((await vfs.resolve(reference, context))!).what, 'done')
  assert.ok((await vfs.list('v:knowledge/logs', context))!.some(item => item.path === reference))
  assert.match((await vfs.list('v:knowledge/logs/session/web%3Aone', context))![0].content, /done/)
  for (const suffix of ['catalog?limit=101', 'catalog?limit=0', 'catalog?offset=-1', 'catalog?offset=1&offset=2', 'catalog?bad=1', 'entry/%zz', 'entry/../../other']) {
    assert.throws(() => handler.read(suffix, context))
  }
  assert.throws(() => handler.read('catalog', { ...context, projectId: 'other' }), /Project/)
  assert.throws(() => vfs.write('v:knowledge/catalog', { content: '' }, context), /read-only/)
  // Project Home reads do not interpret a remote display path or invoke its executor.
  const remote = { ...context, remoteWorkdir: { get executor() { throw new Error('must not execute') } } } as unknown as ExecutionContext
  assert.equal(JSON.parse(String(handler.read('catalog', remote))).total, 4)
  const memory = createMemoryHandler(root, 'p')
  assert.match(String(await memory.read('', context)), /v:knowledge/)
  assert.doesNotMatch(String(await memory.read('', context)), /one.files/)
  assert.ok((await memory.list(context)).some(item => item.name.endsWith('.files.jsonl')))
  assert.ok((await memory.directory('', context))!.items.some(item => item.endsWith('.files.jsonl')))
  vfs.mount('v:memory', 'memory', memory.read, memory.list, memory.write, memory.directory)
  const reader = new ReadTool(root, vfs)
  assert.match(String(await reader.execute({ path: 'v:memory/', flag: 'l', limit: 100 }, context)), /one.files.jsonl/)
  assert.match(String(await reader.execute({ path: 'v:knowledge/catalog?limit=1' }, context)), /canonical/)
  await assert.rejects(async () => memory.directory('', { ...context, projectId: 'other' }), /Project/)
})

test('session edit index preserves history authorization and current-session patch scope', async () => {
  const state = { sessionId: 'web:one', projectId: 'p', segmentIndex: 0, physicalId: 'physical' }
  const sessions = {
    listSessions: () => [state], getSessionState: () => state,
    getHistory: async () => ({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'write', arguments: '{}' } }] }], total: 1 }),
    getFileChanges: async () => ({ total: 1, offset: 0, changes: [{ id: 'edit', path: '/not-opened', toolCallId: 'call', mode: 'write', patch: '', sessionId: 'web:one' }] }),
  }
  const handler = createSessionsHandler(sessions as never)
  const own = JSON.parse(await handler.read('web:one/edits', context))
  assert.equal(own.items[0].patchPath, 'v:sessions/self/edits/edit')
  assert.equal(own.items[0].when, null); assert.match(own.items[0].history, /\/calls\/call$/)
  const other = JSON.parse(await handler.read('web:one/edits', { ...context, sessionId: 'web:two' }))
  assert.equal(other.items[0].patchPath, null)
  await assert.rejects(async () => handler.read('web:one/edits', { ...context, projectId: 'other' }), /Project/)
  const denied = createSessionsHandler({ ...sessions, getHistory: async () => { throw new Error('history denied') } } as never)
  await assert.rejects(async () => denied.read('web:one/edits', context), /history denied/)
})

test('runtime composition advertises only the short discovery mount and preserves raw memory list routing', async () => {
  const source = await readFile(new URL('../runtime/main/project-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /createKnowledgeHandler\(new KnowledgeService\(workspace, skills\), project.id,/)
  assert.match(source, /context => topics.assertActor\(context.projectId, context.sessionId\)/)
  assert.match(source, /vfs.mount\('v:knowledge', 'read-only knowledge\/log navigation; read v:knowledge\/overview', knowledgeVfs.read, knowledgeVfs.list\)/)
  assert.match(source, /memoryVfs.write,\s+memoryVfs.directory/)
})

test('knowledge projection rejects oversized navigation, cancelled actors and excessive records', () => {
  const id = 'memory/events/2026-01-01.jsonl'
  const entry = { id, path: id, title: 'Logs', kind: 'memory', source: 'project', revision: '', deletable: true } as const
  const handler = createKnowledgeHandler({ catalog: () => ({ entries: [entry], links: [] }),
    detail: () => ({ entry, content: '{}\n'.repeat(100_001) }) }, 'p', () => {})
  assert.throws(() => handler.read('x'.repeat(8193), context), /limit/)
  assert.throws(() => handler.read('logs', context), /100,000/)
  assert.throws(() => handler.read('catalog', { ...context, signal: AbortSignal.abort() }), /abort/i)
})


test('catalog search returns readable per-entry aliases through SearchTool with scope and paging intact', async () => {
  const entries = Array.from({ length: 103 }, (_, index) => {
    const id = `memory/topics/catalog ${String(index).padStart(3, '0')}.md`
    return { id, path: id, title: 'CatalogNeedle', kind: 'memory', source: 'project', revision: '', deletable: true } as const
  })
  const hidden = { ...entries[0], id: 'memory/sessions/hidden.files.jsonl', path: 'memory/sessions/hidden.files.jsonl' }
  const skill = { ...entries[0], id: 'skills/hidden', path: 'skills/hidden', kind: 'skill' } as const
  const handler = createKnowledgeHandler({ catalog: () => ({ entries: [...entries, hidden, skill],
    links: [{ source: entries[0].id, target: entries[1].id, kind: 'markdown', label: 'RelationOnlyNeedle' }] }),
    detail: () => { throw new Error('Metadata search must not read document bodies') } }, 'p', ctx => {
    if (ctx.sessionId !== context.sessionId) throw new Error('actor denied')
  })
  const vfs = new VirtualFs(); vfs.mount('v:knowledge', 'knowledge', handler.read, handler.list)
  const search = new SearchTool('.', undefined, vfs, false)
  const run = (handler: 'grep' | 'glob', query: string, path = 'v:knowledge/catalog', extra = {}) =>
    search.execute({ handler, query, path, ...extra }, context)
  const first = await run('grep', 'CatalogNeedle', undefined, { limit: 1 })
  const reference = first.split(':  Line ')[0]
  assert.equal(reference, `v:knowledge/catalog/${encodeURIComponent(entries[0].id)}`)
  assert.match(first, /continue with offset: 1/)
  const metadata = JSON.parse((await vfs.resolve(reference, context))!)
  assert.equal(metadata.id, entries[0].id)
  assert.deepEqual(metadata, JSON.parse((await vfs.resolve(metadata.read, context))!))
  assert.equal(await run('glob', encodeURIComponent(entries[0].id)), reference)
  assert.equal(await run('glob', '**', reference), reference)
  assert.match(await run('grep', 'CatalogNeedle', reference), new RegExp(`^${reference.replace(/\./g, '\\.')}:`))
  const globPage = await run('glob', '*.md', undefined, { limit: 1, offset: 1 })
  assert.equal(globPage.split('\n')[0], `v:knowledge/catalog/${encodeURIComponent(entries[1].id)}`)
  assert.match(await run('grep', 'CatalogNeedle', undefined, { limit: 1, offset: 1 }), new RegExp(encodeURIComponent(entries[1].id).replace(/\./g, '\\.')))
  const page = await run('grep', 'CatalogNeedle')
  assert.equal(page.split('\n').filter(line => line.includes(':  Line ')).length, 100)
  assert.match(page, /of 103 results/)
  assert.equal((await run('grep', 'CatalogNeedle', undefined, { offset: 100 })).split('\n').length, 3)
  assert.equal(await run('grep', 'CatalogNeedle', undefined, { offset: 103 }), 'No results at this offset.')
  assert.match(await run('glob', '*.md', undefined, { limit: 1 }), /of 103 results/)
  assert.equal(await run('grep', 'RelationOnlyNeedle'), 'No matches found')
  assert.match(await run('grep', 'RelationOnlyNeedle', 'v:knowledge/relations'), /v:knowledge\/relations\//)
  assert.match(await run('grep', 'CatalogNeedle', 'v:knowledge/entry', { limit: 1 }), /^v:knowledge\/entry\//)
  assert.match(await run('grep', 'CatalogNeedle', 'v:knowledge', { limit: 1 }), /^v:knowledge\/catalog\//)
  assert.equal(await run('glob', '*hidden*'), 'No files found')
  assert.equal(await run('grep', 'CatalogNeedle', 'v:knowledge/catalog?limit=1').then(text => text.includes('catalog?limit=1')), true)
  assert.match(await run('grep', 'CatalogNeedle', undefined, { limit: 101 }), /Error: limit/)
  for (const handler of ['grep', 'glob']) {
    const args = { handler, query: handler === 'grep' ? 'CatalogNeedle' : '**', path: 'v:knowledge/catalog' }
    await assert.rejects(() => search.execute(args, { ...context, projectId: 'other' }), /Project/)
    await assert.rejects(() => search.execute(args, { ...context, sessionId: 'denied' }), /actor denied/)
    await assert.rejects(() => search.execute(args, { ...context, signal: AbortSignal.abort() }), /abort/i)
  }
})
