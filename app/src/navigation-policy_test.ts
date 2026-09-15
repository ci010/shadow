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
    'nodes',
    'settings',
    'agents',
    'spans',
    'logs',
  ])
})

test('Main-facing navigation is scope-aware rather than role-gated', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    mode: 'child',
  }

  assertEquals(routeNames(context), [
    'chat',
    'nodes',
    'agents',
    'spans',
    'logs',
  ])
})

test('restricted Child sees only routes allowed by its scopes', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    mode: 'child',
    uiScopes: ['chat:read'],
  }

  assertEquals(routeNames(context), [
    'chat',
    'nodes',
  ])
})

test('Main node administration requires nodes:admin', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    uiScopes: ['nodes:admin'],
  }

  assertEquals(routeNames(context), ['nodes'])
})

test('Settings replaces Providers as the Main administration tab', () => {
  const context = createLocalMainAdminContext('http://localhost')
  assertEquals(navigationFor(context).find((item) => item.name === 'settings'), {
    name: 'settings', label: 'Settings', group: 'primary',
  })
  assertEquals(routeNames({ ...context, uiScopes: ['chat:read'] }), ['chat'])
})

test('Child local surfaces do not require Main administration scopes', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    mode: 'child',
    uiScopes: [],
  }

  assertEquals(routeNames(context), ['nodes'])
})

test('diagnostic routes are grouped without adding a product route', () => {
  const context = createLocalMainAdminContext('http://localhost')
  const diagnostics = navigationFor(context)
    .filter((item) => item.group === 'diagnostics')
    .map((item) => item.name)

  assertEquals(diagnostics, ['agents', 'spans', 'logs'])
})

test('app content follows navigation without a persistent runtime status row', async () => {
  const app = await readFile(new URL('./App.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /runtime-status|runtime-dot|roleLabel|mainConnectionLabel/)
  assert.match(app, /<main class="app-main">/)
  assert.match(app, /v-if="showChildRecovery"/)
  assert.match(app, /<router-link :to="\{ name: 'nodes' \}">Manage this node<\/router-link>/)
})