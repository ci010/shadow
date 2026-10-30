import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { AtomicDeviceCredentialReferenceStore } from '../../cluster/device-credential-reference-store.ts'
import type { ProtectedDeviceKeyStore } from '../../cluster/device-credentials.ts'
import { createMainCluster, type MainCluster } from '../../cluster/main-cluster.ts'
import { AtomicFileRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import type { NodeInventoryResponse } from '../../cluster/node-inventory.ts'
import type { JobEventV1, JobRequestV2 } from '../../execution/contracts.ts'
import { WORKDIR_PROCESS_EXECUTE_OPERATION } from '../../execution/capability-shell.ts'
import {
  GatewayClientAddressRegistry,
  registerGatewayRoutes,
  serveGateway,
  type GatewayServer,
} from '../../gateway/server.ts'
import type { ChildBootstrapConfigV1 } from '../bootstrap-config.ts'
import type { ChildRuntimeHandle } from '../child-runtime.ts'
import { pairProductionChild } from '../production-child-pairing.ts'
import { startProductionChildRuntime } from '../production-child.ts'
import type { RuntimeDerivedPaths } from '../runtime-cli.ts'
import { MainDeviceNetwork } from './device-network.ts'
import { ConfigSchema } from '../../config/schema.ts'
import type { MainRuntimeHandle } from './contracts.ts'
import type { WorkdirRefV2 } from '../../sessions/locality.ts'

const childNodeId = 'integration-child'
const workdirId = 'child-only-workdir'

// Real Ed25519 proofs, but deliberately no OS Keychain/DPAPI or user credentials.
function protectedStore(): ProtectedDeviceKeyStore {
  const values = new Map<string, Uint8Array>()
  return {
    providerId: 'integration-memory-protected-store',
    load: async key => values.get(key)?.slice() ?? null,
    save: async (key, value) => { values.set(key, value.slice()) },
  }
}

async function bounded<T>(promise: Promise<T>, label: string, timeout = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  assert.fail(`Timed out: ${label}`)
}

async function availablePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1')
  await bounded(once(server, 'listening'), 'reserve device TCP port')
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  assert(address.port >= 1024)
  return address.port
}

function paths(root: string): RuntimeDerivedPaths {
  return {
    bootstrapConfigPath: join(root, 'bootstrap.json'),
    bootstrapDirectory: root,
    dataDir: join(root, 'data'),
    mutableAgentConfigPath: join(root, 'data', 'app.json'),
    clusterSnapshotPath: join(root, 'data', 'devices', 'registry.v1.json'),
    childCredentialPath: join(root, 'data', 'devices', 'device-credential.v1.json'),
  }
}

test('real Main HTTP facade selects a paired Child folder and restores remote session locality', {
  timeout: 90_000,
}, async t => {
  const previousCwd = process.cwd()
  const root = join(previousCwd, `.device-pairing-integration-${randomUUID()}`)
  const environmentKeys = [
    'GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE',
    'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE',
    'OTEL_DB_PATH', 'VITE_DEV_URL', 'UI_DIST_DIR',
  ]
  const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]))
  let main: MainRuntimeHandle | undefined
  let child: ChildRuntimeHandle | undefined
  const originalFetch = globalThis.fetch
  const allowedEndpoints = new Set<string>()
  const forbiddenRequests: string[] = []
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (!allowedEndpoints.has(url.origin)) {
      forbiddenRequests.push(url.origin)
      throw new Error(`Integration fixture forbids provider/external HTTP: ${url.origin}`)
    }
    return originalFetch(input, init)
  })
  try {
    await mkdir(root)
    for (const key of environmentKeys) delete process.env[key]
    process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
    process.env.UI_DIST_DIR = join(root, 'ui')
    await mkdir(process.env.UI_DIST_DIR)
    await writeFile(join(process.env.UI_DIST_DIR, 'index.html'), '<html>Device integration fixture</html>')
    process.chdir(root)
    const home = join(root, 'main-home')
    const childPaths = paths(join(root, 'child'))
    const childWorkdir = join(root, 'child-only-files')
    await mkdir(home)
    await mkdir(childWorkdir)
    await writeFile(join(home, 'facade.txt'), 'MAIN_MUST_NOT_BE_READ')
    await writeFile(join(childWorkdir, 'facade.txt'), 'CHILD_HTTP_FACADE')
    const configPath = join(root, 'fixture.config.json')
    const rawConfig = {
      agent: { workspace: home, model: 'fixture@openai', sessionStorage: 'sqlite' },
      providers: { openai: { apiKey: 'synthetic-unused-key', baseUrl: 'http://127.0.0.1:1/v1' } },
      channels: {}, mcp: {}, learning: { enabled: false },
    }
    await writeFile(configPath, JSON.stringify(rawConfig))
    const config = ConfigSchema.parse(rawConfig)
    const adminPort = await availablePort()
    const devicePort = await availablePort()
    const endpoint = `http://127.0.0.1:${devicePort}`
    const adminEndpoint = `http://127.0.0.1:${adminPort}`
    allowedEndpoints.add(endpoint)
    allowedEndpoints.add(adminEndpoint)
    const credential = randomUUID()
    const options = {
      configPath, localNodeId: 'integration-main',
      clusterSnapshotPath: join(root, 'main-cluster', 'registry.v1.json'),
      gateway: { host: '127.0.0.1', port: adminPort, launchCredential: credential },
    }
    const { startMainRuntime } = await import('./start.ts')
    const startMain = async () => {
      main = await bounded(startMainRuntime(config, options), 'full Main start', 20_000)
      await bounded(main.ready, 'full Main ready', 20_000)
    }
    const stopMain = async () => {
      if (!main) return
      await bounded(main.shutdown(), 'full Main shutdown', 15_000)
      await bounded(main.finished, 'full Main finished')
      main = undefined
    }
    const request = (path: string, method = 'GET', body?: unknown) => fetch(adminEndpoint + path, {
      method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    async function json<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
      const response = await request(path, method, body)
      assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`)
      return response.json() as Promise<T>
    }
    const connected = () => until(async () => {
      const inventory = await json<NodeInventoryResponse>('/nodes/v1')
      return inventory.nodes.some(node => node.nodeId === childNodeId && node.connection === 'connected' &&
        node.workdirs.some(resource => resource.workdirId === workdirId && resource.online) &&
        ['workdir.identity', 'workdir.process.execute-once'].every(operation => node.workdirs.some(w => w.online && w.workdirId === workdirId && w.support.operations.includes(operation))))
    }, 'full Main sees Child workdir')
    await startMain()
    await json('/nodes/v1/network', 'PUT', {
      version: 1, enabled: true, host: '127.0.0.1', port: devicePort, allowInsecureLocalTransport: true,
    })
    const offer = await json<{ offerId: string; pin: string }>('/pair/v1/offers', 'POST', undefined, 201)
    const keyStore = protectedStore()
    const childConfig: ChildBootstrapConfigV1 = {
      version: 1, mode: 'child', localNodeId: childNodeId, dataDir: childPaths.dataDir,
      mainEndpoint: endpoint, allowInsecureLocalTransport: true,
      workdirs: [{ workdirId, displayName: 'Selectable Child folder', rootPath: childWorkdir }],
    }
    const paired = await pairProductionChild(childConfig, childPaths, {
      ...offer, displayName: 'Facade Child', keyStore, signal: AbortSignal.timeout(5_000),
    })
    await json(`/nodes/v1/pending/${paired.pendingId}/approve`, 'POST', {
      version: 1, expectedDeviceIdentityFingerprint: paired.reference.deviceIdentityFingerprint,
    })
    child = await startProductionChildRuntime(childConfig, childPaths, { keyStore })
    await bounded(child.ready, 'facade Child ready')
    await connected()

    const project = '/projects/default'
    const selection = { nodeId: childNodeId, workdirId, requestId: randomUUID() }
    const created = await json<{ sessionId: string; chatId: string; folderId: string; workdir: WorkdirRefV2 }>(
      project + '/api/sessions/remote', 'POST', selection, 201)
    assert(created.folderId)
    assert.equal(created.workdir.nodeId, childNodeId)
    assert.equal(created.workdir.workdirId, workdirId)
    const sessionPath = project + `/api/sessions/${encodeURIComponent(created.sessionId)}`
    const verifyFacade = async () => {
      const folders = await json<{ folders: Array<{ id: string; kind: string; workdir: WorkdirRefV2 }> }>(
        project + '/api/folders')
      const folder = folders.folders.find(folder => folder.id === created.folderId)
      assert.equal(folder?.kind, 'remote')
      assert.deepEqual(folder?.workdir, created.workdir)
      const details = await json<{ projectId: string; workdir: { kind: string; nodeId: string; available: boolean; displayPath: string } }>(
        sessionPath + '/details')
      assert.equal(details.projectId, 'default')
      assert.equal(details.workdir.kind, 'remote')
      assert.equal(details.workdir.nodeId, childNodeId)
      assert.equal(details.workdir.available, true)
      assert.equal(details.workdir.displayPath, childWorkdir)
      const files = await json<{ entries: Array<{ name: string }> }>(project + `/api/folders/${created.folderId}/files`)
      assert(files.entries.some(entry => entry.name === 'facade.txt'))
      assert.equal((await json<{ content: string }>(sessionPath + '/preview?path=facade.txt')).content, 'CHILD_HTTP_FACADE')
      assert.deepEqual(await json(project + '/api/sessions/remote', 'POST', selection, 201), created)
    }
    await verifyFacade()
    // /help follows real message admission/persistence without requesting an LLM turn.
    await json(project + '/api/chat/send', 'POST', { chatId: created.chatId, content: '/help', stream: false })
    type History = { commandResults: Array<{ id?: string; content?: string }> }
    await until(async () => (await json<History>(sessionPath)).commandResults.length > 0, 'persisted local command result')
    const history = await json<History>(sessionPath)
    await stopMain()
    await startMain()
    await connected()
    await verifyFacade()
    assert.deepEqual((await json<History>(sessionPath)).commandResults, history.commandResults)
    assert.equal(await readFile(join(home, 'facade.txt'), 'utf8'), 'MAIN_MUST_NOT_BE_READ')
    // A resource ID is not permission to silently rebind an existing Folder
    // after Child restart. Test the existing session path, not a fresh picker.
    await bounded(child.shutdown(), 'Child before resource rebinding')
    const reboundRoot = join(root, 'different-child-directory')
    await mkdir(reboundRoot)
    await writeFile(join(reboundRoot, 'facade.txt'), 'DIFFERENT_RESOURCE_MUST_NOT_BE_READ')
    child = await startProductionChildRuntime({ ...childConfig,
      workdirs: [{ workdirId, displayName: 'Rebound directory', rootPath: reboundRoot }] }, childPaths, { keyStore })
    await bounded(child.ready, 'rebound Child ready')
    await until(async () => (await json<NodeInventoryResponse>('/nodes/v1')).nodes.some(node =>
      node.nodeId === childNodeId && node.connection === 'connected'), 'rebound Child reconnects without making its changed resource usable')
    const rebound = await request(sessionPath + '/preview?path=facade.txt')
    assert.notEqual(rebound.status, 200, 'Existing session must reject a resource rebound across Child restart')
    assert.doesNotMatch(await rebound.text(), /DIFFERENT_RESOURCE_MUST_NOT_BE_READ/)
    assert.deepEqual(forbiddenRequests, [], 'No provider or external HTTP may be attempted')
  } finally {
    try {
      await bounded(child?.shutdown() ?? Promise.resolve(), 'facade Child cleanup')
    } finally {
      try {
        if (main) {
          await bounded(main.shutdown(), 'facade Main cleanup', 15_000)
          await bounded(main.finished, 'facade Main termination')
        }
      } finally {
        process.chdir(previousCwd)
        for (const [key, value] of previousEnvironment) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

test('TCP device pairing approves a fingerprint, executes only on Child and restores reconnectable state', {
  timeout: 90_000,
}, async () => {
  const root = join(process.cwd(), `.device-pairing-integration-${randomUUID()}`)
  const mainPaths = paths(join(root, 'main'))
  const childPaths = paths(join(root, 'child'))
  const mainWorkdir = join(root, 'main', 'workdir')
  const childWorkdir = join(root, 'child', 'workdir')
  const networkPath = join(mainPaths.dataDir, 'device-network.v1.json')
  const keyStore = protectedStore()
  const launchCredential = randomUUID()
  let cluster: MainCluster | undefined
  let network: MainDeviceNetwork | undefined
  let admin: GatewayServer | undefined
  let child: ChildRuntimeHandle | undefined
  let adminEndpoint = ''

  const request = (endpoint: string, path: string, method = 'GET', body?: unknown, authorized = false) =>
    fetch(endpoint + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: `Bearer ${launchCredential}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    })
  const adminRequest = (path: string, method = 'GET', body?: unknown, authorized = true) =>
    request(adminEndpoint, path, method, body, authorized)
  async function adminJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await adminRequest(path, method, body)
    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`)
    return response.json() as Promise<T>
  }
  async function startMain(): Promise<void> {
    const clientAddresses = new GatewayClientAddressRegistry()
    const authorize = (request: Request) =>
      request.headers.get('Authorization') === `Bearer ${launchCredential}`
    cluster = await createMainCluster({
      snapshotAdapter: new AtomicFileRegistrySnapshotAdapter(mainPaths.clusterSnapshotPath),
      localHello: {
        protocolMajor: 1, protocolMinor: 0, implementationVersion: 'device-tcp-integration',
        features: ['workdir-execution-v2'],
      },
      authorizeOfferCreation: authorize,
      clientKey: request => clientAddresses.resolve(request),
      localNodeInventory: () => ({
        nodeId: 'integration-main', role: 'main', displayName: 'Integration Main',
        connection: 'connected', workdirs: [], support: { operations: [] }, executionProtocol: 'compatible',
      }),
    })
    network = new MainDeviceNetwork({
      configPath: networkPath, cluster, clientAddresses, authorize,
      addresses: () => [{ name: 'Disposable loopback fixture', address: '127.0.0.1' }],
    })
    await network.init()
    const app = new Hono()
    registerGatewayRoutes(app, [network.plugin(), ...cluster.plugins], {
      launchCredential, clientAddresses,
    })
    admin = serveGateway(app, { host: '127.0.0.1', port: 0, clientAddresses })
    await bounded(admin.ready, 'Main admin gateway ready')
    adminEndpoint = `http://127.0.0.1:${admin.addr.port}`
  }
  async function stopMain(): Promise<void> {
    await bounded((async () => {
      await network?.shutdown()
      await cluster?.closeNodeConnections('integration restart')
      await cluster?.save()
      await admin?.shutdown()
    })(), 'Main shutdown')
    network = undefined
    cluster = undefined
    admin = undefined
  }
  async function connected(): Promise<void> {
    await until(async () => {
      const inventory = await adminJson<NodeInventoryResponse>('/nodes/v1')
      const node = inventory.nodes.find(node => node.nodeId === childNodeId)
      return node?.connection === 'connected' &&
        node.workdirs.some(resource => resource.workdirId === workdirId && resource.online) &&
        ['workdir.identity', 'workdir.process.execute-once'].every(operation => node.workdirs.some(w => w.online && w.workdirId === workdirId && w.support.operations.includes(operation)))
    }, 'Child connected and advertised its workdir')
    assert.equal(cluster!.activeSessionCount, 1)
  }
  async function execute(operation: string, args: unknown): Promise<JobEventV1[]> {
    const jobId = randomUUID()
    const job: JobRequestV2 = {
      version: 2, jobId, idempotencyKey: jobId, sessionId: 'integration-session', projectScope: 'a'.repeat(32),
      turnId: randomUUID(), nodeId: childNodeId, workdirId, operation, args,
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    }
    const events = await bounded((async () => {
      const result: JobEventV1[] = []
      for await (const event of cluster!.remoteExecutor.execute(job, AbortSignal.timeout(6_000))) result.push(event)
      return result
    })(), `remote ${operation}`, 8_000)
    const terminal = events.at(-1)
    assert(terminal && 'receipt' in terminal, JSON.stringify(events))
    assert.equal(terminal.type, 'completed', JSON.stringify(terminal))
    assert.equal(terminal.receipt.nodeId, childNodeId)
    assert.equal(terminal.receipt.jobId, jobId)
    assert.equal(terminal.receipt.state, 'completed')
    return events
  }
  const stdout = (events: JobEventV1[]) =>
    events.flatMap(event => event.type === 'stdout' ? [event.chunk] : []).join('')
  async function verifyExecution(content: string): Promise<void> {
    assert.equal(stdout(await execute('filesystem.read', { path: 'sentinel.txt' })), 'CHILD_ONLY')
    await execute('filesystem.write', { path: 'result.txt', content })
    assert.equal(stdout(await execute('filesystem.read', { path: 'result.txt' })), content)
    const shell = await execute(WORKDIR_PROCESS_EXECUTE_OPERATION, {
      script: process.platform === 'win32' ? 'cd & type sentinel.txt' : 'pwd; cat sentinel.txt',
    })
    assert(stdout(shell).includes(childWorkdir), stdout(shell))
    assert(stdout(shell).includes('CHILD_ONLY'), stdout(shell))
    assert(!stdout(shell).includes('MAIN_UNCHANGED'), stdout(shell))
    const terminal = shell.at(-1)!
    assert('receipt' in terminal)
    assert.equal(terminal.receipt.exitCode, 0)
    assert.equal(await readFile(join(childWorkdir, 'result.txt'), 'utf8'), content)
    assert.equal(await readFile(join(mainWorkdir, 'sentinel.txt'), 'utf8'), 'MAIN_UNCHANGED')
    await assert.rejects(access(join(mainWorkdir, 'result.txt')), { code: 'ENOENT' })
  }

  try {
    await mkdir(mainWorkdir, { recursive: true })
    await mkdir(childWorkdir, { recursive: true })
    await writeFile(join(mainWorkdir, 'sentinel.txt'), 'MAIN_UNCHANGED')
    await writeFile(join(childWorkdir, 'sentinel.txt'), 'CHILD_ONLY')
    await startMain()
    const config = {
      version: 1, enabled: true, host: '127.0.0.1', port: await availablePort(),
      allowInsecureLocalTransport: true,
    } as const
    assert.equal((await adminRequest('/nodes/v1/network', 'GET', undefined, false)).status, 401)
    assert.equal((await adminRequest('/nodes/v1/network', 'PUT', config, false)).status, 401)
    assert.equal(network!.getState().state, 'disabled')
    const state = await adminJson<{ state: string; endpoint: string }>('/nodes/v1/network', 'PUT', config)
    assert.equal(state.state, 'listening')
    const endpoint = state.endpoint
    assert.equal(endpoint, `http://127.0.0.1:${config.port}`)
    for (const path of ['/nodes/v1', '/nodes/v1/pending', '/nodes/v1/network', '/api/config', '/']) {
      assert.equal((await request(endpoint, path, 'GET', undefined, true)).status, 404)
    }
    assert.equal((await request(endpoint, '/pair/v1/offers', 'POST', undefined, true)).status, 404)
    assert.equal((await adminRequest('/pair/v1/offers', 'POST', undefined, false)).status, 401)
    const offerResponse = await adminRequest('/pair/v1/offers', 'POST')
    assert.equal(offerResponse.status, 201)
    const offer = await offerResponse.json() as { offerId: string; pin: string }
    const childConfig: ChildBootstrapConfigV1 = {
      version: 1, mode: 'child', localNodeId: childNodeId, dataDir: childPaths.dataDir,
      mainEndpoint: endpoint, allowInsecureLocalTransport: true,
      workdirs: [{ workdirId, displayName: 'Child-only files', rootPath: childWorkdir }],
    }
    await assert.rejects(pairProductionChild(childConfig, childPaths, {
      offerId: offer.offerId,
      pin: `${offer.pin[0] === '0' ? '1' : '0'}${offer.pin.slice(1)}`,
      displayName: 'Wrong PIN must not pair', keyStore, signal: AbortSignal.timeout(5_000),
    }), /Main pairing request failed with status 401/)
    assert.equal(await new AtomicDeviceCredentialReferenceStore(childPaths.childCredentialPath).load(), null)
    assert.equal(cluster!.registry.getPending().length, 0)
    const paired = await pairProductionChild(childConfig, childPaths, {
      offerId: offer.offerId, pin: offer.pin, displayName: 'Integration Child',
      keyStore, signal: AbortSignal.timeout(5_000),
    })
    assert.deepEqual(await new AtomicDeviceCredentialReferenceStore(childPaths.childCredentialPath).load(), paired.reference)
    const approvalPath = `/nodes/v1/pending/${paired.pendingId}/approve`
    const approval = { version: 1, expectedDeviceIdentityFingerprint: paired.reference.deviceIdentityFingerprint }
    assert.equal((await adminRequest(approvalPath, 'POST', approval, false)).status, 401)
    assert.equal((await request(endpoint, approvalPath, 'POST', approval, true)).status, 404)
    const mismatch = await adminRequest(approvalPath, 'POST', {
      ...approval, expectedDeviceIdentityFingerprint: 'incorrect-fingerprint',
    })
    assert.equal(mismatch.status, 400)
    assert.deepEqual(await mismatch.json(), { error: 'invalid_approval' })
    const authentication = {
      version: 1, deviceId: paired.reference.deviceId, nodeId: childNodeId,
      credentialId: paired.reference.credentialId,
    }
    assert.equal((await request(endpoint, '/cluster/v1/challenges', 'POST', authentication)).status, 404)
    child = await startProductionChildRuntime(childConfig, childPaths, { keyStore })
    await bounded(child.ready, 'unapproved Child ready')
    await delay(350)
    assert.equal(cluster!.activeSessionCount, 0, 'Pending fingerprint must not admit a node session')
    assert.equal(cluster!.registry.getPending().length, 1)
    await adminJson(approvalPath, 'POST', approval)
    await connected()
    await verifyExecution('after-approval')

    await adminJson('/nodes/v1/network', 'PUT', { ...config, enabled: false })
    await until(() => cluster!.activeSessionCount === 0, 'listener disable disconnects Child')
    const offline = (await adminJson<NodeInventoryResponse>('/nodes/v1')).nodes.find(node => node.nodeId === childNodeId)
    assert.equal(offline?.connection, 'offline')
    assert(offline?.workdirs.every(workdir => !workdir.online))
    await adminJson('/nodes/v1/network', 'PUT', config)
    await connected()
    await verifyExecution('after-listener-reenable')

    await bounded(child.shutdown(), 'first Child shutdown')
    child = undefined
    await stopMain()
    assert.deepEqual(JSON.parse(await readFile(networkPath, 'utf8')), config)
    const referenceBeforeRestart = await readFile(childPaths.childCredentialPath, 'utf8')
    const persisted = await new AtomicFileRegistrySnapshotAdapter(mainPaths.clusterSnapshotPath).load()
    assert(persisted, 'Main registry must exist on disk')
    await startMain()
    assert.equal(network!.getState().endpoint, endpoint)
    assert.equal(network!.getState().state, 'listening')
    assert.equal(cluster!.registry.getPending().length, 0)
    const restored = (await adminJson<NodeInventoryResponse>('/nodes/v1')).nodes.find(node => node.nodeId === childNodeId)
    assert.equal(restored?.connection, 'offline')
    assert(restored?.workdirs.some(resource => resource.workdirId === workdirId && !resource.online))
    child = await startProductionChildRuntime(childConfig, childPaths, { keyStore })
    await bounded(child.ready, 'restored Child ready')
    await connected()
    await verifyExecution('after-both-runtimes-restart')
    assert.equal(await readFile(childPaths.childCredentialPath, 'utf8'), referenceBeforeRestart)
  } finally {
    try {
      await bounded(child?.shutdown() ?? Promise.resolve(), 'final Child cleanup')
    } finally {
      try { await stopMain() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
