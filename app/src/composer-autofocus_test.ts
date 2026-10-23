import assert from 'node:assert/strict'
import test from 'node:test'
import { canRedirectComposerKey, isComposerFocusKey } from './composer-autofocus.ts'

const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key: value, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  isComposing: false, defaultPrevented: false, keyCode: 0, ...overrides,
})

test('unmodified letters, digits 1 through 9 and Backspace focus the composer', () => {
  for (const value of [...'abcdefghijklmnopqrstuvwxyz123456789A', 'Backspace']) assert.equal(isComposerFocusKey(key(value)), true)
  for (const value of ['0', ' ', '?', 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Dead', 'Process', '中']) {
    assert.equal(isComposerFocusKey(key(value)), false)
  }
})

test('shortcuts, modified keys and active IME composition are never intercepted', () => {
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    for (const value of ['a', 'Backspace', 'Process']) {
      assert.equal(isComposerFocusKey(key(value, { code: 'KeyA', [flag]: true })), false)
    }
  }
  assert.equal(isComposerFocusKey(key('a', { keyCode: 229 })), false)
})

test('an IME-start key can focus using its physical code without treating Process as text', () => {
  for (const code of ['KeyA', 'KeyZ', 'Digit1', 'Digit9', 'Backspace']) {
    assert.equal(isComposerFocusKey(key('Process', { keyCode: 229, code })), true)
  }
  for (const code of ['Digit0', 'Enter', 'ArrowDown', 'ShiftLeft', '']) {
    assert.equal(isComposerFocusKey(key('Process', { keyCode: 229, code })), false)
  }
})

test('existing editors, dialogs, menus and unavailable composers retain their keyboard input', () => {
  const context = { available: true, editing: false, overlayOpen: false }
  for (const event of [key('a'), key('Backspace'), key('Process', { keyCode: 229, code: 'KeyA' })]) {
    assert.equal(canRedirectComposerKey(event, context), true)
    assert.equal(canRedirectComposerKey(event, { ...context, available: false }), false)
    assert.equal(canRedirectComposerKey(event, { ...context, editing: true }), false)
    assert.equal(canRedirectComposerKey(event, { ...context, overlayOpen: true }), false)
  }
})
