import assert from 'node:assert/strict'
import test from 'node:test'
import { graphLabels, graphScale } from './knowledge-graph-viewport.ts'

test('fit projects world coordinates into the available viewport without scaling glyphs', () => {
  for (const [width, height] of [[1280, 760], [700, 560], [390, 720], [320, 520]]) {
    const scale = graphScale(width!, height!, 2400, 1600, 100)
    assert(scale > 0)
    assert(2400 * scale <= width! - 80 + .001)
    assert(1600 * scale <= height! - 160 + .001)
    assert.equal(graphScale(width!, height!, 2400, 1600, 200), scale * 2)
  }
  assert(Number.isFinite(graphScale(0, 0, 240, 240, 100)))
})

test('sparse overview labels appear without selection; dense labels are bounded and prioritize focus', () => {
  const sparse = [{ id: 'a', title: 'Alpha', x: 100, y: 120 }, { id: 'b', title: 'Beta', x: 400, y: 320 }]
  assert.deepEqual([...graphLabels(sparse, 800, 600, '', '', new Set(), new Map())], ['a', 'b'])
  const dense = Array.from({ length: 230 }, (_, i) => ({ id: String(i), title: 'Synthetic title', x: 80 + i % 20 * 30, y: 80 + Math.floor(i / 20) * 35 }))
  assert(graphLabels(dense, 800, 600, '', '', new Set(), new Map()).size <= 21)
  const labels = graphLabels(dense, 800, 600, '20', '40', new Set(['20', '22']), new Map())
  assert(labels.has('20')); assert(labels.has('40'))
  assert(!labels.has('200'))
})

test('off-screen ordinary labels are omitted and CJK labels use a wider collision estimate', () => {
  const nodes = [{ id: 'a', title: '引用关系与知识图谱', x: 100, y: 120 }, { id: 'b', title: 'Second', x: 150, y: 120 }, { id: 'off', title: 'Outside', x: -40, y: 120 }]
  const labels = graphLabels(nodes, 800, 600, 'a', '', new Set(['a', 'b']), new Map())
  assert(labels.has('a')); assert(!labels.has('b')); assert(!labels.has('off'))
})
