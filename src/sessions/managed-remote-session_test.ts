import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Hono } from 'hono'
import { folderFixture } from '../folders/test-fixtures.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { reserveRemoteSessionWorkdirs } from '../projects/session-ownership.ts'
import { InMemoryPairingNodeRegistry } from '../cluster/registry.ts'
import { createNodeWebSocketApi } from '../cluster/node-websocket-api.ts'
import { mainNodeInventory } from '../cluster/node-inventory.ts'
import { registerGatewayRoutes, serveGateway } from '../gateway/server.ts'
import { ChildMainConnector } from '../runtime/child-main-connector.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { RemoteExecutor } from '../execution/remote-executor.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { executeRemoteFilesystemText } from '../execution/remote-filesystem-client.ts'
import { managedSessionCapability, MANAGED_SESSION_CAPABILITY } from '../execution/managed-workdir.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore, SessionState } from './session-store.ts'
import type { SessionManager } from './session-manager.ts'
import { resolveSessionLocations, type WorkdirCapabilityLookup } from './locality.ts'
import { remoteSessionPlugin } from './remote-session-routes.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: managed first send allocates on real Child transport, scopes and restores without a Folder`, { timeout: 60_000 }, async t => {
    const { root, workspace } = await folderFixture(t)
    const catalog = new ProjectCatalog(join(root, 'catalog'))
    await catalog.init()
    const other = await catalog.create('Other')
    const auth = { deviceId: 'child-device', nodeId: 'child', credentialId: 'child-credential' }
    const hello = { protocolMajor: 1 as const, protocolMinor: 0, implementationVersion: 'fixture', features: ['jobs-v1', 'capabilities-v1', 'workdir-display-v1'] }
    const registry = new InMemoryPairingNodeRegistry()
    const now = new Date()
    registry.createOffer('offer', now, new Date(now.getTime() + 60_000))
    registry.presentOffer({ offerId: 'offer', pendingId: 'pending', ...auth, displayName: 'Child', deviceIdentityFingerprint: 'fixture' }, now)
    registry.approve({ pendingId: 'pending', expectedDeviceIdentityFingerprint: 'fixture', credentialId: auth.credentialId }, now)
    const api = createNodeWebSocketApi({
      registry, localHello: hello, authorizeUpgrade: () => ({ authentication: auth }),
      session: { maxOutboundQueue: 8, heartbeatTimeoutMs: 60_000 },
    })
    const app = new Hono()
    registerGatewayRoutes(app, [api.plugin])
    const server = serveGateway(app, { host: '127.0.0.1', port: 0 })
    await server.ready
    const endpoint = `http://127.0.0.1:${server.addr.port}`
    const remote = new RemoteExecutor(api)
    const storage = join(root, 'child-managed')
    let child: ManagedChildWorkdirs
    let connector: ChildMainConnector | undefined
    const startChild = async () => {
      child = new ManagedChildWorkdirs(storage, 'child', [])
      await child.init()
      connector = new ChildMainConnector({
        localHello: hello, authentication: auth,
        executor: new LocalExecutor(new ProcessManager(), 'child', child.operationHandlers, []),
        capabilities: () => child.capabilities, session: { maxOutboundQueue: 2, heartbeatTimeoutMs: 60_000 },
      })
      child.onCapability = capability => connector!.advertiseCapability(capability)
      await connector.connect({ endpoint, localNodeId: 'child', signal: new AbortController().signal })
      for (let i = 0; i < 200 && !api.hasAdvertisedCapability('child', MANAGED_SESSION_CAPABILITY); i++) await delay(5)
      assert(api.hasAdvertisedCapability('child', MANAGED_SESSION_CAPABILITY))
    }
    const lookup: WorkdirCapabilityLookup = ref => {
      const descriptor = registry.listCapabilities(ref.nodeId).find(capability => capability.capabilityId === ref.capabilityId)
      return {
        node: api.isNodeConnected(ref.nodeId) ? 'online' : 'offline',
        ...(descriptor ? { capability: { kind: descriptor.kind, online: api.hasAdvertisedCapability(ref.nodeId, ref.capabilityId) } } : {}),
      }
    }
    const stores: SessionStore[] = []
    const createProjectRoutes = async (projectId: string) => {
      const home = join(workspace, projectId)
      await mkdir(home, { recursive: true })
      const store: SessionStore = new Store(join(home, '.sessions'))
      await store.init()
      stores.push(store)
      const states = await store.listAllStates()
      const folders = new FolderRegistry(home, { projectId, catalog })
      await folders.init()
      const executor = new ProjectExecutor(projectId, remote)
      let builds = 0
      const sessions: Pick<SessionManager, 'workspace' | 'workdirCapabilityLookup' | 'remoteExecutor' | 'buildSession' | 'getSessionState'> = {
        workspace: home, remoteExecutor: executor, workdirCapabilityLookup: lookup,
        getSessionState: id => states[id],
        buildSession: async (sessionId, _parent, fields) => {
          const state: SessionState = { sessionId, projectId, segmentIndex: 0, mode: fields?.mode, workdir: fields?.workdir }
          folders.assertSessionFolder(state)
          await store.saveState(sessionId, state)
          states[sessionId] = state
          builds++
        },
      }
      const routes = new Hono()
      remoteSessionPlugin({
        sessions, folders, requireFolderOwnership: true, authorize: () => true,
        managedSessions: { projectId, inventory: () => mainNodeInventory(undefined, registry, api) },
      })(routes)
      const request = (body: unknown, signal?: AbortSignal) => routes.request('/api/sessions/remote', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      })
      return { home, store, states, folders, executor, request, builds: () => builds }
    }
    try {
      const first = await createProjectRoutes('default')
      const second = await createProjectRoutes(other.id)
      const body = { nodeId: 'child', requestId: randomUUID() }
      assert.equal((await first.request(body)).status, 503)
      await startChild()
      const before = await readdir(storage)
      assert(mainNodeInventory(undefined, registry, api).nodes[0].supportsManagedSessions)
      assert.deepEqual(await readdir(storage), before)
      const requests = await Promise.all([first.request(body), first.request(body)])
      for (const response of requests) assert.equal(response.status, 201, await response.clone().text())
      const [created, repeated] = await Promise.all(requests.map(response => response.json()))
      assert.deepEqual(created, repeated)
      assert.equal(first.builds(), 1)
      assert.equal(created.folderId, undefined)
      assert.equal(created.workdir.capabilityId, managedSessionCapability('default', created.sessionId))
      assert.equal((await first.request({ ...body, nodeId: 'other-child' })).status, 409)
      assert.equal((await first.request({ nodeId: 'child' })).status, 400)
      assert.equal((await first.request({ ...body, requestId: '../escape' })).status, 400)
      assert.equal((await first.request({ ...body, capabilityId: created.workdir.capabilityId })).status, 400)
      assert.equal((await first.request({ ...body, folderId: randomUUID() })).status, 400)
      assert.throws(() => first.folders.registerRemote(created.workdir, new AbortController().signal), /cannot be registered/)
      const operation = (executor: ProjectExecutor, operation: string, args: unknown) => executeRemoteFilesystemText({
        executor, nodeId: 'child', capabilityId: created.workdir.capabilityId,
        sessionId: created.sessionId, turnId: randomUUID(), signal: new AbortController().signal,
      }, operation, args)
      await operation(first.executor, 'filesystem.write', { path: 'hello.txt', content: 'Child only' })
      const text = await operation(first.executor, 'filesystem.read', { path: 'hello.txt' })
      assert(text.includes('Child only'))
      await assert.rejects(operation(second.executor, 'filesystem.read', { path: 'hello.txt' }), /project access denied/)
      await assert.rejects(operation(first.executor, 'filesystem.read', { path: '../owner.json' }))
      const descriptor = registry.listCapabilities('child').find(capability => capability.capabilityId === created.workdir.capabilityId)!
      assert.equal(await readFile(join(descriptor.displayPath!, 'hello.txt'), 'utf8'), 'Child only')
      await assert.rejects(readFile(join(first.home, 'hello.txt')), { code: 'ENOENT' })
      await operation(first.executor, 'workdir.process.execute', { script: 'git init --quiet' })
      assert((await operation(first.executor, 'workdir.git.status', {})).includes('hello.txt'))
      const otherResponse = await second.request(body)
      assert.equal(otherResponse.status, 201, await otherResponse.clone().text())
      const otherSession = await otherResponse.json()
      assert.notEqual(otherSession.workdir.capabilityId, created.workdir.capabilityId)
      assert.notEqual(otherSession.workdir.displayPathSnapshot, created.workdir.displayPathSnapshot)
      const fresh = await (await first.request({ ...body, requestId: randomUUID() })).json()
      assert.notEqual(fresh.workdir.capabilityId, created.workdir.capabilityId)
      assert.deepEqual(catalog.folders(), [])
      await reserveRemoteSessionWorkdirs(first.home, catalog, 'default')
      assert.deepEqual(catalog.remoteClaims('child'), [])
      const locations = resolveSessionLocations(first.home, first.states[created.sessionId], undefined, lookup)
      assert.equal(locations.workdir.available && locations.workdir.locality, 'remote')
      assert.notEqual(locations.home, created.workdir.displayPathSnapshot)
      assert.notEqual(locations.sessionDataDir, created.workdir.displayPathSnapshot)
      for (const state of [
        { ...first.states[created.sessionId], projectId: other.id },
        { ...first.states[created.sessionId], folderId: randomUUID() },
        { ...first.states[created.sessionId], workdir: { ...created.workdir, nodeId: 'local' } },
      ]) await assert.rejects(first.store.saveState(state.sessionId, state), /ownership/)
      await connector!.shutdown()
      assert.equal((await first.request({ ...body, requestId: randomUUID() })).status, 503)
      await startChild()
      for (let i = 0; i < 200 && !api.hasAdvertisedCapability('child', created.workdir.capabilityId); i++) await delay(5)
      assert.equal((await first.request(body)).status, 201)
      assert((await operation(first.executor, 'filesystem.read', { path: 'hello.txt' })).includes('Child only'))
      const restored = await createProjectRoutes('default')
      assert.deepEqual(await (await restored.request(body)).json(), created)
      assert.equal(restored.builds(), 0)
      assert.equal((await restored.store.getState(created.sessionId))?.projectId, 'default')
      assert.equal((await readdir(storage)).length, 3)
    } finally {
      for (const store of stores) store.close?.()
      await connector?.shutdown()
      await api.closeAll()
      await server.shutdown()
    }
  })
}
