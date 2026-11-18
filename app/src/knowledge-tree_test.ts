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

test('definition roots group effective Agent and deployed Bot Markdown, including nested files', async () => {
  const { definitionTree } = await import('./knowledge-tree.ts')
  const { botDocumentTarget } = await import('./knowledge-definitions.ts')
  const agents = [{ name: 'review', description: 'Reviews changes', source: 'workspace' as const }]
  const bots = [{ id: 'support', paths: ['BOT.md', 'docs/PLAYBOOK.MD'] }]
  const [agentRoot, botRoot] = definitionTree(agents, bots, '')
  assert.equal(agentRoot?.children[0]?.children[0]?.id, 'agent-definition:review')
  const nested = botRoot?.children[0]?.children.find(node => node.label === 'docs')?.children[0]
  assert.deepEqual(botDocumentTarget(nested!.id), { bot: 'support', path: 'docs/PLAYBOOK.MD' })
  assert.equal(definitionTree(agents, bots, 'support playbook')[0]?.children.length, 0)
  assert.equal(definitionTree(agents, bots, 'support playbook')[1]?.children[0]?.children.length, 1)
})
