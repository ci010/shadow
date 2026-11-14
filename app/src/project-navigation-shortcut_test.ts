import assert from 'node:assert/strict'
import test from 'node:test'
import { projectNavigationShortcut } from './project-navigation-shortcut.ts'

const event = { key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, repeat: false, isComposing: false }
test('project navigation uses Ctrl/Meta K for Knowledge and Shift K for Workflows', () => {
  assert.equal(projectNavigationShortcut(event), 'knowledge')
  assert.equal(projectNavigationShortcut({ ...event, shiftKey: true }), 'workflows')
  assert.equal(projectNavigationShortcut({ ...event, key: 'K', ctrlKey: false, metaKey: true }), 'knowledge')
  for (const change of [{ defaultPrevented: true }, { repeat: true }, { isComposing: true }, { altKey: true }, { ctrlKey: false }, { key: 'n' }]) {
    assert.equal(projectNavigationShortcut({ ...event, ...change }), undefined)
  }
})

test('workspace navigation targets the active Project and ignores overlays and inactive panes', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./components/ProjectsWorkspace.vue', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('function projectNavigationKeydown('), source.indexOf('const newConversationShortcut ='))
    .replace('event: KeyboardEvent', 'event')
  const knowledge: string[] = [], routes: unknown[] = []
  const visible = { value: true }, active = { value: true }
  let overlay = false, prevented = 0
  const handler = new Function('projectNavigationShortcut', 'keyboardActive', 'props', 'creating', 'hasVisibleNewConversationOverlay', 'document', 'route', 'selectedProjectId', 'projects', 'openKnowledge', 'router', 'workflowQueries', body + '; return projectNavigationKeydown')(
    projectNavigationShortcut, active, { get visible() { return visible.value } }, { value: false }, () => overlay,
    { querySelectorAll: () => [] }, { name: 'chat', params: { projectId: 'other' } }, { value: 'active' },
    { value: [{ id: 'active' }] }, (id: string) => knowledge.push(id), { push: (route: unknown) => routes.push(route) }, new Map())
  const key = { ...event, preventDefault: () => prevented++ }
  handler(key)
  assert.deepEqual(knowledge, ['active'])
  handler({ ...key, shiftKey: true })
  assert.deepEqual(routes, [{ name: 'project-workflows', params: { projectId: 'active' }, query: {} }])
  overlay = true; handler(key)
  overlay = false; active.value = false; handler(key)
  active.value = true; visible.value = false; handler(key)
  assert.equal(prevented, 2)
})
