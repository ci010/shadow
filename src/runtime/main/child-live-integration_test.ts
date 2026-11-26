import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { on, once } from 'node:events'
import WebSocket, { type RawData } from 'ws'
import { REALTIME_SOCKET_PROTOCOL } from '../../realtime/socket-ticket.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startMainRuntime } from './start.ts'
import { InMemoryPairingNodeRegistry } from '../../cluster/registry.ts'
import { AtomicFileRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import { devicePublicKeyFingerprint, encodeBase64Url } from '../../cluster/device-challenge.ts'
import { DeviceCredentialProof } from '../../cluster/device-credentials.ts'
import { requestDeviceChallengeProtocol } from '../../cluster/device-challenge-client.ts'
import { DEVICE_UI_SESSION, DEVICE_UI_SESSION_CHALLENGE } from '../../cluster/direct-device-ui.ts'

import { join } from 'node:path'

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as import('node:net').AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}

test('Child opens the shared Main live WebSocket directly; disable/re-enable and revoke invalidate grants and sockets', { timeout: 60_000 }, async t => {
  await withTempWorkspace(async root => {
    const keysToIsolate = ['GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE', 'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE', 'VITE_DEV_URL', 'SHADOW_MOBILE_ORIGIN', 'SHADOW_MOBILE_PORT']
    const previous = new Map(keysToIsolate.map(key => [key, process.env[key]]))
    for (const key of keysToIsolate) delete process.env[key]
    process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
    const viteOrigin = 'http://127.0.0.1:5273'
    process.env.VITE_DEV_URL = viteOrigin
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
    const port = await freePort(); const devicePort = port
    const mainBase = `http://127.0.0.1:${port}`, deviceBase = `http://127.0.0.1:${devicePort}`
    const runtime = await startMainRuntime(config, { configPath, clusterSnapshotPath: registryPath, localNodeId: 'fixture-main', gateway: { host: '127.0.0.1', port, launchCredential: 'fixture-main-secret' } })
    try {
      await runtime.ready
      const setup = await fetch(`${mainBase}/nodes/v1/network`, { method: 'PUT', headers: { Authorization: 'Bearer fixture-main-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, enabled: true, host: '127.0.0.1', port: devicePort, allowInsecureLocalTransport: true }) })
      assert.equal(setup.status, 200, await setup.text())
      const childBase = deviceBase // Same Main socket as desktop; no Child HTTP server is started.
      const issue = async () => {
        const proof = await requestDeviceChallengeProtocol(childBase, auth,
          new DeviceCredentialProof(async bytes => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(bytes)))),
          fetch, AbortSignal.timeout(5000), DEVICE_UI_SESSION_CHALLENGE)
        const exchange = () => fetch(childBase + DEVICE_UI_SESSION, { method: 'POST', headers: { 'X-Shadow-Device-Proof': proof } })
        const grant = await exchange()
        assert.equal(grant.status, 200, await grant.clone().text())
        assert.equal((await exchange()).status, 401, 'one-use proof')
        return (await grant.json() as { token: string }).token
      }
      let token = await issue()
      const childRequest = (path: string, init: RequestInit = {}) => fetch(childBase + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `ShadowDevice ${token}` } })
      assert.equal((await fetch(childBase + '/api/projects')).status, 401)
      const ownerHeaders = { Authorization: 'Bearer fixture-main-secret' }
      const livePath = '/api/live/ws'
      const ticketRequest = { method: 'POST', headers: { Origin: viteOrigin }, signal: AbortSignal.timeout(6000) }
      assert.equal((await fetch(childBase + livePath, ticketRequest)).status, 401)
      assert.equal((await fetch(childBase + livePath, { ...ticketRequest, headers: { ...ticketRequest.headers, ...ownerHeaders } })).status, 200)
      for (const [path, method] of [
        ['/local/v1/readiness', 'GET'], ['/nodes/v1/network', 'GET'], ['/api/provider/setup', 'POST'],
        ['/projects/default/api/config', 'PATCH'], ['/projects/default/api/credential-requests', 'GET'],
      ]) assert.equal((await childRequest(path, { method })).status, 401, path)
      assert.equal((await fetch(childBase + '/cluster/v1/node')).status, 426)
      const ticket = await childRequest(livePath, ticketRequest)
      assert.equal(ticket.status, 200, await ticket.clone().text())
      assert.equal(ticket.headers.get('access-control-allow-origin'), viteOrigin)
      assert.equal(ticket.headers.get('cache-control'), 'no-store')
      const { protocol, proof: ticketProof } = await ticket.json()
      assert.equal(protocol, REALTIME_SOCKET_PROTOCOL)
      const wsUrl = childBase.replace('http:', 'ws:') + livePath
      const deniedUpgrade = async (protocols: string[], origin: string) => {
        const rejected = new WebSocket(wsUrl, protocols, { origin, handshakeTimeout: 2500 })
        await assert.rejects(once(rejected, 'open'), /Unexpected server response: 401/)
      }
      await deniedUpgrade([protocol], viteOrigin)
      await deniedUpgrade([protocol, ticketProof], childBase)
      const live = new WebSocket(wsUrl, [protocol, ticketProof], { origin: viteOrigin, handshakeTimeout: 5000 })
      try {
        const messages = on(live, 'message', { signal: AbortSignal.timeout(7000) })
        const receive = async () => JSON.parse(((await messages.next()).value as [RawData])[0].toString())
        await once(live, 'open')
        assert.equal(live.protocol, REALTIME_SOCKET_PROTOCOL)
        await deniedUpgrade([protocol, ticketProof], viteOrigin)
        const projectsTopic = { kind: 'projects' }
        const chatId = 'child-live-open'
        const firstChat = { kind: 'chat', projectId: 'default', sessionId: `web:${chatId}` }
        const nextChatId = 'child-live-open-next'
        const nextChat = { ...firstChat, sessionId: `web:${nextChatId}` }
        const denied = { ...firstChat, projectId: 'missing' }
        const open = (id: number, topic: typeof firstChat) => live.send(JSON.stringify({ type: 'openConversation', id,
          subscriptions: [projectsTopic, topic, denied].map(topic => ({ topic })), conversations: [topic, denied] }))
        // Persist two sessions without calling the fixture's unused model, and
        // wait on the same socket for each command to finish before opening it.
        live.send(JSON.stringify({ type: 'subscribe', id: 0, subscriptions: [firstChat, nextChat].map(topic => ({ topic })) }))
        assert.equal((await receive()).id, 0)
        for (const id of [chatId, nextChatId]) {
          const seed = await childRequest('/projects/default/api/chat/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: id, content: '/help', stream: false }),
          })
          assert.equal(seed.status, 200, await seed.clone().text())
          const { requestId } = await seed.json()
          for (;;) {
            const event = await receive()
            if (event.type === 'event' && event.requestId === requestId && event.payload.done) break
          }
        }
        open(1, firstChat)
        const first = await receive()
        assert.equal(first.type, 'subscribed')
        assert.equal(first.id, 1)
        assert.deepEqual(first.added.map((entry: { topic: object }) => entry.topic), [projectsTopic])
        assert.deepEqual(first.removed, [nextChat])
        assert.deepEqual(first.rejected, [denied])
        assert.equal(first.conversationOpen, true)
        assert.match(first.cursor, /:\d+$/)
        assert.deepEqual(first.conversations[0].topic, firstChat)
        assert.ok(first.conversations[0].data, first.conversations[0].error)
        assert.equal(first.conversations[0].data.chat.chatId, chatId)
        assert.equal(first.conversations[0].data.details.sessionId, firstChat.sessionId)
        assert.ok(first.conversations[0].data.chat.commandResults.length > 0)
        assert.deepEqual(first.conversations[1], { topic: denied, error: 'conversation_unavailable' })
        open(2, nextChat)
        const second = await receive()
        assert.equal(second.type, 'subscribed')
        assert.equal(second.id, 2)
        assert.deepEqual(second.added.map((entry: { topic: object }) => entry.topic), [nextChat])
        assert.deepEqual(second.removed, [firstChat])
        assert.deepEqual(second.rejected, [denied])
        assert.deepEqual(second.conversations[0].topic, nextChat)
        assert.ok(second.conversations[0].data, second.conversations[0].error)
        assert.equal(second.conversations[0].data.chat.chatId, nextChatId)
        assert.equal(second.conversations[0].data.details.sessionId, nextChat.sessionId)
        assert.ok(second.conversations[0].data.chat.commandResults.length > 0)
        assert.deepEqual(second.conversations[1], { topic: denied, error: 'conversation_unavailable' })
        const rename = await childRequest('/api/projects/default', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Updated live fixture' }),
        })
        assert.equal(rename.status, 200)
        const update = await receive()
        assert.equal(update.type, 'event')
        assert.deepEqual(update.topic, projectsTopic)
        const revokePath = `/nodes/v1/${auth.nodeId}/revoke`
        assert.equal((await childRequest(revokePath, { method: 'POST' })).status, 401)
        const configure = (enabled: boolean) => fetch(mainBase + '/nodes/v1/network', { method: 'PUT',
          headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, enabled, host: '127.0.0.1', port: devicePort, allowInsecureLocalTransport: true }) })
        const closed = once(live, 'close', { signal: AbortSignal.timeout(4000) })
        assert.equal((await configure(false)).status, 200)
        await closed
        assert.equal((await fetch(mainBase + '/api/projects', { headers: ownerHeaders })).status, 200, 'desktop gateway survives device disable')
        assert.equal((await fetch(mainBase + '/cluster/v1/node')).status, 404)
        assert.equal((await childRequest('/api/projects')).status, 401)
        assert.equal((await configure(true)).status, 200)
        assert.equal((await childRequest('/api/projects')).status, 401, 'old grant never resurrects')
        token = await issue()
        const secondTicket = await (await childRequest(livePath, { method: 'POST', headers: { Origin: viteOrigin } })).json()
        const secondSocket = new WebSocket(wsUrl, [secondTicket.protocol, secondTicket.proof], { origin: viteOrigin, handshakeTimeout: 5000 })
        try {
          await once(secondSocket, 'open')
          const revoked = once(secondSocket, 'close', { signal: AbortSignal.timeout(4000) })
          assert.equal((await fetch(mainBase + revokePath, { method: 'POST', headers: ownerHeaders })).status, 200)
          await revoked
          assert.equal((await childRequest('/api/projects')).status, 401)
          assert.equal((await childRequest(livePath, { ...ticketRequest, signal: AbortSignal.timeout(5000) })).status, 401)
        } finally { secondSocket.terminate() }
        await messages.return?.()
      } finally { live.terminate() }
    } finally { await runtime.shutdown() }
  })
})
