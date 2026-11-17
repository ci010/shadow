import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeTree } from './knowledge-tree.ts'
import type { KnowledgeEntry } from './knowledge.ts'
const entry = (id: string, kind: KnowledgeEntry['kind'], source: KnowledgeEntry['source'] = 'project'): KnowledgeEntry => ({ id, path: id, title: id, kind, source, revision: 'r1', deletable: source === 'project' })
test('knowledge tree uses catalog kind, source and directories, without merging skill sources', () => {
  const roots = knowledgeTree([entry('memory/topics/a.md', 'wiki'), entry('memory/sessions/a.md', 'memory'), entry('skills/a/SKILL.md', 'skill'), entry('skills/a/SKILL.md', 'skill', 'builtin')])
  assert.deepEqual(roots.map(node => node.label), ['Wiki', 'Memory', 'Skills'])
  assert.deepEqual(roots[2]!.children.map(node => node.label), ['Built-in', 'Project'])
  assert.equal(roots[0]!.children[0]!.label, 'topics')
  assert.equal(roots[1]!.children[0]!.label, 'sessions')
  assert.deepEqual(knowledgeTree([]).flatMap(root => root.children), [])
})
