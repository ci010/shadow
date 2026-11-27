import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { Server } from 'node:net'
import { EventEmitter, once } from 'node:events'
import type { DeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import {
  type ProtectedDeviceKeyStore,
  ProtectedEd25519DeviceCredentialProvider,
} from '../cluster/device-credentials.ts'
import { startProductionChildRuntime } from './production-child.ts'
import type { RuntimeDerivedPaths } from './runtime-cli.ts'
import { folderFixture } from '../folders/test-fixtures.ts'

const paths: RuntimeDerivedPaths = {
  bootstrapConfigPath: '/state/bootstrap.json',
  bootstrapDirectory: '/state',
  dataDir: '/state/data',
  mutableAgentConfigPath: '/state/data/config/bot.config.json',
  clusterSnapshotPath: '/state/data/cluster/registry.v1.json',
  childCredentialPath: '/state/data/credentials/device-credential.v1.json',
}

function protectedStore(): ProtectedDeviceKeyStore {
  const values = new Map<string, Uint8Array>()
  return {
    providerId: 'test-protected-store',
    load: (keyId) => Promise.resolve(values.get(keyId)?.slice() ?? null),
    save: (keyId, value) => {
      values.set(keyId, value.slice())
      return Promise.resolve()
    },
  }
}

test('production Child fails before dialing when its credential reference is missing', async () => {
  let read = 0
  await assertRejects(
    () =>
      startProductionChildRuntime(
        {
          version: 1,
          mode: 'child',
          dataDir: './data',
          localNodeId: 'node-1',
          mainEndpoint: 'https://main.example.test',
        },
        paths,
        {
          referenceStore: {
            load: () => {
              read++
              return Promise.resolve(null)
            },
            save: () => Promise.resolve(),
          },
        },
      ),
    (error) => error instanceof Error &&
      error.message.includes('credential reference is missing'),
  )
  assertEquals(read, 1)
})

test('production Child rejects non-loopback cleartext without explicit opt-in', async () => {
  let read = 0
  await assertRejects(
    () =>
      startProductionChildRuntime(
        {
          version: 1,
          mode: 'child',
          dataDir: './data',
          localNodeId: 'node-1',
          mainEndpoint: 'http://192.0.2.10:3123',
        },
        paths,
        {
          referenceStore: {
            load: () => {
              read++
              return Promise.resolve(null)
            },
            save: () => Promise.resolve(),
          },
        },
      ),
    { name: 'TypeError', message: /requires https/ },
  )
  assertEquals(read, 0)
})

test('production Child starts with a correlated protected key and shuts down', async (t) => {
  const { workspace, folders } = await folderFixture(t)
  const listen = t.mock.method(Server.prototype, 'listen', function (): never { throw new Error('Child attempted to listen') })
  const emitter = new EventEmitter()
  const ipc = Object.assign(emitter, {
    connected: true,
    send(value: object, callback: (error: Error | null) => void) { emitter.emit('reply', value); callback(null) },
    disconnect() { this.connected = false; emitter.emit('disconnect') },
  })
  let id = 0
  const query = async (operation: string) => {
    const result = once(ipc, 'reply')
    ipc.emit('message', { type: 'shadow-child-control-v1', id: ++id, operation })
    const [reply] = await result
    assertEquals(reply.id, id)
    return reply.result
  }
  const keyStore = protectedStore()
  const provider = new ProtectedEd25519DeviceCredentialProvider(keyStore)
  const identity = await provider.loadOrCreateKey(
    'device-key-1',
    new AbortController().signal,
  )
  const reference = {
    version: 1,
    kind: 'protected-device-credential',
    providerId: keyStore.providerId,
    keyId: identity.keyId,
    deviceId: 'device-1',
    nodeId: 'node-1',
    credentialId: 'credential-1',
    deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
  } as const
  const referenceStore: DeviceCredentialReferenceStore = {
    load: () => Promise.resolve(reference),
    save: () => Promise.resolve(),
  }
  const runtime = await startProductionChildRuntime(
    {
      version: 1,
      mode: 'child',
      dataDir: './data',
      localNodeId: 'node-1',
      mainEndpoint: 'https://main.example.test',
      workdirs: [{ workdirId: 'folder-root', displayName: 'Child folder', rootPath: folders }],
    },
    { ...paths, dataDir: workspace },
    {
      keyStore,
      referenceStore,
      desktopChannel: ipc,
      fetchChallenge: () =>
        Promise.resolve(new Response(null, { status: 404 })),
    },
  )

  t.after(() => runtime.shutdown())
  await runtime.ready
  assertEquals(await query('readiness'), { ready: true, endpoint: 'https://main.example.test' })
  const status = await query('status')
  assertEquals(status.nodeId, 'node-1')
  assertEquals(status.mainEndpoint, 'https://main.example.test')
  assertEquals(await query('/api/projects'), null, 'arbitrary HTTP or business commands are not IPC operations')
  const body = await query('inventory')
  assertEquals(body.version, 1)
  assertEquals(body.nodes.length, 1)
  assertEquals(body.nodes[0].nodeId, 'node-1')
  assertEquals(body.nodes[0].role, 'child')
  assertEquals(body.nodes[0].connection, 'offline')
  assertEquals(body.nodes[0].supportsManagedSessions, false)
  assertEquals(body.nodes[0].executionProtocol, 'unknown')
  assertEquals(body.nodes[0].workdirs.map((w: { workdirId: string; online: boolean }) => ({ workdirId: w.workdirId, online: w.online })), [
    { workdirId: 'folder-root', online: false }, { workdirId: 'device-home-v1', online: false },
  ])
  assertEquals(body.nodes[0].workdirs[1].displayPath, undefined)
  assertEquals(body.nodes[0].workdirs[1].support.operations, ['workdir.process.execute-once', 'workdir.process.reconcile'])
  assertEquals(body.nodes[0].workdirs[0].displayPath, folders)
  assertEquals(new Set(body.nodes[0].workdirs[0].support.operations), new Set(['filesystem.read', 'filesystem.write', 'filesystem.copy.read', 'filesystem.copy.write', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity', 'workdir.process.execute', 'workdir.process.execute-once', 'workdir.process.reconcile', 'workdir.git.derive']))
  assertEquals(body.nodes[0].workdirs[0].support.shell.maxInputBytes, 32768)
  assertEquals(body.nodes[0].workdirs[0].support.shell.maxDeadlineMs, 120000)
  assertEquals(body.nodes[0].workdirs[0].support.shell.shells.includes(process.platform === 'win32' ? 'cmd' : 'sh'), true)
  assertEquals(body.nodes[0].support, { operations: [] })
  assertEquals('capabilities' in body.nodes[0], false)
  assertEquals(JSON.stringify(body).includes('credential'), false)
  assertEquals(JSON.stringify(body).includes('fingerprint'), false)
  assertEquals(await query('grant'), null)
  assertEquals(listen.mock.callCount(), 0)
  ipc.emit('message', { type: 'shadow-child-control-v1', id: ++id, operation: 'shutdown' })
  await runtime.finished
})
