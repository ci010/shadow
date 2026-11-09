import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (name: string) => readFileSync(new URL(`./components/${name}.vue`, import.meta.url), 'utf8')

test('Work notes are displayed without a manual note editor', () => {
  const alignment = source('WorkAlignment')
  const canvas = source('ProjectContextCanvas')
  for (const component of [alignment, canvas]) {
    assert.ok(component.includes('<WorkNoteContent'))
    assert.ok(!component.includes("t('Edit note')"))
  }
  assert.ok(!alignment.includes('note-editor'))
  assert.ok(!alignment.includes("action: 'update'"))
  assert.ok(!alignment.includes("action: 'create'"))
  assert.ok(source('ProjectWorkbench').includes('@click="discussSelected"'))
})
