import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorGroups, type EditorDescriptor } from './editor-groups.ts'
import { createEditorTabDrag, EDITOR_TAB_DRAG_TYPE } from './editor-tab-drag.ts'

test('tab drag uses a current renderer lease and only moves already open same-Project descriptors', () => {
  const groups = createEditorGroups()
  let project = 'a', selections = 0
  const descriptor: EditorDescriptor = { id: 'conversation', projectId: 'a', owner: 'a', label: 'Conversation', icon: '', closable: true, select() { selections++ }, close() {} }
  groups.open(descriptor, 'right')
  const drag = createEditorTabDrag(groups, () => project)
  const data = new Map<string, string>()
  const event = { preventDefault() {}, dataTransfer: { types: [EDITOR_TAB_DRAG_TYPE], setData(k: string, v: string) { data.set(k, v) }, getData(k: string) { return data.get(k) } } } as unknown as DragEvent
  assert.equal(drag.drop(event, 'left'), false, 'external payload has no lease')
  drag.start(event, descriptor.id)
  data.set(EDITOR_TAB_DRAG_TYPE, 'forged')
  assert.equal(drag.drop(event, 'left'), false)
  drag.start(event, descriptor.id)
  project = 'b'
  assert.equal(drag.drop(event, 'left'), false)
  project = 'a'
  drag.start(event, descriptor.id)
  groups.unregister(descriptor.id)
  groups.open({ ...descriptor }, 'right')
  assert.equal(drag.drop(event, 'left'), false, 'reopened descriptor is not the old lease')
  drag.start(event, descriptor.id)
  drag.enter(event, 'left')
  assert.equal(drag.over.value, 'left')
  assert.equal(drag.drop(event, 'left'), true)
  assert.deepEqual([...groups.state('a').left], [descriptor.id])
  assert.equal(drag.active.value, undefined)
  drag.start(event, descriptor.id)
  assert.equal(drag.drop(event, 'left'), false, 'same group does not reorder')
  for (const id of ['workflow', 'settings']) {
    groups.open({ ...descriptor, id }, 'left')
    drag.start(event, id)
    assert.equal(drag.drop(event, 'right'), true)
    drag.start(event, id)
    assert.equal(drag.drop(event, 'left'), true)
  }
  drag.start(event, 'settings'); drag.clear()
  assert.equal(drag.drop(event, 'right'), false, 'cancelled lease cannot replay')
  assert.ok(selections > 0)
})
