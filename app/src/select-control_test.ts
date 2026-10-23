import assert from 'node:assert/strict'
import test from 'node:test'
import { findSelectOption, moveSelectOption, selectPopupPosition, selectValueEqual, type SelectOption } from './select-control.ts'

const options: SelectOption[] = [
  { value: '', text: 'Choose', disabled: true },
  { value: 1, text: 'Apple', disabled: false },
  { value: 2, text: 'Apricot', disabled: false },
  { value: 3, text: 'Banana', disabled: true },
  { value: 4, text: 'Blueberry', disabled: false },
]
test('select navigation skips disabled options and wraps, including empty/all-disabled lists', () => {
  assert.equal(moveSelectOption(options, -1, 1), 1)
  assert.equal(moveSelectOption(options, 2, 1), 4)
  assert.equal(moveSelectOption(options, 1, -1), 4)
  assert.equal(moveSelectOption(options, 0, -1), 4)
  assert.equal(moveSelectOption([], -1, 1), -1)
  assert.equal(moveSelectOption(options.map(option => ({ ...option, disabled: true })), 0, 1), -1)
})
test('select typeahead cycles repeated initial characters and ignores disabled matches', () => {
  assert.equal(findSelectOption(options, 'a', 1), 2)
  assert.equal(findSelectOption(options, 'a', 2), 1)
  assert.equal(findSelectOption(options, 'APPL', -1), 1)
  assert.equal(findSelectOption(options, 'b', 2), 4)
  assert.equal(findSelectOption(options, 'missing', 1), -1)
  assert.equal(findSelectOption([], 'a', -1), -1)
})
test('select primitive equality preserves numeric binding compatibility', () => {
  assert.equal(selectValueEqual(4, '4'), true)
  assert.equal(selectValueEqual('', 0), false)
  assert.equal(selectValueEqual(null, ''), false)
})
test('select popup chooses a side and clamps to a narrow/panned viewport', () => {
  assert.deepEqual(selectPopupPosition({ left: 20, top: 30, bottom: 66, width: 120 }, { width: 800, height: 600 }), {
    left: 20, top: 70, width: 120, maxHeight: 288, placement: 'bottom',
  })
  const up = selectPopupPosition({ left: 370, top: 560, bottom: 596, width: 200 }, { width: 390, height: 600 })
  assert.equal(up.placement, 'top')
  assert.equal(up.left + up.width, 382)
  assert.equal(up.top + up.maxHeight, 556)
  const tiny = selectPopupPosition({ left: 5, top: 35, bottom: 71, width: 500 }, { width: 200, height: 110 })
  assert.equal(tiny.width, 184)
  assert.ok(tiny.top >= 8)
  assert.ok(tiny.top + tiny.maxHeight <= 102)
  const panned = selectPopupPosition({ left: 105, top: 220, bottom: 256, width: 90 }, { width: 300, height: 200, left: 100, top: 200 })
  assert.ok(panned.left >= 108)
  assert.ok(panned.top >= 208)
  assert.ok(panned.top + panned.maxHeight <= 392)
})

test('object option values retain identity rather than collapsing to their string representation', () => {
  const first = { id: 1 }
  assert.equal(selectValueEqual(first, first), true)
  assert.equal(selectValueEqual(first, { id: 2 }), false)
  assert.equal(selectValueEqual(false, 'false'), false)
})
