import assert from 'node:assert/strict'
import test from 'node:test'
import { computed } from 'vue'
import { createSecondaryEditors } from './project-editors.ts'
import { createConversationResources } from './project-workspaces.ts'

test('secondary editors are Project-local presentation targets over unique conversation resources', () => {
  const resources = createConversationResources()
  const editors = createSecondaryEditors()
  const a = resources.session({ projectId: 'a', sessionId: 'web:chat-same' })
  const b = resources.session({ projectId: 'b', sessionId: 'web:chat-same' })
  const draft = resources.draft('a')
  const active = computed(() => editors.get('a', resources.resources))
  assert.equal(active.value, undefined)
  editors.move(a)
  assert.equal(active.value, a, 'reactive target changes without duplicating a session')
  assert.equal(editors.get('b', resources.resources), undefined)
  editors.move(b)
  assert.equal(editors.get('a', resources.resources), a)
  assert.equal(editors.get('b', resources.resources), b)
  assert.equal(resources.session(a), a)
  assert.equal(resources.draft('a'), draft)
  editors.close('a')
  assert.equal(active.value, undefined)
  assert.equal(editors.get('b', resources.resources), b)
  assert.equal(resources.session(a), a, 'close keeps the existing resource and its composer')
  assert.deepEqual(Object.keys(a).sort(), ['key', 'projectId', 'sessionId'], 'moving never adds parent/child/fork state')
})

test('replacing a secondary target and deleting a resource cannot resolve another Project or stale target', () => {
  const resources = createConversationResources()
  const editors = createSecondaryEditors()
  const one = resources.session({ projectId: 'a', sessionId: 'web:chat-one' })
  const two = resources.session({ projectId: 'a', sessionId: 'web:chat-two' })
  editors.move(one)
  editors.move(two)
  assert.equal(editors.get('a', resources.resources), two)
  resources.removeSession(two)
  assert.equal(editors.get('a', resources.resources), undefined)
  assert.equal(resources.session(one), one)
})
