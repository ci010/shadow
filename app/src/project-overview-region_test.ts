import test from 'node:test'
import assert from 'node:assert/strict'
import { overviewLayout, type OverviewNode, type OverviewEdge } from './project-overview-graph.ts'
const node = (id: string, parentId?: string): OverviewNode => ({ id, parentId, title: id, kind: 'task', at: '', authority: 'human', evidence: id })
test('bounded 2D regions contain nested branches, reserve lanes and preserve cyclic semantic endpoints', () => {
 const nodes = [node('a'), node('b'), ...Array.from({length:9},(_,i)=>node(`c${i}`,'a')), node('nested','c0'), node('other','b')]
 const edges: OverviewEdge[] = [{from:'c0',to:'c1',kind:'dependency',evidence:'first'}, {from:'c1',to:'c0',kind:'causal',evidence:'cycle'}, {from:'nested',to:'other',kind:'reference',evidence:'cross'}]
 const layout = overviewLayout({nodes,edges},new Set(['a','b','c0']))
 const outer = layout.regions.find(r=>r.owner==='a')!, nested = layout.regions.find(r=>r.owner==='c0')!, other = layout.regions.find(r=>r.owner==='b')!
 assert.ok(nested.x>=outer.x && nested.x+nested.width<=outer.x+outer.width && nested.y+nested.height<=outer.y+outer.height)
 assert.ok(other.x>outer.x+outer.width)
 assert.ok(new Set(nodes.filter(n=>n.parentId==='a').map(n=>layout.positions.get(n.id)!.x)).size>1)
 assert.ok(new Set(nodes.filter(n=>n.parentId==='a').map(n=>layout.positions.get(n.id)!.y)).size>1)
 assert.deepEqual(layout.edges.slice(0,2).map(e=>[e.source,e.target]), [['c0','c1'],['c1','c0']])
 assert.deepEqual(layout.edges[2], {...edges[2], source:'region:c0',target:'region:b'})
 const collapsed = overviewLayout({nodes,edges},new Set())
 assert.deepEqual(collapsed.nodes.map(n=>n.id),['a','b'])
 assert.deepEqual(collapsed.edges.map(e=>[e.source,e.target,e.from,e.to]),[['a','b','nested','other']])
})
