import assert from 'node:assert/strict'
import test from 'node:test'
import { canStartDrawerSwipe, completesSwipe, drawerSwipeProgress, swipeIntent } from './mobile-swipe.ts'

test('a swipe can begin anywhere in the left half, including its boundary', () => {
  for (const width of [320, 390, 700]) {
    assert.equal(canStartDrawerSwipe(0, width), true)
    assert.equal(canStartDrawerSwipe(width / 2, width), true)
    assert.equal(canStartDrawerSwipe(width / 2 + 1, width), false)
    assert.equal(canStartDrawerSwipe(-1, width), false)
  }
})

test('drawer follows finger distance, clamps at both ends and can reverse before release', () => {
  const opening = { x: 100, y: 200, open: false }
  assert.equal(drawerSwipeProgress(opening, 170, 280), 0.25)
  assert.equal(drawerSwipeProgress(opening, 240, 280), 0.5)
  assert.equal(drawerSwipeProgress(opening, 170, 280), 0.25)
  assert.equal(drawerSwipeProgress(opening, 90, 280), 0)
  assert.equal(drawerSwipeProgress(opening, 500, 280), 1)
  const closing = { x: 200, y: 200, open: true }
  assert.equal(drawerSwipeProgress(closing, 130, 280), 0.75)
  assert.equal(drawerSwipeProgress(closing, -100, 280), 0)
  assert.equal(drawerSwipeProgress(closing, 300, 280), 1)
})

test('right swipe opens only after a deliberate horizontal threshold', () => {
  const start = { x: 10, y: 200, open: false }
  assert.equal(swipeIntent(start, 15, 205), 'pending')
  assert.equal(swipeIntent(start, 30, 203), 'horizontal')
  assert.equal(completesSwipe(start, 73, 200), false)
  assert.equal(completesSwipe(start, 74, 205), true)
  assert.equal(completesSwipe(start, -80, 200), false)
})

test('vertical scrolling and ambiguous diagonal movement never open navigation', () => {
  const start = { x: 10, y: 200, open: false }
  assert.equal(swipeIntent(start, 14, 220), 'cancel')
  assert.equal(swipeIntent(start, 50, 230), 'cancel')
  assert.equal(completesSwipe(start, 90, 300), false)
  assert.equal(completesSwipe(start, 90, 100), false)
})

test('an open drawer closes only on a leftward swipe', () => {
  const start = { x: 220, y: 250, open: true }
  assert.equal(swipeIntent(start, 200, 252), 'horizontal')
  assert.equal(completesSwipe(start, 156, 252), true)
  assert.equal(completesSwipe(start, 157, 252), false)
  assert.equal(completesSwipe(start, 300, 250), false)
  assert.equal(completesSwipe(start, 150, 400), false)
})
