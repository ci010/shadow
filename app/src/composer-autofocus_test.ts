import assert from 'node:assert/strict'
import test from 'node:test'
import { canRedirectComposerKey, isComposerTypingKey } from './composer-autofocus.ts'

const key = (value: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  isComposing: false, defaultPrevented: false, keyCode: 0, ...overrides,
})

test('unmodified letters and digits 1 through 9 start composer input', () => {
  for (const value of 'abcdefghijklmnopqrstuvwxyz123456789A') assert.equal(isComposerTypingKey(key(value)), true)
  for (const value of ['0', ' ', '?', 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Dead', 'Process', '中']) {
    assert.equal(isComposerTypingKey(key(value)), false)
  }
})

test('shortcuts, modified keys and IME composition are never intercepted', () => {
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    assert.equal(isComposerTypingKey(key('a', { [flag]: true })), false)
  }
  assert.equal(isComposerTypingKey(key('a', { keyCode: 229 })), false)
})

test('existing editors, dialogs, menus and unavailable composers retain their keyboard input', () => {
  const context = { available: true, editing: false, overlayOpen: false }
  assert.equal(canRedirectComposerKey(key('a'), context), true)
  assert.equal(canRedirectComposerKey(key('a'), { ...context, available: false }), false)
  assert.equal(canRedirectComposerKey(key('a'), { ...context, editing: true }), false)
  assert.equal(canRedirectComposerKey(key('a'), { ...context, overlayOpen: true }), false)
})
