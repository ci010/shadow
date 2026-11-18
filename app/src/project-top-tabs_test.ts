import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorGroups, type EditorDescriptor } from './editor-groups.ts'
import { projectTopTabGroups } from './project-top-tabs.ts'

test('top tab groups follow editor ownership, not the last activated project or pane', () => {
  const editors = createEditorGroups()
  const projects = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }]
  const tab = (id: string, projectId: string): EditorDescriptor => ({
    id, projectId, owner: projectId, label: id, icon: '', closable: true, select() {}, close() {},
  })
  editors.open(tab('chat-a', 'a'))
  editors.open(tab('workflow-b', 'b'))
  editors.open(tab('chat-b', 'b'), 'right')
  editors.open(tab('file-b', 'b'))
  editors.activate('chat-a')
  const snapshot = () => projectTopTabGroups(editors, projects, editor => editor.id !== 'file-b')
    .map(group => [group.id, group.name, group.tabs.map(editor => editor.id)])
  assert.deepEqual(snapshot(), [['a', 'Alpha', ['chat-a']], ['b', 'Beta', ['workflow-b', 'chat-b']]])
  editors.move('chat-b', 'left')
  assert.deepEqual(snapshot(), [['a', 'Alpha', ['chat-a']], ['b', 'Beta', ['workflow-b', 'chat-b']]])
  editors.close('workflow-b')
  assert.deepEqual(snapshot(), [['a', 'Alpha', ['chat-a']], ['b', 'Beta', ['chat-b']]])
  editors.close('chat-b')
  assert.deepEqual(snapshot(), [['a', 'Alpha', ['chat-a']]])
})
