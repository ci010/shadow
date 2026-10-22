import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChildLocalControlService } from '../child-local-control.ts'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startMainRuntime } from './start.ts'
import { InMemoryPairingNodeRegistry } from '../../cluster/registry.ts'
import { AtomicFileRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import { devicePublicKeyFingerprint, encodeBase64Url } from '../../cluster/device-challenge.ts'
import { DeviceCredentialProof } from '../../cluster/device-credentials.ts'
import { requestDeviceChallengeProtocol } from '../../cluster/device-challenge-client.ts'
import { childWorkspacePlugin } from '../child-workspace.ts'

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as import('node:net').AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}

test('real Main device ingress serves same project/session APIs to approved Child without web login', { timeout: 60_000 }, async t => {
  await withTempWorkspace(async root => {
    const keysToIsolate = ['GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE', 'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE', 'VITE_DEV_URL', 'SHADOW_MOBILE_ORIGIN', 'SHADOW_MOBILE_PORT']
    const previous = new Map(keysToIsolate.map(key => [key, process.env[key]]))
    for (const key of keysToIsolate) delete process.env[key]
    process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
    t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
    const home = join(root, 'home'); await mkdir(home)
    const registryPath = join(root, 'device-state', 'registry.v1.json')
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
    const fingerprint = await devicePublicKeyFingerprint(publicKey)
    const auth = { deviceId: 'device-1', nodeId: 'child-1', credentialId: 'credential-1' }
    const registry = new InMemoryPairingNodeRegistry(); const now = new Date()
    registry.createOffer('offer-1', now, new Date(now.getTime() + 60000))
    registry.presentOffer({ offerId: 'offer-1', pendingId: 'pending-1', ...auth,
      displayName: 'Fixture Child', deviceIdentityFingerprint: fingerprint, devicePublicKey: encodeBase64Url(publicKey) }, now)
    registry.approve({ pendingId: 'pending-1', expectedDeviceIdentityFingerprint: fingerprint, credentialId: auth.credentialId }, now)
    await new AtomicFileRegistrySnapshotAdapter(registryPath).save(registry.exportSnapshot(now))
    const rawConfig = { agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'fixture-unused', baseUrl: 'http://127.0.0.1:1/v1' } }, channels: {}, mcp: {} }
    const config = ConfigSchema.parse(rawConfig)
    const configPath = join(root, 'fixture.json'); await writeFile(configPath, JSON.stringify(rawConfig))
    const port = await freePort(); const devicePort = await freePort()
    const mainBase = `http://127.0.0.1:${port}`, deviceBase = `http://127.0.0.1:${devicePort}`
    const runtime = await startMainRuntime(config, { configPath, clusterSnapshotPath: registryPath, localNodeId: 'fixture-main', gateway: { host: '127.0.0.1', port, launchCredential: 'fixture-main-secret' } })
    try {
      await runtime.ready
      const setup = await fetch(`${mainBase}/nodes/v1/network`, { method: 'PUT', headers: { Authorization: 'Bearer fixture-main-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, enabled: true, host: '127.0.0.1', port: devicePort, allowInsecureLocalTransport: true }) })
      assert.equal(setup.status, 200, await setup.text())
      const child = new ChildLocalControlService({ port: 0, launchCredential: 'fixture-child-secret', requestShutdown() {},
        workspace: childWorkspacePlugin({ endpoint: deviceBase,
        proof: (signal, path) => requestDeviceChallengeProtocol(deviceBase, auth, new DeviceCredentialProof(async bytes => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(bytes)))), fetch, signal, path),
      }) })
      await child.start(new AbortController().signal)
      t.after(() => child.shutdown())
      const childBase = `http://127.0.0.1:${child.address!.port}`
      const childRequest = (path: string, init: RequestInit = {}) => fetch(childBase + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: 'Bearer fixture-child-secret' } })
      assert.equal((await fetch(childBase + '/api/projects')).status, 401)
      assert.equal((await fetch(childBase + '/api/projects', { headers: { Authorization: 'Bearer fixture-main-secret' } })).status, 401)
      const ownerHeaders = { Authorization: 'Bearer fixture-main-secret' }
      const ownerProjects = await (await fetch(`${mainBase}/api/projects`, { headers: ownerHeaders })).json()
      const projects = await childRequest('/api/projects'); assert.equal(projects.status, 200, await projects.clone().text())
      assert.deepEqual(await projects.json(), ownerProjects)
      const rename = await childRequest('/api/projects/default', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Changed from Child workspace' }) })
      assert.equal(rename.status, 200, await rename.clone().text())
      const changed = await (await fetch(`${mainBase}/api/projects`, { headers: ownerHeaders })).json()
      assert.equal(changed.projects.find((project: { id: string }) => project.id === 'default').name, 'Changed from Child workspace')
      for (const path of ['/projects/default/api/sessions', '/projects/default/api/microapps']) {
        const response = await childRequest(path)
        assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
        assert.deepEqual(await response.json(), await (await fetch(mainBase + path, { headers: ownerHeaders })).json())
      }
      const form = new FormData()
      form.set('chatId', 'child-media')
      form.set('file', new File([new Uint8Array([137, 80, 78, 71, 0, 255, 1])], 'pasted.png', { type: 'image/png' }))
      const upload = await childRequest('/projects/default/api/chat/upload', { method: 'POST', body: form })
      assert.equal(upload.status, 200, await upload.clone().text())
      const attachment = await upload.json() as { path: string }
      const mediaPath = `/projects/default/api/media?chatId=child-media&path=${encodeURIComponent(attachment.path)}`
      const media = await childRequest(mediaPath)
      assert.equal(media.status, 200, await media.clone().text())
      const imageBytes = new Uint8Array([137, 80, 78, 71, 0, 255, 1])
      assert.equal(media.headers.get('Content-Type'), 'image/png')
      assert.deepEqual(new Uint8Array(await media.arrayBuffer()), imageBytes)
      const download = await childRequest(`${mediaPath}&download=1`)
      assert.equal(download.status, 200)
      assert.match(download.headers.get('Content-Disposition')!, /^attachment;/)
      assert.deepEqual(new Uint8Array(await download.arrayBuffer()), imageBytes)
      const ranged = await childRequest(mediaPath, { headers: { Range: 'bytes=0-3' } })
      assert.equal(ranged.status, 206)
      assert.equal(ranged.headers.get('Content-Range'), 'bytes 0-3/7')
      assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), imageBytes.slice(0, 4))
      const head = await childRequest(mediaPath, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('Content-Length'), '7')
      assert.equal((await head.arrayBuffer()).byteLength, 0)
      assert.equal((await childRequest(`/projects/default/api/media?chatId=other-chat&path=${encodeURIComponent(attachment.path)}`)).status, 404)
      assert.equal((await fetch(`${deviceBase}/api/projects`)).status, 404)
      assert.equal((await fetch(`${deviceBase}/cluster/v1/ui/request`, { method: 'POST' })).status, 401)
    } finally { await runtime.shutdown() }
  })
})
