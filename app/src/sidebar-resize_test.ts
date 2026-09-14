import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampSidebarWidth, sidebarDragWidth, sidebarKeyWidth, sidebarWidthBounds } from './sidebar-resize.ts'

test('sidebar bounds reserve conversation space using the actual containing pane', () => {
  assert.deepEqual(sidebarWidthBounds(1440, 200, 400), { min: 200, max: 400 })
  assert.deepEqual(sidebarWidthBounds(700, 200, 400), { min: 200, max: 340 })
  assert.deepEqual(sidebarWidthBounds(500, 200, 400), { min: 140, max: 140 })
  assert.deepEqual(sidebarWidthBounds(0, 200, 400), { min: 0, max: 0 })
  assert.deepEqual(sidebarWidthBounds(760, 180, 360), { min: 180, max: 360 })
})

test('rendered widths clamp without mutating preferred widths when the pane shrinks', () => {
  const preference = 380
  assert.equal(clampSidebarWidth(preference, sidebarWidthBounds(680, 200, 400)), 320)
  assert.equal(clampSidebarWidth(preference, sidebarWidthBounds(1200, 200, 400)), 380)
  assert.equal(clampSidebarWidth(199.8, { min: 200, max: 400 }), 200)
})

test('right-edge LTR drag maps horizontal distance and clamps both extremes', () => {
  const bounds = { min: 180, max: 360 }
  assert.equal(sidebarDragWidth(220, 100, 150, bounds), 270)
  assert.equal(sidebarDragWidth(220, 100, 80, bounds), 200)
  assert.equal(sidebarDragWidth(220, 100, -500, bounds), 180)
  assert.equal(sidebarDragWidth(220, 100, 1500, bounds), 360)
})

test('keyboard resize moves 24 pixels and Home/End reach bounds', () => {
  const bounds = { min: 200, max: 400 }
  assert.equal(sidebarKeyWidth('ArrowRight', 260, bounds), 284)
  assert.equal(sidebarKeyWidth('ArrowLeft', 260, bounds), 236)
  assert.equal(sidebarKeyWidth('ArrowLeft', 200, bounds), 200)
  assert.equal(sidebarKeyWidth('ArrowRight', 400, bounds), 400)
  assert.equal(sidebarKeyWidth('Home', 260, bounds), 200)
  assert.equal(sidebarKeyWidth('End', 260, bounds), 400)
  assert.equal(sidebarKeyWidth('Tab', 260, bounds), undefined)
  assert.equal(sidebarKeyWidth('Escape', 260, bounds), undefined)
})
