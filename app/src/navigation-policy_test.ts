import { deepEqual as assertEquals } from 'node:assert/strict'
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
    'workspaces',
    'nodes',
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
    'workspaces',
    'nodes',
    'approvals',
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
    'workspaces',
    'nodes',
    'approvals',
  ])
})

test('Main node administration requires nodes:admin', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    uiScopes: ['nodes:admin'],
  }

  assertEquals(routeNames(context), ['nodes'])
})

test('Child local surfaces do not require Main administration scopes', () => {
  const context: InstallationContextV1 = {
    ...createLocalMainAdminContext('http://localhost'),
    mode: 'child',
    uiScopes: [],
  }

  assertEquals(routeNames(context), ['nodes', 'approvals'])
})

test('diagnostic routes are grouped without adding a product route', () => {
  const context = createLocalMainAdminContext('http://localhost')
  const diagnostics = navigationFor(context)
    .filter((item) => item.group === 'diagnostics')
    .map((item) => item.name)

  assertEquals(diagnostics, ['agents', 'spans', 'logs'])
})