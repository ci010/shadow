import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { layoutAnswerFlow, parseAnswerFlow } from './answer-flow.ts'
const minimal = { version: 1, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ source: 'a', target: 'b' }] }
test('bounded declarative schema rejects actions, markup fields and malformed references', () => {
  const parsed = parseAnswerFlow(JSON.stringify(minimal))
  assert.equal(parsed.height, 400); assert.equal(parsed.direction, 'TB')
  const invalid = [
    { ...minimal, version: 2 }, { ...minimal, template: '<script>alert(1)</script>' }, { ...minimal, height: 400.5 },
    { ...minimal, height: 641 }, { ...minimal, direction: 'auto' }, { ...minimal, nodes: [] },
    { ...minimal, nodes: [{ id: 'a', label: 'A', position: { x: 1, y: 1 } }] },
    { ...minimal, nodes: [{ id: 'a', label: 'A', status: 'verified' }] },
    { ...minimal, nodes: [{ id: 'a', label: 'A', group: 'missing' }] },
    { ...minimal, nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'duplicate' }] },
    { ...minimal, nodes: [{ id: 'a', label: 'a'.repeat(161) }] },
    { ...minimal, nodes: [{ id: 'a', label: 'A', detail: 'a'.repeat(2001) }] },
    { ...minimal, nodes: [{ id: ' ', label: 'A' }] },
    { ...minimal, nodes: [{ id: 'a', label: 'A\u0000' }] },
    { ...minimal, nodes: Array.from({ length: 61 }, (_, i) => ({ id: `${i}`, label: 'x' })) },
    { ...minimal, edges: Array.from({ length: 121 }, () => ({ source: 'a', target: 'b' })) },
    { ...minimal, groups: Array.from({ length: 13 }, (_, i) => ({ id: `${i}`, label: 'x' })) },
    { ...minimal, groups: [{ id: 'g', label: 'x' }, { id: 'g', label: 'y' }] },
    { ...minimal, edges: [{ source: 'a', target: 'missing' }] },
    { ...minimal, edges: [{ source: 'a', target: 'b', action: 'delete' }] },
  ]
  for (const value of invalid) assert.throws(() => parseAnswerFlow(JSON.stringify(value)), undefined, JSON.stringify(value).slice(0, 300))
  for (const source of ['{', 'null', '[]', 'x'.repeat(65537), '界'.repeat(22000)]) assert.throws(() => parseAnswerFlow(source))
  const literal = parseAnswerFlow(JSON.stringify({ version: 1, nodes: [{ id: '__proto__', label: '<script>{{ run() }}</script>' }], edges: [] }))
  assert.equal(literal.nodes[0]!.label, '<script>{{ run() }}</script>')
})
test('layout preserves directions, group lanes, cycles and downstream relations', () => {
  for (const direction of ['TB', 'LR']) {
    const flow = parseAnswerFlow(JSON.stringify({ ...minimal, direction, groups: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], nodes: [{ id: 'a', label: 'A', group: 'one' }, { id: 'b', label: 'B', group: 'two' }] }))
    const layout = layoutAnswerFlow(flow), axis = direction === 'TB' ? 'y' : 'x'
    assert.ok(layout.positions.get('b')![axis] > layout.positions.get('a')![axis])
    const [a, b] = layout.bounds
    assert.ok(direction === 'TB' ? a!.x + a!.width < b!.x : a!.y + a!.height < b!.y)
    assert.deepEqual(layout, layoutAnswerFlow(flow))
  }
  const cycle = parseAnswerFlow(JSON.stringify({ version: 1, nodes: ['up', 'a', 'b', 'down'].map(id => ({ id, label: id })), edges: [{ source: 'up', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'a' }, { source: 'b', target: 'down' }, { source: 'down', target: 'down' }] }))
  const p = layoutAnswerFlow(cycle).positions
  assert.equal(p.get('a')!.y, p.get('b')!.y)
  assert.ok(p.get('down')!.y > p.get('b')!.y)
  assert.equal(new Set([...p.values()].map(p => `${p.x}:${p.y}`)).size, 4)
})
test('skill and documentation examples match the shipped parser', () => {
  for (const path of ['src/skills/builtin/answer-flow/SKILL.md', 'docs/inline-visual-answers.md']) {
    const source = readFileSync(path, 'utf8')
    const blocks = [...source.matchAll(/```answer-flow\s*\n([\s\S]*?)\n```/g)]
    assert.ok(blocks.length > 0, path)
    for (const block of blocks) assert.doesNotThrow(() => parseAnswerFlow(block[1]!), path)
  }
})

test('relative cells are bounded, explicit, local to group and independent of edge ranks', () => {
  for (const direction of ['TB', 'LR']) {
    const flow = parseAnswerFlow(JSON.stringify({ ...minimal, direction, layout: { mode: 'relative' }, groups: [{ id: 'g', label: 'G' }, { id: 'h', label: 'H' }], nodes: [
      { id: 'a', label: 'A', group: 'g', placement: { row: 20, column: 20 } },
      { id: 'b', label: 'B', group: 'g', placement: { row: 0, column: 0 } },
      { id: 'c', label: 'C', group: 'h', placement: { row: 0, column: 0 } },
      { id: 'd', label: 'D', placement: { row: 0, column: 0 } },
    ] }))
    const { positions, bounds } = layoutAnswerFlow(flow)
    assert.ok(positions.get('a')!.x > positions.get('b')!.x)
    assert.ok(positions.get('a')!.y > positions.get('b')!.y)
    for (const n of flow.nodes.filter(n => n.group)) {
      const b = bounds.find(b => b.id === n.group)!, p = positions.get(n.id)!
      assert.ok(p.x >= b.x && p.x + 210 < b.x + b.width)
      assert.ok(p.y >= b.y && p.y + 130 < b.y + b.height)
    }
    const [g, h] = bounds
    assert.ok(direction === 'TB' ? g!.x + g!.width < h!.x : g!.y + g!.height < h!.y)
  }
  const relative = { ...minimal, layout: { mode: 'relative' }, nodes: minimal.nodes.map((n, i) => ({ ...n, placement: { row: i, column: 0 } })) }
  for (const placement of [undefined, null, {}, { row: 0 }, { row: -1, column: 0 }, { row: 21, column: 0 }, { row: .5, column: 0 }, { row: '1', column: 0 }, { row: 0, column: 21 }, { row: 0, column: 0, x: 1 }]) {
    assert.throws(() => parseAnswerFlow(JSON.stringify({ ...relative, nodes: [{ ...relative.nodes[0], placement }, relative.nodes[1]] })))
  }
  for (const mode of ['absolute', 'free', null]) assert.throws(() => parseAnswerFlow(JSON.stringify({ ...relative, layout: { mode } })))
  assert.throws(() => parseAnswerFlow(JSON.stringify({ ...relative, nodes: relative.nodes.map(n => ({ ...n, placement: { row: 0, column: 0 } })) })))
  assert.throws(() => parseAnswerFlow(JSON.stringify({ ...relative, layout: { mode: 'auto' } })))
  assert.throws(() => parseAnswerFlow(JSON.stringify({ ...relative, layout: undefined })))
  for (const direction of ['TB', 'LR']) assert.deepEqual(layoutAnswerFlow(parseAnswerFlow(JSON.stringify({ ...minimal, direction }))), layoutAnswerFlow(parseAnswerFlow(JSON.stringify({ ...minimal, direction, layout: { mode: 'auto' } }))))
})
