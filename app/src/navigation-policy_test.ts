import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { navigationFor } from './navigation-policy.ts'
import {
  createLocalMainAdminContext,
  type InstallationContextV1,
} from './installation-context.ts'

function routeNames(context: InstallationContextV1): string[] {
  return navigationFor(context).map((item) => item.name)
}

test('local Main admin sees Chat, Usage and Settings', () => {
  const context = createLocalMainAdminContext('http://localhost')

  assertEquals(routeNames(context), [
    'chat',
    'usage',
    'settings',
  ])
})

test('authenticated contexts ignore retired scopes for system navigation', () => {
  for (const mode of ['main', 'child', 'client'] as const) {
    const context = { ...createLocalMainAdminContext('http://localhost'), mode, uiScopes: [] }
    assertEquals(routeNames(context), ['chat', 'usage', 'settings'])
  }
})

test('usage has one host route and diagnostics retain project links', async () => {
  const router = await readFile(new URL('./router.ts', import.meta.url), 'utf8')
  const dashboard = await readFile(new URL('./components/ProjectWorkbench.vue', import.meta.url), 'utf8')
  assert.match(router, /path: '\/usage', name: 'usage'/)
  assert.doesNotMatch(dashboard, /ProjectUsage|t\('Usage'\)/)
  assert.match(dashboard, /Agent diagnostics/)
  assert.match(router, /path: '\/projects\/:projectId\/spans'/)
  assert.match(router, /path: '\/projects\/:projectId\/logs'/)
})

test('app content follows navigation without a persistent runtime status row', async () => {
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /runtime-status|runtime-dot|roleLabel|mainConnectionLabel/)
  assert.match(app, /<main class="app-main">/)
    assert.match(app, /@manage-node="router.push\(\{ name: 'settings', params: \{ section: 'nodes' \} \}\)"/)
})
test('main navigation exposes an icon for each labeled button', async () => {
  const items = navigationFor(createLocalMainAdminContext('http://localhost'))
  assertEquals(items.map(({ icon }) => icon), [
    'i-lucide-messages-square', 'i-lucide-chart-no-axes-column', 'i-lucide-settings',
  ])
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  assert.match(app, /:class="item.icon" class="tab-icon" aria-hidden="true"/)
  const zh = JSON.parse(await readFile(new URL('./locales/zh-CN.json', import.meta.url), 'utf8'))
  assertEquals(zh.Usage, '统计数据')
})
