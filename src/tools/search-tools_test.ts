import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { rm } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { McpConnection } from '../mcp/client.ts'
import { McpToolIndex } from '../mcp/tool-index.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ExecutionContext } from './context.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { Tools, SessionTools } from './registry.ts'
import { requireToolText, type Tool } from './tool.ts'

const schema = {
  type: 'object', properties: { query: { type: 'string', minLength: 1 }, count: { type: 'integer', maximum: 10 } },
  required: ['query'], additionalProperties: false,
}
const config = { name: 'mail', transport: 'stdio' as const, command: 'synthetic-never-run' }
const advertised = [{ name: 'SearchMessages', description: 'Search messages by subject and sender.', inputSchema: schema }]

async function setup(t: TestContext, builtins = new Map<string, LoadableEntry>()) {
  const home = await createTempWorkspace()
  const index = new McpToolIndex(home)
  const importer = new ImportTool(builtins, home, undefined, undefined, index)
  const vfs = new VirtualFs()
  vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, opts) => importer.virtualEntries(ctx, opts))
  const base = new Tools(home)
  base.register(new SearchTool(home, undefined, vfs))
  base.register(new ReadTool(home, vfs))
  base.register(new InvokeTool(importer))
  const tools = new SessionTools(base, home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
  t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
  t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
  const list = t.mock.method(McpConnection.prototype, 'listTools', async () => advertised)
  const call = t.mock.method(McpConnection.prototype, 'callTool', async () => 'success')
  await importer.updateMcpServers([config])
  await index.store(config, advertised)
  t.after(async () => {
    await tools.resetDynamicAndWait()
    await rm(home, { recursive: true, force: true })
  })
  const search = async (args: Record<string, unknown>, ctx = context) =>
    requireToolText(await ctx.tools.execute('search', { space: 'grep:v:tools', query: 'subject', ...args }, ctx))
  const read = async (path = 'v:tools/mail/mail__SearchMessages', ctx = context) =>
    requireToolText(await ctx.tools.execute('read', { path }, ctx))
  const invoke = (args: Record<string, unknown>) => tools.execute('invoke_tool', { name: 'mail__SearchMessages', args }, context)
  return { home, index, importer, base, tools, context, connect, list, call, search, read, invoke }
}

test('VFS searches names, descriptions and full schemas; read returns exact contracts without connecting', async t => {
  const f = await setup(t)
  assert.equal(await f.search({ space: 'glob:v:tools/mail', query: '*__*' }), 'v:tools/mail/mail__SearchMessages')
  for (const query of ['subject', '"query"', '"maximum": 10']) {
    assert.match(await f.search({ query }), /v:tools\/mail\/mail__SearchMessages/)
  }
  assert.deepEqual(JSON.parse(await f.read()).parameters, schema)
  assert.equal(JSON.parse(await f.read()).name, 'mail__SearchMessages')
  assert.equal(typeof JSON.parse(await f.read()).indexedAt, 'string')
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
  assert.equal(f.call.mock.callCount(), 0)
  assert.equal(f.tools.activeDynamicTools().length, 0)
  assert.equal(await f.invoke({ query: 'hello' }), 'success')
  assert.equal(f.connect.mock.callCount(), 1)
  assert.equal(f.call.mock.callCount(), 1)
  assert(!f.tools.getDefinitions().some(tool => tool.function.name === 'mail__SearchMessages'))
})

test('indexed tool reads expose readonly review identity offline and refresh from live metadata', async t => {
  const f = await setup(t)
  const initial = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(initial.readOnly, null)
  assert.equal(initial.source, 'unknown')
  assert.match(initial.fingerprint, /^[a-f0-9]{64}$/)
  const trusted = { ...config, trustReadOnlyHints: true }
  const tool = { ...advertised[0], readOnlyHint: true, serverVersion: { name: 'fixture', version: '1' } }
  await f.importer.updateMcpServers([trusted])
  await f.index.store(trusted, [tool])
  const indexed = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(indexed.readOnly, true)
  assert.equal(indexed.source, 'trusted-hint')
  assert.notEqual(indexed.fingerprint, initial.fingerprint)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
  f.list.mock.mockImplementation(async () => [{ ...tool, readOnlyHint: false }])
  assert.equal(await f.invoke({ query: 'read' }), 'success')
  const live = JSON.parse(await f.read()).readOnlyPolicy
  assert.equal(live.readOnly, false)
  assert.equal(live.source, 'trusted-hint')
  assert.notEqual(live.fingerprint, indexed.fingerprint)
})

test('invalid arguments never execute and live schemas replace stale indexed metadata', async t => {
  const f = await setup(t)
  for (const args of [{}, { query: 5 }, { query: '' }, { query: 'test', count: 11 }, { query: 'test', extra: 1 }]) {
    assert.match(requireToolText(await f.invoke(args)), /invalid arguments/)
  }
  assert.equal(f.call.mock.callCount(), 0)
  f.tools.resetDynamic()
  const current = { type: 'object', properties: { folder: { type: 'string' } }, required: ['folder'], additionalProperties: false }
  f.list.mock.mockImplementation(async () => [{ ...advertised[0], inputSchema: current }])
  assert.match(requireToolText(await f.invoke({ query: 'old' })), /invalid arguments/)
  assert.deepEqual(JSON.parse(await f.read()).parameters, current)
  assert.equal(await f.invoke({ folder: 'inbox' }), 'success')
  f.tools.resetDynamic()
  f.list.mock.mockImplementation(async () => [])
  assert.match(requireToolText(await f.invoke({ folder: 'inbox' })), /not advertised/)
  assert.equal(await f.search({ space: 'glob:v:tools/mail', query: '*__*' }), 'No files found')
})

test('uninitialized factories stay deferred, static contracts work, and warnings survive no-match queries', async t => {
  let factories = 0
  const tool: Tool = { name: 'fixture', description: 'Static capability', parameters: { type: 'object', properties: {} }, execute: async () => 'unused' }
  const f = await setup(t, new Map<string, LoadableEntry>([
    ['group', { contracts: [tool], factory: async () => { factories++; return tool } }],
    ['deferred', { factory: async () => { factories++; return tool } }],
  ]))
  assert.match(await f.search({ query: 'Static capability' }), /v:tools\/group\/fixture/)
  const missing = await f.search({ query: 'never matches' })
  assert.match(missing, /No matches found/)
  assert.match(missing, /Warning: v:tools\/deferred:.*does not initialize/)
  assert.match(await f.search({ space: 'grep:v:tools/deferred/unknown', query: 'never' }), /Warning:/)
  assert.equal(factories, 0)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('missing or malformed MCP indexes report incomplete coverage without fallback connections', async t => {
  const f = await setup(t)
  await f.importer.updateMcpServers([config, { name: 'missing', transport: 'stdio', command: 'never' }])
  assert.match(await f.search({ query: 'no matches' }), /Warning: v:tools\/missing:.*not indexed/)
  t.mock.method(f.index, 'read', async () => { throw new Error('Malformed tool index') })
  assert.match(await f.search({ space: 'grep:v:tools/mail', query: 'nothing' }), /Warning:.*Malformed tool index/)
  assert.equal(f.connect.mock.callCount(), 0)
  assert.equal(f.list.mock.callCount(), 0)
})

test('VFS tool listing is deterministic and paginated; encoded tool names round-trip through read', async t => {
  const f = await setup(t)
  await f.index.store(config, ['a', 'b', 'slash/name%', 'z'].map(name => ({ ...advertised[0], name })))
  const first = await f.search({ space: 'glob:v:tools/mail', query: '*__*', limit: 2 })
  assert.equal(first, 'v:tools/mail/mail__a\nv:tools/mail/mail__b\n(Showing 2 of 4 results; continue with offset: 2.)')
  const last = await f.search({ space: 'glob:v:tools/mail', query: '*__*', limit: 2, offset: 2 })
  assert.equal(last, 'v:tools/mail/mail__slash%2Fname%25\nv:tools/mail/mail__z')
  assert.equal(JSON.parse(await f.read('v:tools/mail/mail__slash%2Fname%25')).name, 'mail__slash/name%')
  assert.equal(f.connect.mock.callCount(), 0)
})

test('complete schema reads are not truncated and virtual grep retains coverage warnings', async t => {
  const f = await setup(t)
  const description = 'Detailed metadata. '.repeat(1000)
  await f.index.store(config, [{ ...advertised[0], description }])
  assert.equal(JSON.parse(await f.read()).description, `[MCP:mail] ${description}`)
  assert.doesNotMatch(await f.read(), /\[truncated:/)
})

test('role and remote-workdir restrictions apply equally to virtual grep, glob and contract reads', async t => {
  const f = await setup(t)
  const restricted = new SessionTools(f.base, f.home, ['search', 'read'])
  const ctx = { ...f.context, tools: restricted }
  assert.match(await f.search({}, ctx), /not available/)
  assert.match(await f.read(undefined, ctx), /not available/)
  const hidden = new SessionTools(f.base, f.home, undefined, ['mail__SearchMessages'])
  assert.equal(await f.search({}, { ...f.context, tools: hidden }), 'No matches found')
  assert.match(await f.read(undefined, { ...f.context, tools: hidden }), /Unknown or unavailable/)
  const remote = { ...f.context, remoteWorkdir: {
    nodeId: 'remote', capabilityId: 'opaque', get executor(): never { throw new Error('Must not use remote executor') },
  } }
  assert.match(await f.search({}, remote), /only v:sessions searches/)
  assert.equal(f.connect.mock.callCount(), 0)
})

test('cancelled virtual index searches wait for pending reads and never connect or register', async t => {
  const f = await setup(t)
  const indexed = await f.index.read(config)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.mock.method(f.index, 'read', async () => { entered.resolve(); await release.promise; return indexed })
  const controller = new AbortController()
  let settled = false
  const pending = f.search({}, { ...f.context, signal: controller.signal }).finally(() => { settled = true })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  controller.abort()
  await setImmediate()
  assert.equal(settled, false)
  release.resolve()
  await rejected
  assert.equal(f.connect.mock.callCount(), 0)
})

test('configuration changes and invalid schema references still fail before execution', async t => {
  const f = await setup(t)
  f.list.mock.mockImplementation(async () => [{ ...advertised[0], inputSchema: { ...schema, $ref: '#/missing' } }])
  assert.match(requireToolText(await f.invoke({ query: 'x' })), /invalid or unsupported input schema/)
  assert.equal(f.call.mock.callCount(), 0)
  f.tools.resetDynamic()
  f.list.mock.mockImplementation(async () => advertised)
  assert.equal(await f.invoke({ query: 'old' }), 'success')
  await f.importer.updateMcpServers([{ ...config, command: 'changed' }])
  assert.match(await f.search({}), /not indexed/)
  assert.equal(await f.invoke({ query: 'new' }), 'success')
  assert.equal(f.call.mock.callCount(), 2)
})
