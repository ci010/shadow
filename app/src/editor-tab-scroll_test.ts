import assert from 'node:assert/strict'
import test from 'node:test'
import { scrollEditorTabs } from './editor-tab-scroll.ts'

test('tab wheel consumes a single bounded axis only when the strip can move', () => {
  const strip = { scrollLeft: 0, scrollWidth: 1000, clientWidth: 200 }
  let prevented = false
  const wheel = (values = {}) => { prevented = false; return scrollEditorTabs({ deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault() { prevented = true }, ...values }, strip) }
  assert.equal(wheel(), true); assert.equal(strip.scrollLeft, 40); assert.equal(prevented, true)
  wheel({ deltaX: 10, deltaY: 50 }); assert.equal(strip.scrollLeft, 50)
  wheel({ deltaY: 2, deltaMode: 1 }); assert.equal(strip.scrollLeft, 82)
  wheel({ deltaY: 9, deltaMode: 2 }); assert.equal(strip.scrollLeft, 282)
  assert.equal(wheel({ ctrlKey: true }), false); assert.equal(prevented, false)
  assert.equal(wheel({ metaKey: true }), false)
  strip.scrollLeft = 800; assert.equal(wheel(), false); assert.equal(prevented, false)
  wheel({ deltaY: -40 }); assert.equal(strip.scrollLeft, 760)
  strip.scrollWidth = 200; assert.equal(wheel(), false); assert.equal(prevented, false)
})
