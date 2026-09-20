import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilityAvailability, capabilitySummary, fetchNodeInventory, parseNodeInventory } from './node-inventory.ts'
import { createLocalMainAdminContext } from './installation-context.ts'

const node = {
  nodeId: 'fixture-main', displayName: 'Main', role: 'main', connection: 'connected',
  capabilities: [{ capabilityId: 'source', kind: 'workdir', displayName: 'Source', online: true, displayPath: 'C:\\synthetic\\source' }],
}
const inventory = () => ({ version: 1, nodes: [structuredClone(node)] })

test('node inventory preserves actual data and omits unsupported fields', () => {
  assert.deepEqual(parseNodeInventory(inventory()), inventory())
  assert.deepEqual(parseNodeInventory({ version: 1, nodes: [] }), { version: 1, nodes: [] })
  const result = parseNodeInventory({ version: 1, nodes: [{ ...node, credentialId: 'not-for-renderer', implementationVersion: '1.0', lastSeen: '2026-09-11T01:00:00.000Z' }] })
  assert.equal(result.nodes[0].implementationVersion, '1.0')
  assert.equal('credentialId' in result.nodes[0], false)
  assert.equal('implementationVersion' in parseNodeInventory(inventory()).nodes[0], false)
  assert.equal(parseNodeInventory({ version: 1, nodes: [{ ...node, supportsManagedSessions: true }] }).nodes[0].supportsManagedSessions, true)
  assert.equal(parseNodeInventory(inventory()).nodes[0].supportsManagedSessions, undefined)
})

test('browser context does not invent device identity or latency measurements', () => {
  const context = createLocalMainAdminContext('http://localhost')
  assert.equal(context.localNodeId, 'local')
  assert.equal(context.mainLatencyMs, null)
})

test('invalid or ambiguous inventory never becomes an empty successful response', () => {
  for (const value of [null, {}, { version: 2, nodes: [] }, { version: 1, nodes: null }]) assert.throws(() => parseNodeInventory(value), /invalid device data/)
  for (const patch of [
    { nodeId: '' }, { role: 'other' }, { connection: 'online' }, { capabilities: null },
    { lastSeen: 'yesterday' }, { implementationVersion: 12 }, { supportsManagedSessions: 'true' },
    { capabilities: [{ ...node.capabilities[0], kind: 'invented' }] },
    { capabilities: [{ ...node.capabilities[0], online: 'true' }] },
    { capabilities: [{ ...node.capabilities[0], displayPath: 12 }] },
    { capabilities: [node.capabilities[0], node.capabilities[0]] },
  ]) assert.throws(() => parseNodeInventory({ version: 1, nodes: [{ ...node, ...patch }] }), /invalid device data/)
  assert.throws(() => parseNodeInventory({ version: 1, nodes: [node, node] }), /invalid device data/)
})

test('capability types are counted independently of IDs and require a connected node for availability', () => {
  const parsed = parseNodeInventory(inventory()).nodes[0]
  assert.equal(capabilitySummary(parsed.capabilities), 'Workdir (1)')
  assert.equal(capabilitySummary([]), '')
  const kinds = ['workdir', 'shell', 'browser', 'windows-ui', 'gpu'] as const
  assert.equal(capabilitySummary(kinds.map(kind => ({ ...parsed.capabilities[0], kind }))), 'Workdir (1) · Shell (1) · Browser (1) · Desktop control (1) · GPU (1)')
  assert.equal(capabilityAvailability(parsed, parsed.capabilities[0]), 'online')
  assert.equal(capabilityAvailability({ ...parsed, connection: 'offline' }, parsed.capabilities[0]), 'unavailable')
  assert.equal(capabilityAvailability({ ...parsed, connection: 'revoked' }, parsed.capabilities[0]), 'revoked')
  assert.equal(capabilityAvailability(parsed, { ...parsed.capabilities[0], online: false }), 'unavailable')
})

test('Main and Child request their respective authenticated backend inventory with cancellation', async () => {
  const controller = new AbortController()
  for (const mode of ['main', 'child'] as const) {
    const result = await fetchNodeInventory('http://127.0.0.1:43123', mode, controller.signal, async (url, options) => {
      assert.equal(String(url), `http://127.0.0.1:43123${mode === 'main' ? '/nodes/v1' : '/local/v1/nodes'}`)
      assert.equal(options?.signal, controller.signal)
      assert.equal(options?.cache, 'no-store')
      return Response.json(inventory())
    })
    assert.equal(result.nodes[0].nodeId, 'fixture-main')
  }
})

test('missing, forbidden, failed and malformed responses are explicit errors, never fixtures', async () => {
  for (const [status, message] of [[401, /denied/], [403, /denied/], [404, /Restart Shadow/], [501, /Restart Shadow/], [503, /503/]] as const) {
    await assert.rejects(fetchNodeInventory('http://localhost', 'main', new AbortController().signal, async () => new Response('', { status })), message)
  }
  await assert.rejects(fetchNodeInventory('http://localhost', 'main', new AbortController().signal, async () => Response.json({})), /invalid device data/)
  await assert.rejects(fetchNodeInventory('http://localhost', 'main', new AbortController().signal, async () => new Response('<html>Old SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } })), /Restart Shadow/)
  await assert.rejects(fetchNodeInventory('http://localhost', 'main', new AbortController().signal, async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })), /invalid device data/)
  await assert.rejects(fetchNodeInventory('http://localhost', 'main', new AbortController().signal, async () => { throw new TypeError('Failed to fetch') }), /Failed to fetch/)
})
