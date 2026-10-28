import assert from 'node:assert/strict'
import test from 'node:test'
import { alignmentRevision, formatAlignmentLabRequest, parseAlignmentLabDocument, parseAlignmentTarget, type AlignmentLabDocument } from './alignment-lab-model.ts'
import { graphConnectionAllowed, parseAlignmentGraph, sampleAlignmentGraph } from './alignment-graph.ts'
import { storyboardTiming, moveStoryboardItem, storyboardSample, validateStoryboardOrder } from './alignment-storyboard.ts'

const doc = (): AlignmentLabDocument => ({ schema: 'shadow.alignment/v1', kind: 'timeline', source: { id: 'source', label: 'Sample', revision: 'v1', context: 'sample.wav is not attached' }, description: 'Make the selected section slower', constraints: 'Keep voices unchanged', annotations: [
  { target: { id: 'a', label: 'Range', selector: { type: 'time-range', start: 1.2, end: 4.5, duration: 12, trackId: 'audio' } }, intent: 'change', description: 'Let the pause breathe' },
] })
test('shared alignment documents are schema-only independent clones with no execution claim', () => {
  const input = doc(), parsed = parseAlignmentLabDocument(input)
  assert.deepEqual(parsed, input)
  assert.notEqual(parsed.annotations[0]!.target.selector, input.annotations[0]!.target.selector)
  const prompt = formatAlignmentLabRequest(input)
  assert.match(prompt, /not completed edits/)
  assert.match(prompt, /not attached or accessible/)
  assert.match(prompt, /sample.wav is not attached/)
  assert.match(prompt, /source seconds/)
})
test('selectors reject nonfinite ranges, invalid identities and cross-modality reuse', () => {
  for (const selector of [
    { type: 'time-range', start: NaN, end: 3, duration: 10, trackId: 'x' },
    { type: 'time-range', start: 3, end: 12, duration: 10, trackId: 'x' },
    { type: 'text', start: 0, end: 3, quote: 'ab' },
    { type: 'sequence', itemIds: ['a','a'] },
    { type: 'sequence', itemIds: ['a'], proposedOrder: ['b'] },
    { type: 'graph', nodeIds: [], edgeIds: [] },
    { type: 'graph', nodeIds: ['a'], edgeIds: [], proposedConnection: { source: 'a', target: 'b' } },
    { type: 'spatial', position: [0, 1, Infinity], normal: [0,1,0] },
    { type: 'spatial', position: [0,1,0], normal: [0,0,0] },
  ]) assert.throws(() => parseAlignmentTarget({ id: 'x', label: 'x', selector }))
  assert.throws(() => parseAlignmentLabDocument({ ...doc(), kind: 'graph' }), /Mismatched/)
  const duplicated = doc(); duplicated.annotations.push(duplicated.annotations[0]!)
  assert.throws(() => parseAlignmentLabDocument(duplicated), /duplicate/)
})
test('revision is deterministic and changes when source bytes change', async () => {
  assert.equal(await alignmentRevision('sample'), await alignmentRevision(new Blob(['sample'])))
  assert.notEqual(await alignmentRevision('sample'), await alignmentRevision('sample2'))
})
test('storyboard proposals preserve stable source IDs and safe keyboard ordering', () => {
  const items = storyboardSample(), ids = items.map(item => item.id)
  const moved = moveStoryboardItem(items, 0, 1)
  assert.equal(moved[1]!.id, items[0]!.id)
  assert.deepEqual(validateStoryboardOrder(moved.map(item => item.id), ids), moved.map(item => item.id))
  assert.deepEqual(items.map(item => item.id), ids)
  assert.deepEqual(moveStoryboardItem(items, 0, -1), items)
  assert.throws(() => validateStoryboardOrder([ids[0]!,ids[0]!],ids))
})
test('graph proposals reject missing/self/duplicate edges without imposing a runtime engine', () => {
  const graph = sampleAlignmentGraph()
  assert.equal(graphConnectionAllowed('brief','review',graph.nodes,graph.edges),true)
  for(const [source,target] of [['brief','brief'],['missing','review'],['brief','script']]) assert.equal(graphConnectionAllowed(source!,target!,graph.nodes,graph.edges),false)
})


test('graph JSON input validates endpoints and supplies display-only positions', () => {
  const input = { nodes: [{id:'a',label:'Brief'}, {id:'b',label:'Review'}], edges: [{id:'e',source:'a',target:'b'}] }
  assert.equal(parseAlignmentGraph(input).nodes[1]!.position.x,220)
  assert.throws(() => parseAlignmentGraph({...input, edges:[{id:'e',source:'a',target:'missing'}]}))
  assert.throws(() => parseAlignmentGraph({...input, nodes:[input.nodes[0],input.nodes[0]]}))
  assert.throws(() => parseAlignmentGraph({...input, nodes:[{id:'a',label:'A',position:{x:Infinity,y:0}}]}))
})

test('storyboard timing stays contiguous after reorder and rejects invalid durations', () => {
  const items = storyboardSample()
  const shots = storyboardTiming(moveStoryboardItem(items, 0, 1))
  assert.deepEqual(shots.slice(0, 2), [{ id: 'window', start: 0, end: 3, duration: 3 }, { id: 'arrival', start: 3, end: 7, duration: 4 }])
  const selector = { type: 'sequence', itemIds: ['arrival'], shots }
  assert.deepEqual(parseAlignmentTarget({ id: 'shot', label: 'Shot', selector }).selector, selector)
  for (const duration of [0, -1, NaN, Infinity, 601]) assert.throws(() => storyboardTiming([{ id: 'a', duration }]))
  assert.throws(() => parseAlignmentTarget({ id: 'x', label: 'x', selector: { ...selector, shots: [{ id: 'arrival', start: 1, end: 5, duration: 4 }] } }))
  assert.throws(() => parseAlignmentTarget({ id: 'x', label: 'x', selector: { ...selector, proposedOrder: ['arrival'], shots } }))
})

test('sequence exports distinguish repeated instances from immutable assets and accept legacy shots', () => {
  const shots = [
    { id: 'a', sourceId: 'asset', start: 0, end: 2, duration: 2 },
    { id: 'b', sourceId: 'asset', start: 2, end: 5, duration: 3 },
  ]
  const selector = { type: 'sequence', itemIds: ['b'], shots }
  assert.deepEqual(parseAlignmentTarget({ id: 'anchor', label: 'Repeated asset', selector }).selector, selector)
  assert.throws(() => parseAlignmentTarget({ id: 'anchor', label: 'Bad source', selector: { ...selector, shots: [{ ...shots[0], sourceId: '' }] } }))
  assert.throws(() => parseAlignmentTarget({ id: 'anchor', label: 'Dangling instance', selector: { ...selector, itemIds: ['removed'] } }))
  assert.throws(() => storyboardTiming([{ id: 'duplicate', duration: 2 }, { id: 'duplicate', duration: 3 }]))
})
