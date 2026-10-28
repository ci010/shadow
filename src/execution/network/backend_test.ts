import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { backendNetworkPolicySummary, initializeBackendNetwork, refreshBackendNetwork, updateBackendNetwork } from './backend.ts'
import { ProxyDetectionError } from './proxy-error.ts'

test('startup discovery failure keeps Main local HTTP usable, blocks external fetch, and supports retry', async () => {
  const server = createServer((_req, res) => res.end('local ready'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await initializeBackendNetwork(true, async () => { throw new Error('private-user:credential@host') })
    assert.deepEqual(backendNetworkPolicySummary(), { source: 'unavailable', enabled: true, failureCode: 'SYSTEM_PROXY_UNAVAILABLE', blocked: true })
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'local ready')
    await assert.rejects(fetch('https://must-not-contact.invalid'), error => {
      assert.ok(error instanceof Error && error.cause instanceof ProxyDetectionError)
      assert.doesNotMatch(error.cause.message, /private|credential/)
      return true
    })
    await refreshBackendNetwork(async () => ({ source: 'environment', http: 'http://127.0.0.1:7890', bypass: [] }))
    assert.deepEqual(backendNetworkPolicySummary(), { source: 'environment', enabled: true, blocked: false })
    await refreshBackendNetwork(async () => { throw new ProxyDetectionError('SYSTEM_PROXY_READ_FAILED') })
    assert.equal(backendNetworkPolicySummary().failureCode, 'SYSTEM_PROXY_READ_FAILED')
    await assert.rejects(fetch('https://must-not-contact.invalid'))
    await updateBackendNetwork(false)
    assert.deepEqual(backendNetworkPolicySummary(), { source: 'direct', enabled: false, blocked: false })
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
