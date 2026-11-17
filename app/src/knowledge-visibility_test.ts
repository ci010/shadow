import assert from 'node:assert/strict'
import test from 'node:test'
import { filterKnowledge, knowledgeRelations, layoutKnowledgeGraph, parseKnowledgeCatalog, visibleKnowledgeCatalog, type KnowledgeCatalog, type KnowledgeEntry } from './knowledge.ts'
import { knowledgeTree } from './knowledge-tree.ts'

const entry = (id: string): KnowledgeEntry => ({ id, path: id, title: id, kind: 'memory', source: 'project', revision: 'old', deletable: true })
test('old in-memory catalogs are filtered at tree, search, relation and graph projection boundaries', () => {
  const history = entry('memory/sessions/cron_123.files.jsonl')
  const event = entry('memory/events/2026-01-01.jsonl')
  const session = entry('memory/sessions/cron_123.md')
  const old: KnowledgeCatalog = { entries: [history, event, session], links: [{ source: event.id, target: history.id, label: 'ledger' }, { source: history.id, target: session.id, label: 'edit' }, { source: event.id, target: session.id, label: 'semantic' }] }
  assert.deepEqual(parseKnowledgeCatalog(old), visibleKnowledgeCatalog(old))
  assert.deepEqual(filterKnowledge(old, 'all', 'files'), [])
  assert.deepEqual(filterKnowledge(old, 'all', '').map(e => e.id), [event.id, session.id])
  assert(!JSON.stringify(knowledgeTree(old.entries)).includes(history.id))
  assert.deepEqual(knowledgeRelations(old, history.id), { incoming: [], outgoing: [] })
  const graph = layoutKnowledgeGraph(old, old.entries.map(e => e.id))
  assert.deepEqual(graph.nodes.map(n => n.id).sort(), [event.id, session.id].sort())
  assert.equal(graph.links.length, 1)
  assert.equal(old.entries.length, 3, 'projection never deletes retained data')
})
