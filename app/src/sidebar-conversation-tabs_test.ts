import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorGroups, type EditorDescriptor } from './editor-groups.ts'
import { canReplaceIdleConversation, closePreviousSidebarConversation } from './sidebar-conversation-tabs.ts'
import type { SessionStage } from './session-activity.ts'

test('only confirmed idle without protected local state is replaceable', () => {
  assert.equal(canReplaceIdleConversation('idle', false), true)
  assert.equal(canReplaceIdleConversation('idle', true), false)
  for (const stage of [null, 'llm', 'tool', 'waiting', 'rate-limit', 'waiting-for-call', 'pending', 'running', 'inactive', 'completed', 'failed', 'cancelled'] as (SessionStage | null)[]) {
    assert.equal(canReplaceIdleConversation(stage, false), false, String(stage))
  }
})

test('A working remains; switching B idle to C closes only B UI tab and can reopen it', () => {
  const groups = createEditorGroups(), closed: string[] = []
  function descriptor(id: string): EditorDescriptor {
    return { id, owner: id, projectId: 'p', label: id, icon: '', closable: true,
      conversation: { sessionId: id, editable: true }, select() {}, close() { closed.push(id) } }
  }
  const a = descriptor('A'), b = descriptor('B'), c = descriptor('C'), other = descriptor('other-idle')
  groups.open(a)
  groups.open(b)
  closePreviousSidebarConversation(groups, a.id, b.owner, () => false)
  groups.open(other, 'right', false)
  groups.open(c)
  closePreviousSidebarConversation(groups, b.id, c.owner, () => true)
  assert.deepEqual(groups.state('p').left, ['A', 'C'])
  assert.deepEqual(groups.state('p').right, ['other-idle'])
  assert.deepEqual(closed, ['B'])
  assert.equal(groups.descriptors.get('B'), b)
  groups.open(b)
  assert.equal(groups.active('p'), b)
})

test('same owner, unknown target, non-conversation and protected draft do not close', () => {
  const groups = createEditorGroups()
  const b: EditorDescriptor = { id: 'B', owner: 'B', projectId: 'p', label: 'B', icon: '', closable: true,
    conversation: { sessionId: 'B', editable: true }, select() {}, close() { assert.fail('closed') } }
  groups.open(b)
  closePreviousSidebarConversation(groups, b.id, b.owner, () => true)
  closePreviousSidebarConversation(groups, b.id, undefined, () => true)
  closePreviousSidebarConversation(groups, b.id, 'C', () => false)
  groups.open({ ...b, id: 'file', conversation: undefined })
  closePreviousSidebarConversation(groups, 'file', 'C', () => true)
  assert.deepEqual(groups.state('p').left, ['B', 'file'])
})
