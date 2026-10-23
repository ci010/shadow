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
test('quoting inserts a markdown block at the caret without sending or losing draft text', () => {
  assert.deepEqual(insertQuote('', 'first\r\nsecond', 0, 0), { text: '> first\n> second\n\n', caret: 18 })
  const inserted = insertQuote('before after', 'quoted', 7, 7)
  assert.equal(inserted.text, 'before \n\n> quoted\n\nafter')
  assert.equal(inserted.text.slice(inserted.caret), 'after')
  assert.equal(insertQuote('replace me', 'quoted', 0, 7).text, '> quoted\n\n me')
})
