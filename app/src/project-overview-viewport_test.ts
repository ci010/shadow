import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapsedTopicViewport } from './project-overview-viewport.ts'

test('collapse restores the saved scale and centers the relaid-out owner in the usable canvas', () => {
  for (const zoom of [0.4, 1, 1.8]) {
    const position = { x: 900, y: 300 }
    const result = collapsedTopicViewport(position, zoom, { width: 680, height: 800, top: 104 })
    assert.equal(result.zoom, zoom)
    assert.equal(result.x + (position.x + 140) * zoom, 340)
    assert.equal(result.y + (position.y + 56) * zoom, 452)
  }
})

test('collapse uses current layout and canvas size, not stale pre-expansion coordinates', () => {
  const result = collapsedTopicViewport({ x: 16, y: 16 }, 0.6, { width: 360, height: 600, top: 120 })
  assert.equal(result.x + 156 * result.zoom, 180)
  assert.equal(result.y + 72 * result.zoom, 360)
})
