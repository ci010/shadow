import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServiceBootstrapCoordinator } from './bootstrap.js'
import { RuntimeHost } from '../sidecar/runtime-host.js'
import { ServiceAttachmentSupervisor } from './supervisor.js'
import type { ServiceConnection } from './connection.js'

test('service bootstrap uses only its explicit config and never changes the desktop sidecar profile', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.service-test-'))
  try {
    const configPath = join(directory, 'runtime-config.v1.json')
    await writeFile(configPath, JSON.stringify({ version: 1, mode: 'main', dataDir: directory, localNodeId: 'service-main' }))
    const connection: ServiceConnection = {
      descriptor: { version: 1, serviceName: 'ShadowService', role: 'main', port: 18800,
        apiBase: 'http://127.0.0.1:18800', configPath, credentialPath: join(directory, 'unused-token') },
      launchToken: 's'.repeat(43),
    }
    const host = new RuntimeHost({
      paths: { executablePath: 'unused', resourcesPath: 'unused', appPath: 'unused', userDataPath: join(directory, 'nonexistent-desktop'), packaged: true },
      tokenFactory: () => connection.launchToken,
      supervisorFactory: () => new ServiceAttachmentSupervisor(connection, async () => ({ ready: true })),
    })
    const coordinator = createServiceBootstrapCoordinator(connection.descriptor, host)
    assert.equal((await coordinator.load()).step, 'complete')
    const result = await coordinator.ensureRuntime()
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.context.localNodeId, 'service-main')
      assert.equal(result.context.apiBase, connection.descriptor.apiBase)
      assert.equal('launchToken' in result.context, false)
    }
    await assert.rejects(coordinator.clear(), /read-only/)
    await assert.rejects(coordinator.getMainDirectorySelection(), /only available/)
    assert.equal((await coordinator.launchMain({ port: 18801, localExecutor: true })).ok, false)
    await host.stop()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
