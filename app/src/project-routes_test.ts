import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as VueRouter from 'vue-router'
import ts from 'typescript'
import { hostBase, projectBase } from './api-url.ts'
import { liveProjectId } from './composables/useLiveClient.ts'

function applicationRouter(protocol: 'http:' | 'file:'): VueRouter.Router {
  const source = readFileSync(new URL('./router.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} as { default: VueRouter.Router } }
  new Function('require', 'module', 'exports', 'location', outputText)(
    (id: string) => {
      if (id.endsWith('.vue')) return {}
      assert.equal(id, 'vue-router')
      return {
        ...VueRouter,
        createWebHistory: VueRouter.createMemoryHistory,
        createWebHashHistory: VueRouter.createMemoryHistory,
      }
    },
    module, module.exports, { protocol },
  )
  return module.exports.default
}

for (const protocol of ['http:', 'file:'] as const) {
  test(`${protocol} project routes retain project, session, automation, child pane and hash`, async () => {
    const router = applicationRouter(protocol)
    for (const path of [
      '/projects',
      '/projects/owner%20one/chat/web%3Achat-same?automation=daily&child=task%3Aone#message-2',
      '/projects/other/chat/web%3Achat-same',
      '/projects/owner%20one/settings/bots',
      '/projects/owner%20one/agents/reviewer',
      '/projects/owner%20one/logs',
      '/projects/owner%20one/spans',
    ]) {
      const expected = router.resolve(path)
      await router.push(path)
      assert.equal(router.currentRoute.value.path, expected.path)
      assert.deepEqual(router.currentRoute.value.params, expected.params)
      assert.deepEqual(router.currentRoute.value.query, expected.query)
      assert.equal(router.currentRoute.value.hash, expected.hash)
      assert.equal(router.currentRoute.value.redirectedFrom, undefined)
    }
  })
}

test('root and default chat entry points still reach the default project', async () => {
  const router = applicationRouter('http:')
  await router.push('/')
  assert.equal(router.currentRoute.value.name, 'chat')
  assert.equal(router.currentRoute.value.params.projectId, 'default')
  await router.push('/chat/web%3Achat-same?automation=daily&child=task%3Aone#message-2')
  assert.equal(router.currentRoute.value.name, 'chat')
  assert.deepEqual(router.currentRoute.value.params, { projectId: 'default', sessionId: 'web:chat-same' })
  assert.deepEqual(router.currentRoute.value.query, { automation: 'daily', child: 'task:one' })
  assert.equal(router.currentRoute.value.hash, '#message-2')
})

test('unsupported scope routes do not resolve to a project', () => {
  const router = applicationRouter('http:')
  for (const path of ['/unsupported', '/unsupported/owner/chat/web%3Achat-same']) {
    assert.equal(router.resolve(path).matched.length, 0)
  }
})

test('host and live topic resolution recognize only canonical project scopes', () => {
  const base = 'https://fixture.invalid/prefix/projects/owner%20one/'
  assert.equal(hostBase(base), 'https://fixture.invalid/prefix')
  assert.equal(liveProjectId(base), 'owner one')
  assert.equal(projectBase('https://fixture.invalid/prefix', 'owner one'), base)
  assert.equal(liveProjectId('https://fixture.invalid'), 'default')
  const unsupported = 'https://fixture.invalid/prefix/unsupported/owner%20one'
  assert.equal(hostBase(unsupported), unsupported, 'An unsupported suffix is not stripped as a Project scope')
  assert.equal(liveProjectId(unsupported), 'default', 'An unsupported suffix never supplies a Project owner')
})
