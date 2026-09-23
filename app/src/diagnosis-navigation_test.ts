import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useDiagnosisNavigation } from './composables/useDiagnosisNavigation.ts'

async function fixture(url: string, embedded = false, sessionId = 'one') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { name: 'chat', path: '/projects/:projectId/chat/:sessionId?', component: {} },
  ] })
  await router.push(url)
  const scope = effectScope()
  // useRoute exposes a stable reactive wrapper around currentRoute.
  const route = new Proxy({} as typeof router.currentRoute.value, {
    get: (_target, property) => Reflect.get(router.currentRoute.value, property),
  })
  const state = scope.run(() => useDiagnosisNavigation({
    route, router, projectId: () => 'a', sessionId: () => sessionId, embedded: () => embedded,
  }))!
  const settle = () => new Promise(resolve => setImmediate(resolve))
  return { router, state, scope, settle }
}

test('diagnosis panel and section restore from the URL, preserving unrelated query state', async () => {
  const { router, state, scope, settle } = await fixture('/projects/a/chat/one?panel=diagnosis&diagnosis=prompt&child=two&keep=yes')
  assert.equal(state.requested.value, true)
  assert.equal(state.section.value, 'prompt')
  state.selectSection('tools')
  await settle()
  assert.equal(router.currentRoute.value.query.diagnosis, 'tools')
  assert.equal(router.currentRoute.value.query.child, 'two')
  assert.equal(router.currentRoute.value.query.keep, 'yes')
  state.selectPanel(false)
  await settle()
  assert.equal(state.requested.value, false)
  assert.equal(router.currentRoute.value.query.diagnosis, undefined)
  await router.push('/projects/a/chat/one?panel=diagnosis&diagnosis=prompt')
  assert.equal(state.section.value, 'prompt')
  scope.stop()
})

test('child diagnosis selection has separate URL keys and cannot alter the primary view', async () => {
  const { router, state, scope, settle } = await fixture('/projects/a/chat/one?panel=knowledge&entry=wiki&child=two&childPanel=diagnosis&childDiagnosis=tools', true, 'two')
  assert.equal(state.requested.value, true)
  assert.equal(state.section.value, 'tools')
  state.selectSection('prompt')
  await settle()
  assert.equal(router.currentRoute.value.query.childDiagnosis, 'prompt')
  assert.equal(router.currentRoute.value.query.panel, 'knowledge')
  assert.equal(router.currentRoute.value.query.entry, 'wiki')
  state.selectPanel(false)
  await settle()
  assert.equal(router.currentRoute.value.query.childPanel, undefined)
  assert.equal(router.currentRoute.value.query.panel, 'knowledge')
  scope.stop()
})

test('cached conversations and invalid section values cannot corrupt another route', async () => {
  const { router, state, scope, settle } = await fixture('/projects/a/chat/one?panel=diagnosis&diagnosis=unknown')
  assert.equal(state.section.value, 'trace')
  await router.push('/projects/b/chat/one?panel=diagnosis&diagnosis=prompt')
  assert.equal(state.requested.value, undefined)
  state.selectPanel(false)
  state.selectSection('tools')
  await settle()
  assert.equal(router.currentRoute.value.query.diagnosis, 'prompt')
  scope.stop()
})
