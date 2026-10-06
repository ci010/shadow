import assert from 'node:assert/strict'
import test from 'node:test'
import { composerSubmitIntent } from './composer-submit.ts'

const enter = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
  isComposing: false, keyCode: 13, repeat: false, defaultPrevented: false, ...overrides,
})

test('Enter sends and Ctrl+Enter queues; Shift+Enter and IME retain native input', () => {
  assert.equal(composerSubmitIntent(enter(), false), 'send')
  assert.equal(composerSubmitIntent(enter({ ctrlKey: true }), false), 'queue')
  assert.equal(composerSubmitIntent(enter({ metaKey: true }), false), 'send')
  for (const overrides of [
    { shiftKey: true }, { ctrlKey: true, shiftKey: true }, { isComposing: true },
    { keyCode: 229 }, { altKey: true }, { repeat: true }, { defaultPrevented: true }, { key: 'a' },
  ]) assert.equal(composerSubmitIntent(enter(overrides), false), null)
})

test('mobile Enter remains a newline while hardware shortcuts send or queue', () => {
  assert.equal(composerSubmitIntent(enter(), true), null)
  assert.equal(composerSubmitIntent(enter({ ctrlKey: true }), true), 'queue')
  assert.equal(composerSubmitIntent(enter({ metaKey: true }), true), 'send')
})
