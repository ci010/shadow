import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorGroups, type EditorDescriptor } from './editor-groups.ts'
import { projectTopTabGroups } from './project-top-tabs.ts'
import { surroundingProjectTabGroups } from './project-tab-placement.ts'

test('switching Projects keeps the visible tab order and retained file leases', () => {
  const editors = createEditorGroups()
  const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
  let released = 0
  const tab = (id: string, projectId: string): EditorDescriptor => ({
    id, projectId, owner: projectId, label: id, icon: '', closable: true,
    select() {}, close() { released++; editors.unregister(id) },
  })
  editors.open(tab('chat-a', 'a'))
  const file = tab('video-a', 'a'), token = Symbol('video view')
  editors.registerView(file.id, token)
  editors.open(file, 'right')
  editors.open(tab('chat-b', 'b'))
  const snapshot = (active: string) => {
    const groups = projectTopTabGroups(editors, projects, () => true)
    const { before, after } = surroundingProjectTabGroups(groups.filter(g => g.id !== active), active, [...editors.projects.keys()])
    return [...before, groups.find(g => g.id === active)!, ...after].flatMap(g => g.tabs.map(t => t.id))
  }
  for (const id of ['chat-a', 'chat-b', 'video-a', 'chat-b', 'chat-a']) {
    editors.activate(id)
    assert.deepEqual(snapshot(editors.descriptors.get(id)!.projectId), ['chat-a', 'video-a', 'chat-b'])
    assert.equal(editors.descriptors.get(file.id), file)
    assert.deepEqual(editors.views.get(file.id), [token])
    assert.equal(editors.side(file.id), 'right')
    assert.equal(released, 0)
  }
  editors.close(file.id)
  assert.equal(released, 1)
  assert.equal(editors.side(file.id), undefined)
})
