import { deepEqual as assertEquals, rejects as assertRejects } from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
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
  const reservation = createServer().listen({ host: '127.0.0.1', port: 0 })
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('Missing TCP address')
  const localControlPort = address.port
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve())
  })
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
      workdirs: [{ capabilityId: 'folder-root', displayName: 'Child folder', rootPath: folders }],
    },
    { ...paths, dataDir: workspace },
    {
      keyStore,
      referenceStore,
      localControl: {
        port: localControlPort,
        launchCredential: 'production-child-secret',
      },
      fetchChallenge: () =>
        Promise.resolve(new Response(null, { status: 404 })),
    },
  )

  t.after(() => runtime.shutdown())
  await runtime.ready
  const readiness = await fetch(
    `http://127.0.0.1:${localControlPort}/local/v1/readiness`,
    { headers: { Authorization: 'Bearer production-child-secret' } },
  )
  assertEquals(readiness.status, 200)
  assertEquals(await readiness.json(), {
    version: 1,
    role: 'child',
    status: 'ready',
  })
  const inventoryUrl = `http://127.0.0.1:${localControlPort}/local/v1/nodes`
  assertEquals((await fetch(inventoryUrl)).status, 401)
  assertEquals((await fetch(inventoryUrl, {
    headers: { Authorization: 'Bearer incorrect' },
  })).status, 401)
  const inventory = await fetch(inventoryUrl, {
    headers: { Authorization: 'Bearer production-child-secret' },
  })
  assertEquals(inventory.status, 200)
  assertEquals(inventory.headers.get('Cache-Control'), 'no-store')
  const body = await inventory.json()
  assertEquals(body.version, 1)
  assertEquals(body.nodes.length, 1)
  assertEquals(body.nodes[0].nodeId, 'node-1')
  assertEquals(body.nodes[0].role, 'child')
  assertEquals(body.nodes[0].connection, 'offline')
  assertEquals(body.nodes[0].supportsManagedSessions, true)
  assertEquals(body.nodes[0].capabilities, [{
    capabilityId: 'process-execute', kind: 'shell', displayName: 'Local shell', online: true,
  }, {
    capabilityId: 'owner-folder-picker-v1', kind: 'shell', displayName: 'Owner folder picker', online: true,
  }, {
    capabilityId: 'managed-sessions-v1', kind: 'shell', displayName: 'Managed session allocation', online: true,
  }, {
    capabilityId: 'folder-root', kind: 'workdir', displayName: 'Child folder', online: true, displayPath: folders,
  }])
  assertEquals(JSON.stringify(body).includes('credential'), false)
  assertEquals(JSON.stringify(body).includes('fingerprint'), false)
  assertEquals((await fetch(
    `http://127.0.0.1:${localControlPort}/nodes/v1`,
    { headers: { Authorization: 'Bearer production-child-secret' } },
  )).status, 503) // Main workspace proxy is explicit about an unavailable/unapproved Main.
  assertEquals(await Promise.all([runtime.shutdown(), runtime.shutdown()]), [
    undefined,
    undefined,
  ])
  await runtime.finished
})
