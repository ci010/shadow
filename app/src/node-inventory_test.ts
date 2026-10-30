import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workdirAvailability, workdirSupportsOperations, fetchNodeInventory, parseNodeInventory } from './node-inventory.ts'
import { createLocalMainAdminContext } from './installation-context.ts'

const node = {
  nodeId: 'fixture-main', displayName: 'Main', role: 'main', connection: 'connected', executionProtocol: 'compatible',
  workdirs: [{ version: 2, nodeId: 'fixture-main', workdirId: 'source', displayName: 'Source', online: true, displayPath: 'C:\\synthetic\\source', support: { operations: ['filesystem.read','filesystem.write'], shell: { shells: ['sh'], maxInputBytes: 1024 } } }],
  support: { operations: ['process.execute'] },
}
const inventory = () => ({ version: 1, nodes: [structuredClone(node)] })

test('inventory exposes directories and inline support, never independent capabilities or permission', () => {
  assert.deepEqual(parseNodeInventory(inventory()), inventory())
  assert.deepEqual(parseNodeInventory({ version: 1, nodes: [] }), { version: 1, nodes: [] })
  const result = parseNodeInventory({ version: 1, nodes: [{ ...node, credentialId: 'private', implementationVersion: '1.0', lastSeen: '2026-09-11T01:00:00.000Z' }] })
  assert.equal(result.nodes[0].implementationVersion, '1.0')
  assert.equal('credentialId' in result.nodes[0], false)
  assert.equal('capabilities' in result.nodes[0], false)
  assert.equal(parseNodeInventory({ version: 1, nodes: [{ ...node, supportsManagedSessions: true }] }).nodes[0].supportsManagedSessions, true)
})

test('browser context does not invent device identity or latency measurements', () => {
  const context = createLocalMainAdminContext('http://localhost')
  assert.equal(context.localNodeId, 'local')
  assert.equal(context.mainLatencyMs, null)
})

test('invalid, mixed, duplicate or unknown inventory fails without an empty successful fallback', () => {
  for (const value of [null, {}, { version: 2, nodes: [] }, { version: 1, nodes: null }]) assert.throws(() => parseNodeInventory(value), /invalid device data/)
  for (const patch of [
    { nodeId: '' }, { role: 'other' }, { connection: 'online' }, { support: null }, { executionProtocol: 'automatic' },
    { lastSeen: 'yesterday' }, { implementationVersion: 12 }, { supportsManagedSessions: 'true' },
    { workdirs: [{ ...node.workdirs[0], kind: 'gpu' }] },
    { workdirs: [{ ...node.workdirs[0], nodeId: 'other' }] },
    { workdirs: [{ ...node.workdirs[0], displayPath: 12 }] },
    { workdirs: [node.workdirs[0], node.workdirs[0]] },
    { support: { operations: ['browser.magic'] } },
    { support: { operations: ['filesystem.read'] } },
    { support: { operations: ['process.execute'], shell: { shells: ['sh'], maxDeadlineMs: -1 } } },
    { support: { operations: ['process.execute'], sandbox: true } },
    { capabilities: [] }, { resources: [] },
  ]) assert.throws(() => parseNodeInventory({ version: 1, nodes: [{ ...node, ...patch }] }), /invalid device data/)
  assert.throws(() => parseNodeInventory({ version: 1, nodes: [node, node] }), /invalid device data/)
})

test('old inventories require upgrade rather than treating retired identifiers as live directories', () => {
  for (const patch of [{ executionProtocol: undefined }, { workdirs: undefined }]) assert.throws(() => parseNodeInventory({ version: 1, nodes: [{ ...node, ...patch }] }), /Update Main and the device/)
  assert.throws(() => parseNodeInventory({ version: 1, nodes: [{ ...node, capabilities: [{ version: 1, capabilityId: 'source', kind: 'workdir', online: true }] }] }), /invalid device data/)
})

test('directory availability requires the exact online binding and compatible connected device', () => {
  const parsed = parseNodeInventory(inventory()).nodes[0]
  assert.equal(workdirAvailability(parsed, parsed.workdirs[0]), 'online')
  assert.equal(workdirSupportsOperations(parsed, 'source'), true)
  for (const [connection, state] of [['offline', 'unavailable'], ['revoked', 'revoked']] as const) assert.equal(workdirAvailability({ ...parsed, connection }, parsed.workdirs[0]), state)
  assert.equal(workdirAvailability(parsed, { ...parsed.workdirs[0], online: false }), 'unavailable')
  assert.equal(workdirSupportsOperations({ ...parsed, workdirs: [] }, 'source'), false)
  assert.equal(workdirAvailability(parsed, { ...parsed.workdirs[0], nodeId: 'other-device' }), 'unavailable')
  assert.equal(workdirAvailability({ ...parsed, executionProtocol: 'upgrade-required' }, parsed.workdirs[0]), 'unavailable')
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

test('an offline peer has unknown compatibility, not evidence that an upgrade is required', () => {
  const parsed = parseNodeInventory({ version: 1, nodes: [{ ...node, connection: 'offline', executionProtocol: 'unknown' }] }).nodes[0]
  assert.equal(parsed.executionProtocol, 'unknown')
  assert.equal(workdirAvailability(parsed, parsed.workdirs[0]), 'unavailable')
  assert.equal(workdirSupportsOperations(parsed, 'source'), false)
})
