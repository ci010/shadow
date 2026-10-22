import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalMainAdminContext } from '../installation-context.ts'
import {
  canAdministerDevices, defaultDeviceHost, deviceAdminRequest, deviceApprovalBody,
  deviceHostChoices, invitationRemaining, isLocalDeviceAddress, parseDeviceInvitation,
  parseDeviceNetwork, parsePendingDevices, validateDeviceApproval, type DeviceNetwork, type PendingDevice,
} from './device-administration.ts'

const settings: DeviceNetwork = {
  version: 1, enabled: false, host: '127.0.0.1', port: 3124, allowInsecureLocalTransport: false,
  state: 'disabled', endpoint: null, error: null,
  addresses: [
    { name: 'loopback', address: '127.0.0.1' }, { name: 'LAN', address: '192.168.1.12' },
    { name: 'duplicate', address: '192.168.1.12' }, { name: 'public', address: '8.8.8.8' },
    { name: 'VPN', address: '100.64.1.2' },
  ],
}
const pending: PendingDevice = {
  version: 1, pendingId: 'pending-1', deviceId: 'device-1', nodeId: 'node-1', credentialId: 'credential-1',
  deviceIdentityFingerprint: 'a'.repeat(64), displayName: 'Test Child', requestedAt: '2026-09-20T12:00:00Z',
}

test('only a Main with node administration scope gets controls', () => {
  const main = createLocalMainAdminContext('http://127.0.0.1:3123')
  assert.equal(canAdministerDevices(main), true)
  assert.equal(canAdministerDevices({ ...main, mode: 'child' }), false)
  assert.equal(canAdministerDevices({ ...main, uiScopes: ['chat:read'] }), false)
})

test('network choices stay on known private IPv4 addresses and default off loopback', () => {
  assert.equal(defaultDeviceHost(settings), '192.168.1.12')
  assert.deepEqual(deviceHostChoices(settings).map(value => value.address), ['127.0.0.1', '192.168.1.12', '100.64.1.2'])
  for (const value of ['0.0.0.0', '8.8.8.8', '192.168.1.256', '10.001.1.1', 'localhost', '172.32.1.2', '100.128.0.1', '::1']) {
    assert.equal(isLocalDeviceAddress(value), false, value)
  }
  for (const value of ['10.1.2.3', '172.16.0.1', '172.31.0.1', '169.254.1.2', '100.127.0.1']) assert.equal(isLocalDeviceAddress(value), true)
  assert.deepEqual(parseDeviceNetwork(settings), settings)
  assert.throws(() => parseDeviceNetwork({ ...settings, state: 'listening' }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, endpoint: 'http://8.8.8.8:3124' }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, endpoint: 'http://user:secret@192.168.1.2:3124' }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, port: 0 }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, port: 1023 }), /invalid/)
  assert.equal(parseDeviceNetwork({ ...settings, port: 1024 }).port, 1024)
  assert.equal(parseDeviceNetwork({ ...settings, port: 65535 }).port, 65535)
  assert.throws(() => parseDeviceNetwork({ ...settings, host: '0.0.0.0' }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, state: 'error', error: 'Port unavailable', endpoint: 'http://127.0.0.1:3124' }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, state: 'error', error: null }), /invalid/)
  assert.throws(() => parseDeviceNetwork({ ...settings, state: 'listening', enabled: true, allowInsecureLocalTransport: true, endpoint: 'http://127.0.0.1:3125' }), /invalid/)
})

test('pending identities are validated and approval requires both independent consents', () => {
  assert.deepEqual(parsePendingDevices({ version: 1, pending: [pending] }), [pending])
  assert.throws(() => parsePendingDevices({ version: 1, pending: [pending, pending] }), /invalid/)
  assert.throws(() => parsePendingDevices({ version: 1, pending: [{ ...pending, deviceIdentityFingerprint: '' }] }), /invalid/)
  assert.throws(() => deviceApprovalBody(pending, false, true), /Verify/)
  assert.throws(() => deviceApprovalBody(pending, true, false), /Verify/)
  assert.throws(() => deviceApprovalBody({ ...pending, credentialId: undefined }, true, true), /Pair again/)
  assert.deepEqual(deviceApprovalBody(pending, true, true), { version: 1, expectedDeviceIdentityFingerprint: pending.deviceIdentityFingerprint })
  validateDeviceApproval({ version: 1, deviceId: pending.deviceId, nodeId: pending.nodeId, credentialId: pending.credentialId }, pending)
  assert.throws(() => validateDeviceApproval({ version: 1, deviceId: pending.deviceId, nodeId: 'wrong', credentialId: pending.credentialId }, pending), /invalid/)
})

test('invitations preserve leading zero PINs and become unusable exactly at expiry', () => {
  const offer = parseDeviceInvitation({ version: 1, offerId: 'offer-1', pin: '000012', expiresAt: '2026-09-20T12:01:00Z' })
  assert.equal(offer.pin, '000012')
  assert.equal(invitationRemaining(offer, Date.parse('2026-09-20T12:00:00Z')), 60)
  assert.equal(invitationRemaining(offer, Date.parse(offer.expiresAt)), 0)
  assert.equal(invitationRemaining(offer, Date.parse(offer.expiresAt) + 1), 0)
  assert.throws(() => parseDeviceInvitation({ ...offer, pin: 12 }), /invalid/)
  assert.throws(() => parseDeviceInvitation({ ...offer, expiresAt: 'invalid' }), /invalid/)
})

test('admin requests use the root gateway, carry no renderer secret, and propagate abort', async () => {
  const controller = new AbortController()
  const body = deviceApprovalBody(pending, true, true)
  await deviceAdminRequest('http://127.0.0.1:3123/projects/example/', '/nodes/v1/pending/pending-1/approve', controller.signal, 'POST', body,
    async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:3123/nodes/v1/pending/pending-1/approve')
      assert.equal(init?.signal, controller.signal)
      assert.equal(init?.cache, 'no-store')
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).has('Authorization'), false)
      assert.deepEqual(JSON.parse(String(init?.body)), body)
      return Response.json({ version: 1 })
    })
  controller.abort()
  await assert.rejects(deviceAdminRequest('http://127.0.0.1:3123', '/nodes/v1/pending', controller.signal, 'GET', undefined,
    async (_input, init) => { init?.signal?.throwIfAborted(); return Response.json({}) }), { name: 'AbortError' })
})

test('administration failures explain authentication, stale requests and backend upgrades', async () => {
  for (const [status, path, message] of [
    [401, '/nodes/v1/network', /authorized Main desktop/],
    [403, '/pair/v1/offers', /authorized Main desktop/],
    [404, '/nodes/v1/network', /Restart Main/],
    [404, '/nodes/v1/pending/old/approve', /no longer pending/],
    [500, '/nodes/v1/network', /failed \(500\)/],
  ] as const) {
    await assert.rejects(deviceAdminRequest('http://127.0.0.1:3123', path, new AbortController().signal, 'GET', undefined,
      async () => Response.json({ error: 'synthetic' }, { status })), message)
  }
  await assert.rejects(deviceAdminRequest('http://127.0.0.1:3123', '/nodes/v1/network', new AbortController().signal, 'GET', undefined,
    async () => new Response('<html>old app</html>', { headers: { 'Content-Type': 'text/html' } })), /Restart Main/)
})

test('listener startup failure preserves the saved error state so Main can edit or disable it', async () => {
  const network = { ...settings, enabled: true, allowInsecureLocalTransport: true, state: 'error', error: 'The device port is already in use. Choose a different port.' }
  const result = await deviceAdminRequest('http://127.0.0.1:3123', '/nodes/v1/network', new AbortController().signal, 'PUT', {},
    async () => Response.json({ error: 'device_listener_failed', message: network.error, network }, { status: 503 }))
  assert.deepEqual(result, network)
})
