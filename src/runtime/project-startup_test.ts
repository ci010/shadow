import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { QQChannel } from '../channels/qq.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { MainCluster } from '../cluster/main-cluster.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createProjectScope } from '../projects/scope.ts'
import { CopilotAuthenticatorV2 } from '../providers/copilot-v2.ts'
import { createProjectRuntime } from './main/project-runtime.ts'

test('project becomes locally ready while QQ connects, and shutdown cancels pending connection', { timeout: 15000 }, async t => {
  const { root, workspace } = await folderFixture(t)
  const home = join(workspace, 'startup-home')
  await mkdir(home)
  const catalog = new ProjectCatalog(join(root, 'catalog'))
  await catalog.init()
  const project = catalog.get('default')!
  const config = ConfigSchema.parse({
    agent: { workspace: home, model: 'fixture@openai' },
    providers: { openai: { apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1' } },
    channels: { qq: { enabled: true, appId: 'synthetic-startup-bot', secret: 'synthetic-unused' } },
    mcp: {},
  })
  const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
  const effective = await configStore.init(config)
  const connection = Promise.withResolvers<void>()
  let connecting = false
  let stopped = false
  let finishedConnecting = false
  t.mock.method(QQChannel.prototype, 'start', async () => {
    connecting = true
    await connection.promise
    finishedConnecting = true
  })
  t.mock.method(QQChannel.prototype, 'stop', async () => {
    stopped = true
    connection.resolve()
  })
  const scope = createProjectScope(project.id)
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Startup must not probe optional network services')
  })
  const cluster = {
    workdirCapabilityLookup: () => undefined,
    registry: { listCapabilities: () => [] },
    getNodeInventory: () => ({ version: 1, nodes: [] }),
  } as unknown as MainCluster
  const starting = scope.run(() => createProjectRuntime(effective, {
    project, home, scope, catalog, configStore, mainCluster: cluster, copilotAuth: new CopilotAuthenticatorV2(),
    authorize: () => true,
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const runtime = await Promise.race([
      starting,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local startup waited for QQ networking')), 5000) }),
    ])
    clearTimeout(timer)
    await runtime.ready
    assert.equal(connecting, true)
    assert.equal(finishedConnecting, false)
    assert.equal((await runtime.app.request('/api/sessions/graph')).status, 200)
    assert.equal(network.mock.callCount(), 0, 'Search/MCP discovery cannot delay local readiness')
    await runtime.shutdown()
    assert.equal(stopped, true)
    assert.equal(finishedConnecting, true)
  } finally {
    clearTimeout(timer)
    connection.resolve()
    const runtime = await starting
    await runtime.shutdown()
    scope.close()
  }
})


for (const primaryRetired of [true, false]) {
  test(`retired Copilot ${primaryRetired ? 'primary' : 'secondary'} does not prevent project startup`, { timeout: 15000 }, async t => {
    const { root, workspace } = await folderFixture(t)
    const home = join(workspace, 'retired-startup-home')
    await mkdir(home)
    const catalog = new ProjectCatalog(join(root, 'catalog'))
    await catalog.init()
    const project = catalog.get('default')!
    const config = ConfigSchema.parse({
      agent: { workspace: home, model: `fixture@${primaryRetired ? 'retired' : 'copilot'}` },
      providers: { retired: { type: 'copilot-v1' }, copilot: { type: 'copilot' } }, mcp: {},
    })
    const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
    const effective = await configStore.init(config)
    const scope = createProjectScope(project.id)
    const files = new Map<string, string>()
    const auth = new CopilotAuthenticatorV2(join(root, 'synthetic-auth'), {
      isolated: true,
      storage: { read: key => files.get(key), write: () => assert.fail('Startup must not write credentials'), remove: () => assert.fail('Startup must not delete credentials') },
      fetch: async () => assert.fail('Startup must not contact an account'),
    })
    const cluster = {
      workdirCapabilityLookup: () => undefined, registry: { listCapabilities: () => [] },
      getNodeInventory: () => ({ version: 1, nodes: [] }),
    } as unknown as MainCluster
    const runtime = await scope.run(() => createProjectRuntime(effective, {
      project, home, scope, catalog, configStore, mainCluster: cluster, copilotAuth: auth, authorize: () => true,
    }))
    try {
      await runtime.ready
      assert.equal((await runtime.app.request('/api/sessions/graph')).status, 200)
      assert.equal(files.size, 0)
    } finally { await runtime.shutdown(); scope.close() }
  })
}
