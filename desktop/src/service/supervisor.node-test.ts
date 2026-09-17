import assert from 'node:assert/strict'
import test from 'node:test'
import { ServiceAttachmentSupervisor } from './supervisor.js'
import { RuntimeHost, createProductionRuntimeHost } from '../sidecar/runtime-host.js'
import { createSidecarReadinessProbe } from '../sidecar/local-control-client.js'
import type { ServiceConnection } from './connection.js'
import type { SidecarReadinessResult, SidecarStartRequest } from '../sidecar/supervisor.js'

const connection: ServiceConnection = {
  descriptor: {
    version: 1, serviceName: 'ShadowService', role: 'main',
    apiBase: 'http://127.0.0.1:18800', port: 18800,
    credentialPath: 'C:\\service\\launch-token', configPath: 'C:\\service\\runtime-config.v1.json',
  },
  launchToken: 'a'.repeat(43),
}
const paths = { executablePath: 'C:\\Shadow\\Shadow.exe', appPath: 'C:\\Shadow', resourcesPath: 'C:\\Shadow\\resources', userDataPath: 'C:\\user', packaged: true }
const request: SidecarStartRequest = {
  executablePath: paths.executablePath, entryPath: 'unused', configPath: 'unused',
  launchToken: connection.launchToken, role: 'main', port: 18800, localExecutor: false,
}

test('attachment uses authoritative authenticated readiness and stop only detaches', async () => {
  const calls: unknown[] = []
  const supervisor = new ServiceAttachmentSupervisor(connection, async (...args) => {
    calls.push(args)
    return { ready: true }
  })
  const authorizations: unknown[] = []
  const host = new RuntimeHost({
    paths, tokenFactory: () => connection.launchToken, supervisorFactory: () => supervisor,
    onAuthorizationChanged: (value) => { authorizations.push(value) },
  })
  const first = host.start(request)
  assert.equal(host.start(request), first)
  assert.equal((await first).phase, 'ready')
  assert.deepEqual(calls, [[connection.descriptor.apiBase, connection.launchToken]])
  assert.deepEqual(authorizations, [{ apiBase: connection.descriptor.apiBase, launchToken: connection.launchToken }])
  await host.stop()
  assert.equal(supervisor.status.phase, 'stopped')
  assert.equal(authorizations.at(-1), null)
  assert.equal(calls.length, 1)
})

test('mismatch and unavailable service fail explicitly without sidecar fallback', async () => {
  for (const patch of [{ port: 18801 }, { role: 'child' as const }, { localExecutor: true }, { launchToken: 'other' }]) {
    const supervisor = new ServiceAttachmentSupervisor(connection, async () => { throw new Error('must not probe') })
    await assert.rejects(supervisor.start({ ...request, ...patch }), /does not match/)
  }
  for (const status of [401, 503, 200]) {
    const supervisor = new ServiceAttachmentSupervisor(connection, createSidecarReadinessProbe({
      expectedRole: 'main',
      fetch: async () => Response.json({ version: 1, role: 'child', status: 'ready' }, { status }),
    }))
    await assert.rejects(supervisor.start(request), /attachment failed/)
    assert.equal(supervisor.status.phase, 'failed')
  }
  const host = createProductionRuntimeHost(paths, undefined, connection)
  await assert.rejects(host.start({ ...request, port: 18801 }), /does not match/)
  await host.stop()
})

test('late readiness cannot reauthorize a detached service or a quitting host', async () => {
  let resolveProbe!: (value: SidecarReadinessResult) => void
  const supervisor = new ServiceAttachmentSupervisor(connection, () => new Promise((resolve) => { resolveProbe = resolve }))
  const authorizations: unknown[] = []
  const host = new RuntimeHost({
    paths, tokenFactory: () => connection.launchToken, supervisorFactory: () => supervisor,
    onAuthorizationChanged: (value) => { authorizations.push(value) },
  })

  const starting = host.start(request)
  await host.stop()
  resolveProbe({ ready: true })
  await assert.rejects(starting, /attachment failed/)
  assert.ok(authorizations.every((value) => value === null))
  assert.throws(() => host.start(request), /stopping/)
})

test('subsequent service attachment requests revalidate readiness and revoke stale authorization', async () => {
  let ready = true
  let probes = 0
  const authorizations: unknown[] = []
  const host = new RuntimeHost({
    paths, revalidateOnStart: true, tokenFactory: () => connection.launchToken,
    supervisorFactory: () => new ServiceAttachmentSupervisor(connection, async () => {
      probes++
      return { ready }
    }),
    onAuthorizationChanged: (value) => { authorizations.push(value) },
  })
  await host.start(request)
  ready = false
  await assert.rejects(host.start(request), /attachment failed/)
  assert.equal(probes, 2)
  assert.equal(authorizations.at(-1), null)
  await host.stop()
})
