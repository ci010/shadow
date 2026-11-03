import assert from 'node:assert/strict'
import test from 'node:test'
import { createRouter, createMemoryHistory } from 'vue-router'
import { microAppNavigation } from './microapp-navigation.ts'
import { conversationMicroAppLink } from './project-coordination.ts'

test('published message query routes to app review even from the same chat and across Projects', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/:projectId/chat/:sessionId', name: 'chat', component: {} },
    { path: '/projects/:projectId/dashboard', name: 'project-dashboard', component: {} },
  ] })
  router.beforeEach(microAppNavigation)
  const project = '7a3482b8-596c-47d6-b6b1-40f2261156bc'
  const path = `/projects/${project}/chat/web%3Achat-7fb0178b-a563-4267-af22-753e4b59bdba`
  const app = '7bcbc32d-c255-4ea1-bc25-3624a4b6300'
  await router.push(path)
  const link = conversationMicroAppLink(`${path}?microApp=${app}`, project)!
  await router.push(link)
  assert.equal(router.currentRoute.value.name, 'project-dashboard')
  assert.equal(router.currentRoute.value.params.projectId, project)
  assert.equal(router.currentRoute.value.query.microApp, app)
  await router.push('/projects/other/chat/web:chat-other')
  await router.push(`${path}?microApp=${app}`)
  assert.equal(router.currentRoute.value.name, 'project-dashboard')
  for (const suffix of ['', '?microApp=', '?microApp=a&microApp=b', '?microApp=%2Fetc']) {
    await router.push(path + suffix)
    assert.equal(router.currentRoute.value.name, 'chat')
  }
})
