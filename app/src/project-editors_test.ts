import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorGroups, type EditorDescriptor } from './project-editors.ts'

function resource(id: string, projectId = 'a', closable = true): EditorDescriptor {
  return { id: `${projectId}:${id}`, projectId, owner: id, label: id, icon: 'icon', closable, select() {}, close() {} }
}
test('all resource kinds share ordered groups, independent identity, move/close/focus and Project isolation', () => {
  const groups = createEditorGroups()
  const tabs = ['conversation', 'child', 'diagnosis', 'knowledge', 'settings', 'workflows', 'file'].map(id => resource(id))
  for (const tab of tabs) groups.open(tab)
  const initial = [...groups.state('a').left]
  for (const tab of tabs) {
    groups.move(tab.id, 'right')
    assert.equal(groups.side(tab.id), 'right')
    assert.equal(groups.active('a'), tab)
    assert.equal(groups.descriptors.get(tab.id), tab)
    groups.move(tab.id, 'left')
  }
  assert.deepEqual(groups.state('a').left, initial)
  const b = resource('conversation', 'b'); groups.open(b, 'right')
  groups.close(tabs[0]!.id)
  assert.equal(groups.side(tabs[0]!.id), undefined)
  assert.equal(groups.side(b.id), 'right')
  groups.open(tabs[0]!, 'right')
  assert.equal(groups.side(tabs[0]!.id), 'right')
  assert.equal(groups.state('a').right.filter(id => id === tabs[0]!.id).length, 1)
  const base = resource('base', 'a', false); groups.open(base); groups.close(base.id)
  assert.equal(groups.side(base.id), 'left', 'permanent means unclosable, not immovable')
  groups.move(base.id, 'right'); assert.equal(groups.side(base.id), 'right')
})
test('reference target tracks actual editable conversation focus, survives inspector focus, revalidates close and readonly changes', () => {
  const groups = createEditorGroups()
  const one = { ...resource('one'), conversation: { sessionId: 'web:one', editable: true } }
  const two = { ...resource('two'), conversation: { sessionId: 'web:two', editable: true } }
  const child = { ...resource('child'), conversation: { sessionId: 'task:child', editable: false } }
  const settings = resource('settings'), workflow = resource('workflow')
  groups.open(one); groups.open(two, 'right'); groups.open(settings, 'right'); groups.open(workflow)
  assert.equal(groups.referenceTarget('a'), two)
  groups.activate(one.id); groups.open(child)
  assert.equal(groups.referenceTarget('a'), one)
  groups.activate(workflow.id)
  assert.equal(groups.referenceTarget('a'), one)
  assert.equal(groups.referenceTarget('b'), undefined)
  groups.close(one.id); assert.equal(groups.referenceTarget('a'), undefined)
  groups.activate(two.id); groups.descriptors.set(two.id, { ...two, conversation: { ...two.conversation, editable: false } })
  assert.equal(groups.referenceTarget('a'), undefined)
})

test('canonical view leases deduplicate a resource across content owners without reopening a closed editor', () => {
  const groups = createEditorGroups(), tab = resource('knowledge')
  const first = Symbol('first-owner'), second = Symbol('second-owner')
  groups.open(tab)
  groups.registerView(tab.id, first); groups.registerView(tab.id, second)
  assert.equal(groups.views.get(tab.id)?.[0], first)
  groups.move(tab.id, 'right'); groups.close(tab.id)
  groups.unregisterView(tab.id, first)
  assert.equal(groups.views.get(tab.id)?.[0], second)
  assert.equal(groups.side(tab.id), undefined, 'owner takeover is not an explicit open')
  groups.open(tab)
  assert.equal(groups.views.get(tab.id)?.length, 1)
  groups.unregisterView(tab.id, second)
  assert.equal(groups.descriptors.has(tab.id), false)
})
