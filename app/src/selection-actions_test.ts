import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertQuote, selectionAction } from './selection-actions.ts'

const key = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false })
test('selection commands use unmodified q and c, never modified typing or IME', () => {
  assert.equal(selectionAction(key('q')), 'quote')
  assert.equal(selectionAction(key('`')), undefined)
  assert.equal(selectionAction(key('c')), 'copy')
  assert.equal(selectionAction(key('a')), undefined)
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'repeat']) {
    assert.equal(selectionAction({ ...key('q'), [flag]: true }), undefined)
    assert.equal(selectionAction({ ...key('c'), [flag]: true }), undefined)
  }
})
test('quoting appends a Markdown block and places the caret at the end', () => {
  assert.deepEqual(insertQuote('', 'first\r\nsecond'), { text: '> first\n> second\n\n', caret: 18 })
  for (const draft of ['draft', 'draft\n', 'draft\n\n']) {
    const text = 'draft\n\n> quoted\n\n'
    assert.deepEqual(insertQuote(draft, 'quoted'), { text, caret: text.length })
  }
  assert.equal(insertQuote('draft\n\n> first\n\n', 'second').text, 'draft\n\n> first\n\n> second\n\n')
})
