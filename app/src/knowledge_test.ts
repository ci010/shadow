import assert from 'node:assert/strict'
import test from 'node:test'
import { createKnowledgeClient, filterKnowledge, knowledgeRelations, layoutKnowledgeGraph, parseKnowledgeCatalog, type KnowledgeCatalog, type KnowledgeEntry } from './knowledge.ts'

const memory: KnowledgeEntry = { id: 'memory/sessions/chat.md', path: 'memory/sessions/chat.md', kind: 'memory', title: 'Chat memory', source: 'project', deletable: true, revision: 'one' }
const wiki: KnowledgeEntry = { id: 'memory/concepts/node.md', path: 'memory/concepts/node.md', kind: 'wiki', title: 'Node runtime', source: 'project', deletable: true, revision: 'two' }
const skill: KnowledgeEntry = { id: 'builtin:skills/node', path: 'skills/node/SKILL.md', kind: 'skill', title: 'Node skill', source: 'builtin', deletable: false, revision: 'three' }
const catalog: KnowledgeCatalog = {
  entries: [memory, wiki, skill],
  links: [
    { source: memory.id, target: wiki.id, label: 'Node' },
    { source: wiki.id, target: skill.id, label: 'skill' },
    { source: wiki.id, target: 'memory/topics/gone.md', label: 'removed' },
  ],
}

test('knowledge filters titles, paths and descriptions without mixing categories', () => {
  assert.deepEqual(filterKnowledge(catalog, 'wiki', 'NODE concepts'), [wiki])
  assert.deepEqual(filterKnowledge(catalog, 'all', 'node'), [wiki, skill])
  assert.deepEqual(filterKnowledge(catalog, 'memory', 'node'), [])
})

test('graph preserves direction, cross-category neighbors, isolates and dangling references', () => {
  const graph = layoutKnowledgeGraph(catalog, [wiki.id])
  assert.equal(graph.nodes.length, 4)
  assert.deepEqual(graph.links, catalog.links)
  assert.equal(graph.nodes.find(node => node.id === 'memory/topics/gone.md')?.kind, 'missing')
  assert.equal(new Set(graph.nodes.map(node => `${node.x}:${node.y}`)).size, 4)
  assert.deepEqual(knowledgeRelations(catalog, wiki.id), { incoming: [catalog.links[0]], outgoing: catalog.links.slice(1) })
  const deleted = { entries: [memory, skill], links: [catalog.links[0]!] }
  assert.equal(layoutKnowledgeGraph(deleted, [memory.id]).nodes.find(node => node.id === wiki.id)?.kind, 'missing')
  assert.equal(layoutKnowledgeGraph({ entries: [memory], links: [] }, [memory.id]).nodes.length, 1)
  assert.equal(layoutKnowledgeGraph(catalog, []).nodes.length, 0)
})

test('knowledge wire validation rejects duplicates, builtin deletion and invalid graph sources', () => {
  assert.deepEqual(parseKnowledgeCatalog(catalog), catalog)
  for (const value of [
    { ...catalog, entries: [memory, memory] },
    { ...catalog, entries: [{ ...skill, deletable: true }] },
    { entries: [memory], links: [{ source: 'unknown', target: memory.id, label: 'bad' }] },
    { entries: [{ ...memory, kind: 'file' }], links: [] },
    { entries: [{ ...memory, revision: '' }], links: [] },
  ]) assert.throws(() => parseKnowledgeCatalog(value), /invalid knowledge/)
})

test('knowledge client retains owning project and sends revision-guarded deletion', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (init?.method === 'DELETE') return Response.json({ deleted: memory.id })
    return Response.json(String(url).includes('/entry') ? { entry: memory, content: '# Saved' } : catalog)
  }
  const client = createKnowledgeClient('http://fixture/projects/project-a/', request)
  assert.deepEqual(await client.list(), catalog)
  assert.equal((await client.read(memory.id)).content, '# Saved')
  await client.remove(memory)
  assert(calls.every(call => call.url.startsWith('http://fixture/projects/project-a/api/knowledge')))
  assert.equal(new URL(calls[1]!.url).searchParams.get('id'), memory.id)
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), { id: memory.id, revision: memory.revision })
})

test('knowledge client surfaces stale entries, denied access and unconfirmed deletions', async () => {
  for (const [status, pattern] of [[409, /changed/], [403, /administrator/], [404, /no longer exists/], [413, /limits/]] as const) {
    const client = createKnowledgeClient('http://fixture', async () => new Response('', { status }))
    await assert.rejects(client.remove(memory), pattern)
  }
  await assert.rejects(createKnowledgeClient('http://fixture', async () => Response.json({ deleted: 'wrong' })).remove(memory), /invalid knowledge/)
  await assert.rejects(createKnowledgeClient('http://fixture', async () => Response.json({ entry: wiki, content: '' })).read(memory.id), /invalid knowledge/)
  await assert.rejects(createKnowledgeClient('http://fixture', async () => { throw new Error('offline') }).remove(memory), /may already have completed/)
})
