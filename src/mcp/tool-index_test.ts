import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { McpServerConfig } from '../config/schema.ts'
import { McpConnection, type McpToolInfo } from './client.ts'
import { McpError } from './errors.ts'
import { McpToolIndex } from './tool-index.ts'

const config: McpServerConfig = {
  name: 'fixture',
  transport: 'stdio',
  command: 'not-a-real-executable',
  args: ['--token', 'synthetic-argument-secret'],
  env: { API_TOKEN: 'synthetic-env-secret', Z: 'last', A: 'first' },
  headers: { Authorization: 'Bearer synthetic-header-secret', Z: 'last', A: 'first' },
  description: 'Fixture server',
}
const tools: McpToolInfo[] = [{
  name: 'lookup',
  description: 'Look up a fixture',
  inputSchema: {
    type: 'object',
    properties: { query: { $ref: '#/$defs/query' } },
    required: ['query'],
    $defs: { query: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
}]

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(process.cwd(), '.mcp-tool-index-test-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const connect = t.mock.method(McpConnection.prototype, 'connect', async function (this: McpConnection, signal?: AbortSignal) {
    assert.ok(signal)
    assert.equal(Reflect.get(this, 'cwd'), workspace)
  })
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => structuredClone(tools))
  const disconnect = t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => {
    assert.fail('Indexing must never execute a tool')
  })
  t.after(() => assert.equal(call.mock.callCount(), 0))
  return {
    workspace,
    index: new McpToolIndex(workspace),
    connect, list, disconnect,
    directory: projectStoragePath(workspace, '.mcp-tool-index'),
  }
}

test('cold discovery publishes only after cleanup; reuse and restart are disk-only', async t => {
  const { index, workspace, directory, connect, list, disconnect } = await fixture(t)
  assert.equal(await index.read(config), undefined)
  assert.equal(connect.mock.callCount(), 0)
  disconnect.mock.mockImplementation(async () => {
    assert.equal(await index.read(config), undefined)
  })

  await index.ensure(config)
  const record = await index.read(config)
  assert.deepEqual(record?.tools, tools)
  assert.equal(new Date(record!.indexedAt).toISOString(), record!.indexedAt)
  record!.tools[0].description = 'mutated caller copy'
  await index.ensure(config)
  const restarted = new McpToolIndex(workspace)
  assert.deepEqual((await restarted.read(config))?.tools, tools)
  await restarted.ensure(config)
  assert.equal(connect.mock.callCount(), 1)
  assert.equal(list.mock.callCount(), 1)
  assert.equal(disconnect.mock.callCount(), 1)
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  assert.match(files[0], /^[a-f0-9]{64}\.json$/)
  const path = join(directory, files[0])
  const serialized = await readFile(path, 'utf8')
  const persisted = JSON.parse(serialized)
  assert.equal(persisted.version, 1)
  assert.equal(persisted.fingerprint, files[0].slice(0, -5))
  assert.deepEqual(Object.keys(persisted).sort(), ['fingerprint', 'indexedAt', 'tools', 'version'])
  for (const secret of ['synthetic-argument-secret', 'synthetic-env-secret', 'synthetic-header-secret', config.command!]) {
    assert.ok(!serialized.includes(secret))
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
  }
})

test('tool indexes roundtrip readonly metadata and accept old records without granting trust', async t => {
  const { index, workspace } = await fixture(t)
  const metadata = [true, false, undefined].map((readOnlyHint, i) => ({
    ...tools[0], name: `tool${i}`, ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    serverVersion: { name: 'fixture', version: '1' },
  }))
  await index.store(config, metadata)
  assert.deepEqual((await new McpToolIndex(workspace).read(config))?.tools, metadata)
  await index.store(config, tools)
  assert.equal((await index.read(config))?.tools[0].readOnlyHint, undefined)
  // Deliberately malformed wire data exercises runtime validation.
  await assert.rejects(index.store(config, [{ ...tools[0], readOnlyHint: 'true' } as unknown as McpToolInfo]), /readOnlyHint/)
  await assert.rejects(index.store(config, [{ ...tools[0], serverVersion: { version: 1 } } as unknown as McpToolInfo]), /serverVersion/)
})

test('all normalized config fields bind identity; object key order does not', async t => {
  const { index, directory, connect } = await fixture(t)
  await index.ensure(config)
  const reordered = Object.fromEntries(Object.entries(config).reverse()) as unknown as McpServerConfig
  reordered.env = Object.fromEntries(Object.entries(config.env!).reverse())
  reordered.headers = Object.fromEntries(Object.entries(config.headers!).reverse())
  await index.ensure(reordered)
  assert.equal(connect.mock.callCount(), 1)
  const variants: McpServerConfig[] = [
    { ...config, name: 'other' },
    { ...config, command: 'different-executable' },
    { ...config, args: ['--token', 'new-argument-secret'] },
    { ...config, args: [...config.args!].reverse() },
    { ...config, env: { ...config.env, API_TOKEN: 'new-env-secret' } },
    { ...config, env: { ...config.env, A: 'changed' } },
    { ...config, headers: { ...config.headers, Authorization: 'Bearer new-header-secret' } },
    { ...config, description: 'Changed description' },
    { ...config, url: 'https://example.invalid/mcp?token=synthetic-query-secret' },
    { ...config, transport: 'sse', url: 'https://example.invalid/mcp' },
    { ...config, transport: 'streamable-http', url: 'https://example.invalid/mcp' },
    { ...config, env: {} },
  ]
  for (const variant of variants) {
    assert.equal(await index.read(variant), undefined)
    await index.ensure(variant)
    assert.deepEqual((await index.read(config))?.tools, tools)
  }
  assert.equal(connect.mock.callCount(), variants.length + 1)
  assert.equal((await readdir(directory)).length, variants.length + 1)
  const implicit = { ...config, transport: undefined } as unknown as McpServerConfig
  await index.ensure(implicit)
  assert.equal(connect.mock.callCount(), variants.length + 1)
})

for (const phase of ['connect', 'list', 'disconnect'] as const) {
  test(`${phase} failure cleans up and preserves prior configuration record`, async t => {
    const f = await fixture(t)
    await f.index.store(config, tools)
    const previous = await f.index.read(config)
    const changed = { ...config, description: 'New configuration' }
    f[phase].mock.mockImplementation(async () => {
      throw new Error('Failure synthetic-env-secret synthetic-header-secret synthetic-argument-secret')
    })
    await assert.rejects(f.index.ensure(changed), error => {
      assert.ok(error instanceof McpError)
      assert.equal(error.diagnostic.phase, phase === 'list' ? 'list_tools' : phase)
      assert.ok(!error.message.includes('synthetic-'))
      return true
    })
    assert.equal(f.disconnect.mock.callCount(), 1)
    assert.equal(f.list.mock.callCount(), phase === 'connect' ? 0 : 1)
    assert.equal(await f.index.read(changed), undefined)
    assert.deepEqual(await f.index.read(config), previous)
    assert.equal((await readdir(f.directory)).length, 1)
  })
}

test('discovery and cleanup failures retain both sanitized diagnostic phases', async t => {
  const { index, list, disconnect } = await fixture(t)
  list.mock.mockImplementation(async () => { throw new Error('list synthetic-env-secret') })
  disconnect.mock.mockImplementation(async () => { throw new Error('cleanup synthetic-header-secret') })
  await assert.rejects(index.ensure(config), error => {
    assert.ok(error instanceof McpError)
    assert.equal(error.diagnostic.phase, 'list_tools')
    assert.equal(error.diagnostic.cleanupFailure?.phase, 'disconnect')
    assert.ok(!error.message.includes('synthetic-'))
    return true
  })
  assert.equal(await index.read(config), undefined)
})

for (const phase of ['connect', 'list'] as const) {
  test(`abort during ${phase} cleans up even if RPC ignores cancellation`, async t => {
    const f = await fixture(t)
    const controller = new AbortController()
    let started!: () => void
    const starting = new Promise<void>(resolve => { started = resolve })
    f[phase].mock.mockImplementation(async () => {
      started()
      return await new Promise<never>(() => {})
    })
    const pending = f.index.ensure(config, controller.signal)
    await starting
    controller.abort(new Error('cancel synthetic-env-secret'))
    await assert.rejects(pending, error => {
      assert.ok(error instanceof McpError)
      assert.ok(!error.message.includes('synthetic-env-secret'))
      return true
    })
    assert.equal(f.disconnect.mock.callCount(), 1)
    assert.equal(await f.index.read(config), undefined)
  })
}

test('discovery has a shared 60 second deadline and cleans up a stalled list', async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started!: () => void
  const starting = new Promise<void>(resolve => { started = resolve })
  f.connect.mock.mockImplementation(async () => { t.mock.timers.tick(30_000) })
  f.list.mock.mockImplementation(async () => {
    started()
    return await new Promise<never>(() => {})
  })
  const pending = f.index.ensure(config)
  await starting
  t.mock.timers.tick(30_000)
  await assert.rejects(pending, error => {
    assert.ok(error instanceof McpError)
    assert.equal(error.diagnostic.category, 'timeout')
    return true
  })
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.equal(await f.index.read(config), undefined)
})

test('pre-abort avoids RPC and writes; abort during cleanup prevents publication', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.index.ensure(config, controller.signal))
  await assert.rejects(f.index.store(config, tools, controller.signal))
  assert.equal(f.connect.mock.callCount(), 0)
  const duringCleanup = new AbortController()
  f.disconnect.mock.mockImplementation(async () => { duringCleanup.abort() })
  await assert.rejects(f.index.ensure(config, duringCleanup.signal))
  assert.equal(f.disconnect.mock.callCount(), 1)
  assert.equal(await f.index.read(config), undefined)
})

const malformedTools: unknown[] = [
  null, {}, [null], [{}],
  [{ ...tools[0], name: '' }],
  [{ ...tools[0], description: 1 }],
  [{ ...tools[0], inputSchema: null }],
  [{ ...tools[0], inputSchema: [] }],
  [{ ...tools[0], inputSchema: 'object' }],
  [{ ...tools[0], inputSchema: {} }],
  [{ ...tools[0], inputSchema: { type: 'array' } }],
  [tools[0], tools[0]],
]

test('store rejects malformed tool metadata without replacing valid data', async t => {
  const { index } = await fixture(t)
  await index.store(config, tools)
  const original = await index.read(config)
  const circular: Record<string, unknown> = { type: 'object' }
  circular.self = circular
  for (const malformed of [...malformedTools,
    [{ ...tools[0], inputSchema: circular }],
    [{ ...tools[0], inputSchema: { type: 'object', default: NaN } }],
    [{ ...tools[0], inputSchema: { type: 'object', default: undefined } }],
  ]) {
    await assert.rejects(index.store(config, malformed as McpToolInfo[]), /Invalid MCP tool index/)
    assert.deepEqual(await index.read(config), original)
  }
  await index.store(config, [])
  assert.deepEqual((await index.read(config))?.tools, [])
})

test('malformed discovered metadata fails explicitly after cleanup without publication', async t => {
  const { index, list, disconnect } = await fixture(t)
  for (const malformed of malformedTools) {
    list.mock.mockImplementation(async () => malformed as McpToolInfo[])
    await assert.rejects(index.ensure(config), /Invalid MCP tool index/)
    assert.equal(await index.read(config), undefined)
  }
  assert.equal(disconnect.mock.callCount(), malformedTools.length)
})

test('disk metadata is runtime validated and corruption is never silently rediscovered', async t => {
  const { index, directory, connect } = await fixture(t)
  await index.store(config, tools)
  const path = join(directory, (await readdir(directory))[0])
  const valid = JSON.parse(await readFile(path, 'utf8'))
  const malformed: unknown[] = [
    null, [], {},
    { ...valid, version: 99 },
    { ...valid, fingerprint: 'wrong synthetic-env-secret' },
    { ...valid, indexedAt: 'not a date' },
    { ...valid, indexedAt: '2026-01-01' },
    { ...valid, indexedAt: 1 },
    ...malformedTools.map(value => ({ ...valid, tools: value })),
  ]
  for (const content of [...malformed.map(value => JSON.stringify(value)), '{"synthetic-env-secret":']) {
    await writeFile(path, content)
    await assert.rejects(index.read(config), error => {
      assert.ok(error instanceof McpError)
      assert.match(error.message, /Invalid MCP tool index/)
      assert.ok(!error.message.includes('synthetic-env-secret'))
      return true
    })
    await assert.rejects(index.ensure(config), /Invalid MCP tool index/)
  }
  assert.equal(connect.mock.callCount(), 0)
})
