import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import { useConversationNavigation } from './composables/useConversationNavigation.ts'
import { parseSessionGraph } from './folders-sidebar.ts'

function fixture(initial: Parameters<typeof useConversationNavigation>[0]['props'] = {}) {
  const props = reactive({ projectId: 'a', ...initial })
  const events: Array<[string, unknown]> = []
  const routes: unknown[] = []
  const effects: string[] = []
  let mounted = true
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'opaque-run', mode: 'session', automation: {
      jobId: 'ordinary-job', runId: 'run', name: 'Review', contextMode: 'fresh', startedAt: '2026-09-16T00:00:00Z',
    } },
    { sessionId: 'trace', parentSessionId: 'opaque-run', mode: 'task' },
    { sessionId: 'web:chat-append' },
    { sessionId: 'web:chat-admin', mode: 'session' },
    { sessionId: 'admin-review', parentSessionId: 'web:chat-admin', mode: 'task' },
  ], nodes: [] })
  const navigation = useConversationNavigation({
    props, sessions: () => sessions,
    router: { replace: async route => { routes.push(route) } },
    emit: (event, value) => { events.push([event, value]) },
    reset: () => { effects.push('reset') },
    refresh: () => { effects.push('refresh') },
    newDraft: () => { effects.push('draft') },
    mounted: () => mounted,
  })
  return { navigation, props, events, routes, effects, unmount: () => { mounted = false } }
}

test('run selection resets and reloads exactly once without creating a draft or sending', () => {
  const view = fixture()
  view.navigation.requestSession('opaque-run')
  assert.equal(view.navigation.activeSessionId.value, 'opaque-run')
  assert.equal(view.navigation.selectedMode.value, 'session')
  assert.deepEqual(view.effects, ['reset', 'refresh'])
  assert.deepEqual(view.events, [['primary-change', 'opaque-run']])
  assert.deepEqual(view.routes, [{ name: 'chat', params: { projectId: 'a', sessionId: 'opaque-run' } }])
  view.navigation.requestSession('opaque-run')
  assert.equal(view.effects.length, 2, 'Selecting the current run is a no-op')
  view.navigation.requestSession('web:chat-append')
  assert.equal(view.navigation.activeSessionId.value, 'web:chat-append')
  assert.deepEqual(view.effects, ['reset', 'refresh', 'reset', 'refresh'])
})

test('managed run navigation delegates ownership without replacing or resetting the cached conversation', () => {
  const view = fixture({ managed: true, sessionId: 'opaque-run', enableChildPane: true })
  view.navigation.requestSession('trace')
  view.navigation.requestSession('web:chat-append')
  assert.deepEqual(view.events, [
    ['open-child', { primaryId: 'opaque-run', childId: 'trace' }], ['navigate', 'web:chat-append'],
  ])
  assert.equal(view.navigation.activeSessionId.value, 'opaque-run')
  assert.deepEqual(view.effects, [])
  assert.deepEqual(view.routes, [])
  view.props.childSessionId = 'trace'
  view.navigation.requestSession('opaque-run')
  assert.deepEqual(view.events.slice(-2), [['primary-change', 'opaque-run'], ['navigate', 'opaque-run']])
})

test('inspecting the selected execution toggles its child pane without changing sidebar selection', () => {
  const view = fixture({ managed: true, sessionId: 'opaque-run', enableChildPane: true })
  view.navigation.inspectExecution('trace')
  assert.deepEqual(view.events, [['open-child', { primaryId: 'opaque-run', childId: 'trace' }]])
  view.props.childSessionId = 'trace'
  view.navigation.inspectExecution('trace')
  assert.deepEqual(view.events.at(-1), ['close-child', undefined])
  assert.deepEqual(view.effects, [])
  view.props.childSessionId = undefined
  view.navigation.inspectExecution('trace')
  assert.deepEqual(view.events.at(-1), ['open-child', { primaryId: 'opaque-run', childId: 'trace' }])
  view.props.childSessionId = 'trace'
  view.navigation.requestSession('trace')
  assert.deepEqual(view.events.at(-1), ['open-child', { primaryId: 'opaque-run', childId: 'trace' }], 'Sidebar navigation does not toggle')
})

test('embedded admin primary navigates peer messages and retains execution pane ownership', () => {
  const view = fixture({ embedded: true, managed: true, sessionId: 'web:chat-admin', enableChildPane: true })
  view.navigation.inspectExecution('web:chat-append')
  view.navigation.inspectExecution('admin-review')
  assert.deepEqual(view.events, [
    ['navigate', 'web:chat-append'],
    ['open-child', { primaryId: 'web:chat-admin', childId: 'admin-review' }],
  ])
  view.props.childSessionId = 'admin-review'
  view.navigation.inspectExecution('admin-review')
  assert.deepEqual(view.events.at(-1), ['close-child', undefined])
  view.props.childSessionId = undefined
  view.navigation.inspectExecution('web:missing-from-graph')
  assert.deepEqual(view.events.at(-1), ['navigate', 'web:missing-from-graph'])
  view.navigation.inspectExecution('web:chat-admin')
  assert.equal(view.events.length, 4, 'Inspecting the current admin is a no-op')
  assert.equal(view.navigation.activeSessionId.value, 'web:chat-admin')
  assert.deepEqual(view.effects, [], 'Managed navigation never resets the admin')
  assert.deepEqual(view.routes, [])
})

test('unmanaged child navigation restores the owning run and embedded inspection never changes the primary', () => {
  const view = fixture({ enableChildPane: true })
  view.navigation.requestSession('trace')
  assert.equal(view.navigation.activeSessionId.value, 'opaque-run')
  assert.deepEqual(view.effects, ['reset', 'refresh'])
  assert.deepEqual(view.routes, [])
  assert.deepEqual(view.events, [['open-child', { primaryId: 'opaque-run', childId: 'trace' }]])
  const child = fixture({ embedded: true, sessionId: 'trace' })
  child.navigation.inspectExecution('opaque-run')
  child.navigation.restoreSession('opaque-run')
  assert.equal(child.navigation.activeSessionId.value, 'trace')
  assert.deepEqual(child.events, [['child-navigation', 'opaque-run']])
  assert.deepEqual(child.effects, [])
})

test('restoration ignores absent graph rows and disposed panes instead of inventing drafts', () => {
  const view = fixture()
  view.navigation.restoreSession('unknown-run')
  assert.deepEqual(view.effects, [])
  view.navigation.restoreSession('opaque-run')
  assert.equal(view.navigation.activeSessionId.value, 'opaque-run')
  assert.deepEqual(view.routes, [], 'Restoring a historical run must not rewrite automation route metadata')
  view.navigation.restoreSession('')
  assert.deepEqual(view.effects, ['reset', 'refresh', 'draft'])
  view.unmount()
  view.navigation.restoreSession('web:chat-append')
  assert.equal(view.effects.length, 3)
})
