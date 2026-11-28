import assert from 'node:assert/strict'
import test from 'node:test'
import { fitOtioWindow, wheelOtioWindow } from './otio-viewport.ts'

test('timeline fits initially and zoom preserves pointer time across all tracks', () => {
  const view = fitOtioWindow(1500)
  const zoom = wheelOtioWindow(view, 1500, 30, -240, 0.6)
  assert.ok(zoom.span < view.span)
  assert.equal(zoom.start + zoom.span * 0.6, 900)
  assert.deepEqual(wheelOtioWindow(zoom, 1500, 30, 100000, 0.6), view)
})
test('pan keeps zoom and clamps both ends; zoom cannot exceed one frame', () => {
  const view = { start: 100, span: 200 }
  assert.deepEqual(wheelOtioWindow(view, 1500, 30, 400, null), { start: 200, span: 200 })
  assert.equal(wheelOtioWindow(view, 1500, 30, -100000, null).start, 0)
  assert.equal(wheelOtioWindow(view, 1500, 30, 100000, null).start, 1300)
  let zoom = view
  for (let i = 0; i < 30; i++) zoom = wheelOtioWindow(zoom, 1500, 30, -1000, 0.5)
  assert.equal(zoom.span, 1 / 30)
  assert.deepEqual(wheelOtioWindow(fitOtioWindow(0), 0, 30, 100, 0.5), { start: 0, span: 0 })
})
