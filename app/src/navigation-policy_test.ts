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

test('local Main admin sees product and diagnostic routes', () => {
  const context = createLocalMainAdminContext('http://localhost')

  assertEquals(routeNames(context), [
    'chat',
    'settings',
    'spans',
    'logs',
  ])
})

test('authenticated contexts ignore retired scopes for product and diagnostic navigation', () => {
  for (const mode of ['main', 'child', 'client'] as const) {
    const context = { ...createLocalMainAdminContext('http://localhost'), mode, uiScopes: [] }
    assertEquals(routeNames(context), ['chat', 'settings', 'spans', 'logs'])
  }
})

test('diagnostic routes are grouped without adding a product route', () => {
  const context = createLocalMainAdminContext('http://localhost')
  const diagnostics = navigationFor(context)
    .filter((item) => item.group === 'diagnostics')
    .map((item) => item.name)

  assertEquals(diagnostics, ['spans', 'logs'])
})

test('app content follows navigation without a persistent runtime status row', async () => {
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /runtime-status|runtime-dot|roleLabel|mainConnectionLabel/)
  assert.match(app, /<main class="app-main">/)
    assert.match(app, /@manage-node="router.push\(\{ name: 'settings', params: \{ section: 'nodes' \} \}\)"/)
})